import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'

// bug-hunt-2026-09-06 (client silent-failure lane, dispatched after tonight's
// server uploadStream crash): Backups.serverInProgressSync.test.tsx covers
// fetchBackupStatus correctly detecting an externally-started backup at
// mount and disabling Create/Restore. But nothing besides the
// 'backup:progress' socket event ever cleared creatingBackup back to false
// on THAT path -- if the backup that was already running elsewhere finished
// (or failed) without this session ever hearing its socket event, Create/
// Restore stayed disabled indefinitely with zero error shown. This is the
// same "nobody's listening for the terminal event" class as the server's
// uploadStream crash, manifesting here as a silently-stuck button instead of
// a crash.
//
// This test proves the fix: a 10s watchdog independently re-polls the real
// backupInProgress server state and self-corrects -- it does not just show
// a warning, because the ground truth here is cheaply pollable (unlike the
// SteamCMD child-process case in Servers.steamStallRecovery.test.tsx, where
// no such endpoint exists).

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      getHistory: vi.fn(),
      createBackup: vi.fn(),
      restoreBackup: vi.fn(),
      downloadBackup: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const createBackup = vi.mocked(backupApi.createBackup)

const baseStatus: BackupStatus = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: true,
  backupInProgress: false,
  restoreInProgress: false,
  lastBackup: null,
  backupCount: 1,
  savesPath: '/saves',
  backupsPath: '/backups',
  savesExists: true,
}

const testBackup: ServerBackupArchive = {
  name: 'backup-2026-09-06T00-00-00',
  path: '/backups/backup-2026-09-06T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-09-06T00:00:00.000Z',
}

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Backups.tsx: an externally-detected in-progress backup self-corrects if backup:progress never arrives', () => {
  it('re-enables Create Backup once the real server state clears, without waiting on the socket', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    // Detected running at mount -- the exact case Backups.serverInProgressSync
    // proves disables the button. This test picks up from there.
    getStatus.mockResolvedValue({ ...baseStatus, backupInProgress: true })
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    // shouldAdvanceTime keeps waitFor/findBy usable (they poll via
    // setTimeout) while still letting advanceTimersByTimeAsync jump the
    // clock forward -- installed before render, since creatingBackup (and
    // the watchdog's setInterval) is set from the very first mount fetch.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderBackups()

      const createButton = await screen.findByRole('button', { name: /creating/i })
      expect(createButton).toBeDisabled()

      // The backup that was running elsewhere has since finished (or
      // failed) -- but this session's socket never heard about it. Only the
      // watchdog's own poll can find out.
      getStatus.mockResolvedValue({ ...baseStatus, backupInProgress: false })

      await vi.advanceTimersByTimeAsync(10_000)

      await waitFor(() => expect(screen.getByRole('button', { name: /create backup/i })).not.toBeDisabled())
    } finally {
      vi.useRealTimers()
    }
  })

  it('never touches this session\'s own in-flight create -- the watchdog only runs for the externally-detected path', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(baseStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })
    // This session's own create() call never resolves during the test --
    // stands in for a real, still-running backup THIS tab started.
    createBackup.mockReturnValue(new Promise(() => {}))

    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderBackups()
      const createButton = await screen.findByRole('button', { name: /create backup/i })
      expect(createButton).not.toBeDisabled()

      fireEvent.click(createButton)
      await waitFor(() => expect(createBackup).toHaveBeenCalledTimes(1))

      // If the externally-detected watchdog mistakenly ran here too, a
      // getStatus() poll reporting backupInProgress:false (server hasn't
      // even recorded this brand-new backup yet) would wrongly re-enable
      // Create while this tab's own request is still genuinely in flight.
      getStatus.mockResolvedValue({ ...baseStatus, backupInProgress: false })
      await vi.advanceTimersByTimeAsync(15_000)

      expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled()
    } finally {
      vi.useRealTimers()
    }
  })
})
