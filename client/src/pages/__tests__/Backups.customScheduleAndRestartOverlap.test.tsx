import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { MemoryRouter } from 'react-router-dom'
import { backupApi, serversApi, type BackupStatus, type BackupScheduleValidation } from '@/lib/api'

// 2026-09-27 community requests (Discord, server "Tavern"):
//
//   - "Custom (cron expression)" on the Backup Frequency picker. The menu only
//     had presets, while Settings > Backups has always taken a raw cron
//     expression for the same saved schedule -- so a custom schedule saved
//     there showed up here as a blank menu and a bare cron string. The option
//     validates live against the server's own rules (POST
//     /backup/validate-schedule, shared with POST /backup/settings), shows the
//     next run in the scheduler's timezone, and describes itself as custom.
//   - The restart collision behind "Scheduled backup failing -- Skipped: a
//     restart was in progress": the page now says when the backup schedule
//     lands inside a scheduled restart, and words an old restart skip as a
//     skip.
//
// Radix <Select> can't be driven by pointer events in jsdom (see
// Chat.capabilityGating.test.tsx) -- swapped for a native <select>, which
// leaves Backups.tsx's own schedule logic untouched.
vi.mock('@/components/ui/select', () => {
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    return (
      <select aria-label="Backup Frequency" value={value} onChange={(e) => onValueChange(e.target.value)}>
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

// Which capabilities the signed-in role has -- everything, unless a test
// narrows it.
const auth = vi.hoisted(() => ({ can: (_capability: string) => true }))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => auth.can(capability),
  }),
}))

// A fake socket the tests can fire events on. Stable across renders: the
// page's socket effects depend on it.
const socketHandlers = vi.hoisted(() => new Map<string, Set<(payload?: unknown) => void>>())
const fakeSocket = vi.hoisted(() => ({
  on: (event: string, handler: (payload?: unknown) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (payload?: unknown) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
}))
vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => fakeSocket }))
const emitSocket = (event: string, payload?: unknown) =>
  act(() => { socketHandlers.get(event)?.forEach((handler) => handler(payload)) })

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
      updateSettings: vi.fn(),
      validateSchedule: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const updateSettings = vi.mocked(backupApi.updateSettings)
const validateSchedule = vi.mocked(backupApi.validateSchedule)

function statusWith(overrides: Partial<BackupStatus>): BackupStatus {
  return {
    enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
    backupInProgress: false, restoreInProgress: false, lastBackup: null,
    backupCount: 0, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
    lastScheduledBackupAttempt: null, restartOverlaps: [], backupDeferredSince: null,
    ...overrides,
  }
}

const VALID: BackupScheduleValidation = {
  valid: true, nextRun: '2026-09-28T03:30:00.000Z', timezone: 'UTC', restartOverlaps: [],
}

function prime(status: BackupStatus) {
  getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Tavern' } as never })
  getStatus.mockResolvedValue(status)
  listBackups.mockResolvedValue({ backups: [] })
  getHistory.mockResolvedValue({ records: [] })
  updateSettings.mockResolvedValue({ success: true, settings: status })
  validateSchedule.mockResolvedValue(VALID)
}

function renderBackups() {
  return render(
    <TooltipProvider>
      <MemoryRouter><Backups /></MemoryRouter>
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  auth.can = () => true
  socketHandlers.clear()
})

