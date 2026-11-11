import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus } from '@/lib/api'

// UX restructure (slice C): "Schedule & retention" is the one card that
// holds the schedule, the limit and the on/off switch. ?panel=schedule opens
// it (the Scheduler's and the Dashboard's backup links land there) and
// scrolls it into view; its one Save is the page's sticky save bar, shown
// only while the form differs from what is saved.

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

const status: BackupStatus = {
  enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
  backupInProgress: false, restoreInProgress: false, lastBackup: null,
  backupCount: 0, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
  lastScheduledBackupAttempt: null, restartOverlaps: [], backupDeferredSince: null,
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TooltipProvider>
        <Backups />
        <LocationProbe />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const scrollIntoView = vi.fn()

beforeEach(() => {
  auth.can = () => true
  getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Tavern' } as never })
  getStatus.mockResolvedValue(status)
  listBackups.mockResolvedValue({ backups: [] })
  getHistory.mockResolvedValue({ records: [] })
  updateSettings.mockResolvedValue({ success: true, settings: status })
  validateSchedule.mockResolvedValue({ valid: true, nextRun: '2026-09-28T06:00:00.000Z', timezone: 'UTC', restartOverlaps: [] })
  Element.prototype.scrollIntoView = scrollIntoView
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('Backups.tsx: ?panel=schedule', () => {
  it('opens "Schedule & retention" with the switch in it, and scrolls it into view', async () => {
    renderAt('/backups?panel=schedule')

    const card = await screen.findByRole('region', { name: 'Schedule & retention' })
    expect(screen.getByRole('switch', { name: 'Toggle scheduled backups' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Schedule & retention' })).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(scrollIntoView.mock.contexts[0]).toBe(card)
  })

  it('stays closed without it; the header button opens and closes it in the URL, keeping other parameters', async () => {
    renderAt('/backups?server=2')

    const toggle = await screen.findByRole('button', { name: 'Schedule & retention' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('switch', { name: 'Toggle scheduled backups' })).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(await screen.findByRole('switch', { name: 'Toggle scheduled backups' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('?server=2&panel=schedule')

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Toggle scheduled backups' })).not.toBeInTheDocument())
    expect(screen.getByTestId('location')).toHaveTextContent(/^\?server=2$/)
  })
})

describe('Backups.tsx: the schedule card saves through the save bar', () => {
  it('shows Save only while the form differs from what is saved; Discard puts it back', async () => {
    renderAt('/backups?panel=schedule')
    const maxBackups = await screen.findByLabelText('Maximum Backups to Keep')
    await waitFor(() => expect(maxBackups).toHaveValue(10))
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument()

    fireEvent.change(maxBackups, { target: { value: '12' } })
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument())
    expect(maxBackups).toHaveValue(10)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('saves the edited limit with the active server id', async () => {
    renderAt('/backups?panel=schedule')
    const maxBackups = await screen.findByLabelText('Maximum Backups to Keep')
    await waitFor(() => expect(maxBackups).toHaveValue(10))

    fireEvent.change(maxBackups, { target: { value: '12' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save Settings' }))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '0 */6 * * *', maxBackups: 12, includeDb: true, onlyWhenOnline: false }, 1),
    )
  })

  it('keeps Save disabled, and says why, while the limit is out of range', async () => {
    renderAt('/backups?panel=schedule')
    const maxBackups = await screen.findByLabelText('Maximum Backups to Keep')
    await waitFor(() => expect(maxBackups).toHaveValue(10))

    fireEvent.change(maxBackups, { target: { value: '0' } })
    const save = await screen.findByRole('button', { name: 'Save Settings' })
    expect(save).toBeDisabled()
    expect(maxBackups).toHaveAttribute('aria-invalid', 'true')
    fireEvent.click(save)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('locks the form for a role without backups.manage, so it never holds edits it could not save', async () => {
    auth.can = (capability) => capability !== 'backups.manage'
    renderAt('/backups?panel=schedule')

    const maxBackups = await screen.findByLabelText('Maximum Backups to Keep')
    expect(maxBackups).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Toggle scheduled backups' })).toBeDisabled()
    expect(screen.getAllByText(/requires the backups\.manage permission/).length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: 'Include panel database (without passwords)' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument()
  })
})

// Up to v1.4.17 the Dashboard's and Diagnostics' backups put the panel
// database in the archive. Since then only the backupIncludeDb setting
// decides (a redacted copy), it starts off on an upgraded install, and no
// page could turn it on. It now sits in this card and saves with it.
describe('Backups.tsx: "Include panel database" in the schedule card', () => {
  it('shows the saved choice, marks a change unsaved, and saves it with the rest', async () => {
    getStatus.mockResolvedValue({ ...status, includeDb: false })
    renderAt('/backups?panel=schedule')
    const includeDb = await screen.findByRole('switch', { name: 'Include panel database (without passwords)' })
    await waitFor(() => expect(includeDb).toBeEnabled())
    expect(includeDb).not.toBeChecked()
    expect(includeDb).toHaveAccessibleDescription(/passwords, sessions and other secrets left out/)
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()

    fireEvent.click(includeDb)
    expect(includeDb).toBeChecked()
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    updateSettings.mockResolvedValue({ success: true, settings: { ...status, includeDb: true } })
    getStatus.mockResolvedValue({ ...status, includeDb: true })
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true, onlyWhenOnline: false }, 1),
    )
    // Saved: the bar goes away and the switch keeps the saved value.
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument())
    expect(includeDb).toBeChecked()
  })

  it('Discard puts the saved choice back', async () => {
    renderAt('/backups?panel=schedule')
    const includeDb = await screen.findByRole('switch', { name: 'Include panel database (without passwords)' })
    await waitFor(() => expect(includeDb).toBeChecked())

    fireEvent.click(includeDb)
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument())
    expect(includeDb).toBeChecked()
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

// Scheduled backups can skip a server that is stopped (backupOnlyWhenOnline);
// the switch saves with the rest of the card.
describe('Backups.tsx: "Only back up while the server is running" in the schedule card', () => {
  it('shows the saved choice and saves a change with the rest', async () => {
    getStatus.mockResolvedValue({ ...status, onlyWhenOnline: false })
    renderAt('/backups?panel=schedule')
    const onlyWhenOnline = await screen.findByRole('switch', { name: 'Only back up while the server is running' })
    await waitFor(() => expect(onlyWhenOnline).toBeEnabled())
    expect(onlyWhenOnline).not.toBeChecked()

    fireEvent.click(onlyWhenOnline)
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    updateSettings.mockResolvedValue({ success: true, settings: { ...status, onlyWhenOnline: true } })
    getStatus.mockResolvedValue({ ...status, onlyWhenOnline: true })
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true, onlyWhenOnline: true }, 1),
    )
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument())
    expect(onlyWhenOnline).toBeChecked()
  })
})
