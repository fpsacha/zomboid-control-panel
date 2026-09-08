import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// scheduler-time-audit follow-up (06f07d66 landed the server half: POST
// /tasks and PUT /tasks/:id now return a non-null dstWarning whenever the
// saved schedule is sub-hourly in a DST-observing zone -- see that commit's
// message for node-cron's own documented fall-back gap). This proves the
// client half: the dialog surfaces the warning near the schedule it
// applies to, keeps the task's own save-succeeded feedback intact, and
// does not change behavior at all when dstWarning is absent.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
      createTask: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getTasks = vi.mocked(schedulerApi.getTasks)
const getCronPresets = vi.mocked(schedulerApi.getCronPresets)
const getStatus = vi.mocked(schedulerApi.getStatus)
const getHistory = vi.mocked(schedulerApi.getHistory)
const createTask = vi.mocked(schedulerApi.createTask)
const serversGetAll = vi.mocked(serversApi.getAll)
const serverGetStatus = vi.mocked(serverApi.getStatus)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderScheduler() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function baseMocks() {
  getTasks.mockResolvedValue({ tasks: [] })
  getCronPresets.mockResolvedValue({ presets: [] })
  getHistory.mockResolvedValue({ history: [] })
  getStatus.mockResolvedValue({
    activeTasks: 0,
    autoRestartEnabled: false,
    modUpdateRestartPending: false,
    timezone: 'America/New_York',
    configuredTimezone: 'America/New_York',
    timezoneFallback: null,
  })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

// simpleMode defaults (daily at 06:00) already produce a cron the Save flow
// accepts, so only name + command need filling to reach the API call.
async function fillMinimalTaskAndSave() {
  fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByPlaceholderText('e.g., Daily Restart'), { target: { value: 'Nightly job' } })
  fireEvent.change(within(dialog).getByPlaceholderText('Or enter custom command'), { target: { value: 'restart' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))
  return dialog
}

const DST_WARNING_TEXT =
  'Schedule fires roughly every 15 minute(s); during America/New_York\'s daylight-saving fall-back ' +
  'each year, one occurrence in the repeated hour will be silently skipped -- this is a limitation of ' +
  'the underlying scheduler (node-cron), not a bug in the panel.'

describe('Scheduler.tsx: dstWarning from a task save (scheduler-time-audit)', () => {
  it('shows the warning inline and keeps the dialog open when the response carries one, without losing the save-succeeded toast', async () => {
    await baseMocks()
    createTask.mockResolvedValue({ success: true, task: { id: 1 }, dstWarning: DST_WARNING_TEXT })

    renderScheduler()
    const dialog = await fillMinimalTaskAndSave()

    await waitFor(() => expect(createTask).toHaveBeenCalled())
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' })),
    )

    // Dialog stayed open -- the whole point is the warning is read next to
    // the schedule that triggered it, not lost behind an auto-close.
    expect(await within(dialog).findByText(DST_WARNING_TEXT)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes the dialog normally, with no warning shown, when the response carries no dstWarning', async () => {
    await baseMocks()
    createTask.mockResolvedValue({ success: true, task: { id: 2 }, dstWarning: null })

    renderScheduler()
    await fillMinimalTaskAndSave()

    await waitFor(() => expect(createTask).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('the dismiss button closes the dialog and clears the warning for the next open', async () => {
    await baseMocks()
    createTask.mockResolvedValue({ success: true, task: { id: 3 }, dstWarning: DST_WARNING_TEXT })

    renderScheduler()
    const dialog = await fillMinimalTaskAndSave()
    await within(dialog).findByText(DST_WARNING_TEXT)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Reopening (a fresh New Task) must not show the stale warning from the
    // previous save.
    fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
    const reopened = await screen.findByRole('dialog')
    expect(within(reopened).queryByText(DST_WARNING_TEXT)).not.toBeInTheDocument()
  })
})