describe('Backups.tsx: custom cron schedule', () => {
  it('shows a custom schedule saved elsewhere as "Custom", with its expression, next run and timezone', async () => {
    prime(statusWith({ schedule: '30 3 * * 1-5' }))
    renderBackups()

    // Status card: named as a custom schedule, not a bare cron string.
    expect(await screen.findByText('Runs on a custom schedule (30 3 * * 1-5) · keep 10')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^schedule & retention$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    expect(frequency).toHaveValue('custom')
    expect(screen.getByRole('option', { name: 'Custom (cron expression)' })).toBeInTheDocument()
    expect(screen.getByLabelText('Cron expression')).toHaveValue('30 3 * * 1-5')
    // Left-to-right in every language, so an RTL page can't reverse it --
    // and its placeholder is the bare cron: a translated "e.g." prefix
    // reordered the example around it under dir="ltr" in Arabic.
    expect(screen.getByLabelText('Cron expression')).toHaveAttribute('dir', 'ltr')
    expect(screen.getByLabelText('Cron expression')).toHaveAttribute('placeholder', '30 3 * * *')

    expect(await screen.findByText('Valid schedule')).toBeInTheDocument()
    expect(validateSchedule).toHaveBeenCalledWith('30 3 * * 1-5')
    // Formatted in the scheduler's zone, and labelled with it: every other
    // time on the page is in the browser's zone.
    expect(screen.getByText(/^Next backup: .*UTC$/)).toBeInTheDocument()
    expect(screen.getByText(/Schedule times are in the panel's timezone, UTC/)).toBeInTheDocument()
  })

  it('switching to Custom starts from the current preset; a too-frequent expression shows the reason and is not saved; a valid one is', async () => {
    prime(statusWith({ schedule: '0 */6 * * *' }))
    validateSchedule.mockImplementation(async (schedule: string) =>
      schedule === '*/2 * * * *'
        ? { valid: false, code: 'BACKUP_SCHEDULE_TOO_FREQUENT', error: 'Backups cannot run more often than every 5 minutes' }
        : VALID,
    )
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    expect(frequency).toHaveValue('0 */6 * * *')
    expect(screen.queryByLabelText('Cron expression')).not.toBeInTheDocument()

    fireEvent.change(frequency, { target: { value: 'custom' } })
    const input = await screen.findByLabelText('Cron expression')
    expect(input).toHaveValue('0 */6 * * *')

    fireEvent.change(input, { target: { value: '*/2 * * * *' } })
    // Translated through the errors namespace by its code.
    expect(await screen.findByText('Backups cannot run more often than every 5 minutes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(validateSchedule).toHaveBeenLastCalledWith('*/2 * * * *'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateSettings).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '15 */6 * * *' } })
    expect(await screen.findByText('Valid schedule')).toBeInTheDocument()
    // A double click: the second lands while the pre-check is still in
    // flight, and must not send a second save.
    const save = screen.getByRole('button', { name: /save settings/i })
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '15 */6 * * *', maxBackups: 10, includeDb: true, onlyWhenOnline: false }, 1),
    )
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(updateSettings).toHaveBeenCalledTimes(1)
  })

  it('puts the cron field right under the frequency menu -- before Maximum Backups, in reading and Tab order', async () => {
    // Review finding: it used to render after the whole two-column grid, so
    // on a phone (one column) choosing Custom made it appear below Maximum
    // Backups and its help text, and Tab went to that field first.
    prime(statusWith({ schedule: '30 3 * * 1-5' }))
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    const cron = await screen.findByLabelText('Cron expression')
    const maxBackups = screen.getByLabelText('Maximum Backups to Keep')
    expect(frequency.compareDocumentPosition(cron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cron.compareDocumentPosition(maxBackups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Its verdict too, not just the field.
    const verdict = await screen.findByText('Valid schedule')
    expect(verdict.compareDocumentPosition(maxBackups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('choosing a preset again saves the preset, not the leftover custom text', async () => {
    prime(statusWith({ schedule: '30 3 * * 1-5' }))
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    await waitFor(() => expect(frequency).toHaveValue('custom'))
    fireEvent.change(frequency, { target: { value: '0 */12 * * *' } })
    expect(screen.queryByLabelText('Cron expression')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '0 */12 * * *', maxBackups: 10, includeDb: true, onlyWhenOnline: false }, 1),
    )
  })
})

describe('Backups.tsx: scheduled backups and scheduled restarts', () => {
  const overlap = {
    kind: 'task' as const, name: 'Restart every 4h', cron: '0 */4 * * *', restartTime: '04:00', backupTime: '04:00',
    allBackups: true, windowMinutes: 10,
  }

  it('explains when the saved schedule lands inside a scheduled restart -- as a standing, neutral notice', async () => {
    prime(statusWith({ schedule: '0 */4 * * *', restartOverlaps: [overlap] }))
    renderBackups()

    // Neutral on the main page: those backups are late, not lost, and an
    // operator who backs up right after each restart on purpose can't
    // clear it.
    expect(await screen.findByText('Backups overlap a scheduled restart')).not.toHaveClass('text-warning')
    // The reported setup: every backup collides, and the notice says so
    // rather than naming one time as if it were the only one.
    expect(screen.getByText(
      'Every scheduled backup lands inside the scheduled restart "Restart every 4h" (for example, the 04:00 backup, during the 04:00 restart).',
    )).toBeInTheDocument()
    expect(screen.getByText(/wait for the restart to finish, so they run up to about 10 min late/)).toBeInTheDocument()
    expect(screen.getByText(
      /schedule backups at least 10 min after a restart's scheduled time \(for example, with restarts on the hour, back up at :30\)\./,
    )).toBeInTheDocument()
  })

  it('says "some" when only part of the schedule collides, and words a restart it may not name without one', async () => {
    prime(statusWith({
      schedule: '0 */6 * * *',
      // What a role without automation.manage receives (server/routes/backup.js).
      restartOverlaps: [{ ...overlap, name: null, cron: null, allBackups: false, restartTime: '00:00', backupTime: '00:00' }],
    }))
    renderBackups()

    expect(await screen.findByText(
      'Some scheduled backups land inside a scheduled restart (for example, the 00:00 backup, during the 00:00 restart).',
    )).toBeInTheDocument()
  })

  it('warns in the settings panel for the schedule being chosen, before it is saved', async () => {
    prime(statusWith({ schedule: '30 */4 * * *' }))
    validateSchedule.mockImplementation(async (schedule: string) =>
      schedule === '0 */4 * * *' ? { ...VALID, restartOverlaps: [overlap] } : VALID,
    )
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    await waitFor(() => expect(frequency).toHaveValue('custom'))
    expect(screen.queryByText('Backups overlap a scheduled restart')).not.toBeInTheDocument()

    fireEvent.change(frequency, { target: { value: '0 */4 * * *' } })
    // A warning here, where the times are being chosen.
    expect(await screen.findByText('Backups overlap a scheduled restart')).toHaveClass('text-warning')
  })

  it('with scheduled backups Off, the panel promises no next backup and warns about no overlap -- it says the schedule waits for the switch', async () => {
    // Review finding: under an Auto-Backup card reading "Off · No scheduled
    // backups", the panel still said "Next backup: <date>" and "Every
    // scheduled backup lands inside..." -- neither true while nothing runs.
    prime(statusWith({ enabled: false, schedule: '0 */4 * * *' }))
    validateSchedule.mockResolvedValue({ ...VALID, restartOverlaps: [overlap] })
    renderBackups()
    expect(await screen.findByText('No scheduled backups')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^schedule & retention$/i }))
    expect(await screen.findByText(
      'Scheduled backups are off — this schedule takes effect once you turn them on.',
    )).toBeInTheDocument()
    // The check did run -- a custom expression can still be edited and
    // saved while they're off -- its answer just isn't worded as a promise.
    expect(validateSchedule).toHaveBeenCalledWith('0 */4 * * *')
    expect(screen.queryByText(/^Next backup:/)).not.toBeInTheDocument()
    expect(screen.queryByText('Backups overlap a scheduled restart')).not.toBeInTheDocument()
    expect(screen.getByText(/Schedule times are in the panel's timezone, UTC/)).toBeInTheDocument()
    cleanup()

    // Positive control: the same answer with scheduled backups on.
    prime(statusWith({ enabled: true, schedule: '0 */4 * * *' }))
    validateSchedule.mockResolvedValue({ ...VALID, restartOverlaps: [overlap] })
    renderBackups()
    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    expect(await screen.findByText(/^Next backup:/)).toBeInTheDocument()
    expect(await screen.findByText('Backups overlap a scheduled restart')).toBeInTheDocument()
    expect(screen.queryByText(/Scheduled backups are off/)).not.toBeInTheDocument()
  })

  it('names the timezone of the overlap times -- once, wherever the notice is', async () => {
    // Review finding: "the 04:00 backup" is in the scheduler's zone, every
    // other time on this page in the browser's.
    const zoned = { ...overlap, timezone: 'UTC' }
    prime(statusWith({ schedule: '0 */4 * * *', restartOverlaps: [zoned] }))
    validateSchedule.mockResolvedValue({ ...VALID, restartOverlaps: [zoned] })
    renderBackups()

    // The standing notice on the page says it itself...
    expect(await screen.findByText('Backups overlap a scheduled restart')).toBeInTheDocument()
    expect(screen.getAllByText(/Schedule times are in the panel's timezone, UTC/)).toHaveLength(1)

    // ...and in the settings panel, where the next-run line already names
    // the zone, it doesn't say it a second time.
    fireEvent.click(screen.getByRole('button', { name: /^schedule & retention$/i }))
    await screen.findByText(/^Next backup:/)
    expect(screen.getByText('Backups overlap a scheduled restart')).toBeInTheDocument()
    expect(screen.getAllByText(/Schedule times are in the panel's timezone, UTC/)).toHaveLength(1)
  })

  it('words an old restart skip as a skip, not a failure -- and a backup since then clears it', async () => {
    const skip = {
      success: false, message: 'Skipped: a restart was in progress', executedAt: '2026-09-27T04:00:00.000Z', skipReason: 'restart' as const,
    }
    prime(statusWith({ lastScheduledBackupAttempt: { ...skip, recoveredAt: null } }))
    renderBackups()
    expect(await screen.findByText(/Last scheduled backup skipped for a restart/)).toBeInTheDocument()
    expect(screen.queryByText(/Last scheduled attempt failed/)).not.toBeInTheDocument()
    cleanup()

    prime(statusWith({ lastScheduledBackupAttempt: { ...skip, recoveredAt: '2026-09-27T05:00:00.000Z' } }))
    renderBackups()
    expect(await screen.findByText('Runs every 6 hours · keep 10')).toBeInTheDocument()
    expect(screen.queryByText(/skipped for a restart/)).not.toBeInTheDocument()
  })

  it('shows a backup waiting on a restart right now, in full', async () => {
    prime(statusWith({ backupDeferredSince: '2026-09-27T04:00:00.000Z' }))
    renderBackups()

    const line = await screen.findByText(/waiting for the server restart to finish/)
    // Wraps instead of truncating (the reason is the tail), and carries the
    // whole sentence as a tooltip like the failed-attempt line.
    expect(line).toHaveClass('line-clamp-2')
    expect(line).not.toHaveClass('truncate')
    expect(line).toHaveAttribute('title', line.textContent)
  })

  it('re-checks while a backup waits on a restart, so a stuck restart shows up without a manual refresh -- and leaves form edits alone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'], shouldAdvanceTime: true })
    try {
      prime(statusWith({ backupDeferredSince: '2026-09-27T04:00:00.000Z' }))
      renderBackups()
      expect(await screen.findByText(/waiting for the server restart to finish/)).toBeInTheDocument()

      // An unsaved edit in the settings form meanwhile.
      fireEvent.click(screen.getByRole('button', { name: /^schedule & retention$/i }))
      const maxBackups = await screen.findByLabelText('Maximum Backups to Keep')
      fireEvent.change(maxBackups, { target: { value: '25' } })
      expect(maxBackups).toHaveValue(25)

      // The wait ends as a stuck-restart failure, and the socket event
      // saying so was missed (a dropped connection) -- only the page's own
      // re-check can notice.
      getStatus.mockResolvedValue(statusWith({
        lastScheduledBackupAttempt: {
          success: false,
          message: 'Not run: the server restart had been running for 28 min (5-minute warning) without finishing -- far longer than a restart takes, so it looked stuck, and manual backups were blocked while it lasted.',
          executedAt: '2026-09-27T04:25:00.000Z',
          skipReason: null,
          recoveredAt: null,
        },
      }))
      const callsBefore = getStatus.mock.calls.length
      await vi.advanceTimersByTimeAsync(15000)
      await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(callsBefore))

      expect(await screen.findByText(/Last scheduled attempt failed/)).toBeInTheDocument()
      expect(screen.queryByText(/waiting for the server restart to finish/)).not.toBeInTheDocument()
      // The refetch re-read the same saved maxBackups (10): the typed 25 stays.
      expect(maxBackups).toHaveValue(25)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows "waiting for the restart" as soon as the server says a backup is being held -- no refresh needed', async () => {
    prime(statusWith({}))
    renderBackups()
    expect(await screen.findByText('Runs every 6 hours · keep 10')).toBeInTheDocument()

    // A restart begins with the page open and the next backup tick lands in it.
    getStatus.mockResolvedValue(statusWith({ backupDeferredSince: '2026-09-27T04:00:00.000Z' }))
    emitSocket('backup:deferred', { since: '2026-09-27T04:00:00.000Z' })
    expect(await screen.findByText(/waiting for the server restart to finish/)).toBeInTheDocument()

    // ...and the held run starts once the restart is over.
    getStatus.mockResolvedValue(statusWith({}))
    emitSocket('backup:deferred', { since: null })
    await waitFor(() => expect(screen.queryByText(/waiting for the server restart to finish/)).not.toBeInTheDocument())
  })
})

describe('Backups.tsx: the settings panel preview holds steady while the schedule is edited', () => {
  const overlap = {
    kind: 'task' as const, name: 'Restart every 4h', cron: '0 */4 * * *', restartTime: '00:00', backupTime: '00:00',
    allBackups: true, windowMinutes: 10,
  }
  const TITLE = 'Backups overlap a scheduled restart'

  it("opening the panel keeps the saved schedule's warning on screen -- no gap while the first check runs", async () => {
    prime(statusWith({ schedule: '0 */4 * * *', restartOverlaps: [overlap] }))
    // The first check never answers: whatever shows, shows without it.
    validateSchedule.mockImplementation(() => new Promise(() => {}))
    renderBackups()
    expect(await screen.findByText(TITLE)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^schedule & retention$/i }))
    await screen.findByRole('combobox', { name: 'Backup Frequency' })
    // Same notice, now as the panel's own warning for the schedule it edits.
    expect(screen.getByText(TITLE)).toHaveClass('text-warning')
    expect(screen.getAllByText(TITLE)).toHaveLength(1)
  })

  it('keeps the last verdict mounted, marked stale, while a newer edit is being checked -- then replaces it in place', async () => {
    prime(statusWith({ schedule: '0 */4 * * *', restartOverlaps: [overlap] }))
    const pending = new Map<string, (result: BackupScheduleValidation) => void>()
    validateSchedule.mockImplementation((schedule: string) =>
      schedule === '0 */4 * * *'
        ? Promise.resolve({ ...VALID, restartOverlaps: [overlap] })
        : new Promise((resolve) => { pending.set(schedule, resolve) }),
    )
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    const nextRun = await screen.findByText(/^Next backup:/)
    const notice = screen.getByText(TITLE).closest('[role="status"]')
    // A polite live region, not an assertive alert: it previews an edit.
    expect(notice).not.toBeNull()
    expect(notice).not.toHaveAttribute('aria-busy')

    fireEvent.change(frequency, { target: { value: 'custom' } })
    const input = await screen.findByLabelText('Cron expression')
    fireEvent.change(input, { target: { value: '30 */4 * * *' } })

    // Pending: the same elements stay, dimmed and busy -- nothing collapses.
    expect(screen.getByText(TITLE).closest('[role="status"]')).toBe(notice)
    expect(notice).toHaveAttribute('aria-busy', 'true')
    expect(notice).toHaveClass('opacity-60')
    expect(screen.getByText(/^Next backup:/)).toBe(nextRun)

    await waitFor(() => expect(pending.has('30 */4 * * *')).toBe(true))
    act(() => pending.get('30 */4 * * *')!(VALID))
    // The staggered schedule collides with nothing: the notice goes, and
    // what stays is current again.
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
    expect(screen.getByText('Valid schedule')).not.toHaveAttribute('aria-busy')
    expect(screen.getByText(/^Next backup:/).parentElement).not.toHaveAttribute('aria-busy')
  })

  it('clears the verdict when the custom field is emptied', async () => {
    prime(statusWith({ schedule: '30 3 * * 1-5' }))
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
    expect(await screen.findByText('Valid schedule')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '' } })
    expect(screen.queryByText('Valid schedule')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Next backup:/)).not.toBeInTheDocument()
  })

  // Both roles take the same steps and the same (fake) wait, well past the
  // preview's debounce: the manage-capable one is the control that proves
  // the wait was long enough for the preview to have run, so "never called"
  // for the other one means gated, not merely not-yet.
  it.each([
    ['with', true],
    ['without', false],
  ])("a role %s backups.manage keeps the saved schedule's warning in the panel; only a manager's opening runs the preview", async (_label, canManage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      auth.can = (capability) => canManage || capability !== 'backups.manage'
      prime(statusWith({ schedule: '0 */4 * * *', restartOverlaps: [overlap] }))
      validateSchedule.mockResolvedValue({ ...VALID, restartOverlaps: [overlap] })
      renderBackups()

      fireEvent.click(await screen.findByRole('button', { name: /^schedule & retention$/i }))
      await screen.findByRole('combobox', { name: 'Backup Frequency' })
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })

      if (canManage) {
        expect(validateSchedule).toHaveBeenCalledWith('0 */4 * * *')
      } else {
        expect(validateSchedule).not.toHaveBeenCalled()
      }
      // A manager's from the preview; the other role's from the saved
      // status, since no preview ran for it.
      expect(screen.getByText(TITLE)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
