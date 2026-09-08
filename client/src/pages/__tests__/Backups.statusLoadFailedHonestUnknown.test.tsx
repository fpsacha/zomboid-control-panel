import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'
import en from '../../locales/en/backups.json'
import settingsEn from '../../locales/en/settings.json'

// bug-hunt-2026-09-08 (honest-unknown class, GH#149 siblings sweep): the
// scheduled-backups status card read `backupStatus?.enabled` as a bare
// boolean -- backupStatus is null both before the first fetch resolves AND
// after a fetch fails, so a failed status fetch used to render a confident
// "Off, no scheduled backups" with the toggle switch still clickable,
// inviting an action based on a guess (the exact GH#149 shape: a control
// that lets the operator act on a state the panel never actually confirmed).
// Settings.tsx's own separate scheduled-backups toggle had already solved
// this with a dedicated backupStatusLoadError flag and the
// settings.json backups.statusLoadFailed copy -- this pins the same fix
// landing on Backups.tsx's status card, reusing that exact string rather
// than inventing new copy (asserted against the real en/settings.json file,
// not a hardcoded string, so a future copy edit can't silently desync this
// test from the real UI).

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
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
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)

const testStatus: BackupStatus = {
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
  name: 'backup-2026-08-27T00-00-00',
  path: '/backups/backup-2026-08-27T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-08-27T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

describe('Backups.tsx: scheduled-backups status card distinguishes "unknown" from "off"', () => {
  it('shows the reused statusLoadFailed copy and disables the toggle when the status fetch fails', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockRejectedValue(new Error('network blip'))
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })
    renderBackups()

    expect(await screen.findByText(settingsEn.backups.statusLoadFailed)).toBeInTheDocument()
    // Neither confident label -- the whole point is that "on" and "off" are
    // both claims the panel cannot make from a failed fetch.
    expect(screen.queryByText(en.statusCards.on)).not.toBeInTheDocument()
    expect(screen.queryByText(en.statusCards.off)).not.toBeInTheDocument()

    const toggle = await screen.findByRole('switch', { name: en.statusCards.toggleAria })
    expect(toggle).toBeDisabled()
  })

  it('control: shows the real On/Off state and an enabled toggle once the status fetch succeeds', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(testStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })
    renderBackups()

    expect(await screen.findByText(en.statusCards.on)).toBeInTheDocument()
    expect(screen.queryByText(settingsEn.backups.statusLoadFailed)).not.toBeInTheDocument()

    const toggle = await screen.findByRole('switch', { name: en.statusCards.toggleAria })
    expect(toggle).not.toBeDisabled()
  })
})
