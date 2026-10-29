import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, panelBridgeApi, serversApi } from '@/lib/api'

// pz-bughunt round 19 (client-vs-server permission gate sweep): almost
// nothing on this page had any client-side capability check at all, even
// though every route below is gated server-side. A role missing the
// capability saw every control fully enabled and only found out via a 403
// after clicking. Same fix idiom as Console.tsx's Recheck button this same
// round: const declared once via can('...'), checked in the handler (the
// real gate) AND passed to DisabledReason + disabled= (the affordance).

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
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
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
      reloadCorsDiagnostics: vi.fn(),
      testRcon: vi.fn(),
    },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn(), check: vi.fn(), getApplyLog: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, autoConfigure: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const reloadCorsDiagnostics = vi.mocked(configApi.reloadCorsDiagnostics)
const testRcon = vi.mocked(configApi.testRcon)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const checkForUpdate = vi.mocked(panelUpdateApi.check)
const getApplyLog = vi.mocked(panelUpdateApi.getApplyLog)
const autoConfigure = vi.mocked(panelBridgeApi.autoConfigure)
const getAllServers = vi.mocked(serversApi.getAll)

const baseSettings = {
  panelPort: 8080,
  httpsEnabled: false,
  httpsPort: 8443,
  corsAllowedOrigins: '',
  autoReconnect: false,
}

function primeCommonMocks() {
  getAppSettings.mockResolvedValue({ settings: baseSettings } as never)
  getUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null,
    releaseUrl: null, releaseNotes: null, publishedAt: null, isChecking: false,
    isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  preflight.mockResolvedValue({
    ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
    info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
  } as never)
  getAllServers.mockResolvedValue({ servers: [] } as never)
}

function renderSettings(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings?tab=${tab}`]}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Settings.tsx: General Save is gated on panel.settings', () => {
  it('disables Save and never calls updateAppSettings when the role lacks panel.settings', async () => {
    mockCan = (cap) => cap !== 'panel.settings'
    primeCommonMocks()

    renderSettings('general')
    // Make a real edit first -- Save is ALSO disabled by !isDirty when
    // nothing has changed, which would confound this test (it would stay
    // green even if the capability check were removed entirely). See
    // Dashboard.capabilityGating.test.tsx's own comment on this exact
    // mistake for a wipe-button fixture.
    const portInput = await screen.findByLabelText(/panel port/i)
    fireEvent.change(portInput, { target: { value: '9090' } })

    const saveButtons = await screen.findAllByRole('button', { name: /save/i })
    for (const btn of saveButtons) expect(btn).toBeDisabled()

    fireEvent.click(saveButtons[0])
    await new Promise((r) => setTimeout(r, 0))
    expect(updateAppSettings).not.toHaveBeenCalled()
  })
})

// SECURITY: auto-restart on mod update and its delay are a restart decision,
// so the server refuses a change to them without server.control.
describe('Settings.tsx: Mods tab auto-restart is gated on server.control', () => {
  it('disables the auto-restart switch and its delay without server.control', async () => {
    mockCan = (cap) => cap !== 'server.control'
    primeCommonMocks()
    getAppSettings.mockResolvedValue({ settings: { ...baseSettings, modAutoRestart: true, modRestartDelay: '5' } } as never)

    renderSettings('mods')
    const toggle = await screen.findByRole('switch', { name: /auto-restart server when mods update/i })
    expect(toggle).toBeDisabled()
    expect(screen.getByLabelText(/^restart delay/i)).toBeDisabled()
  })

  it('leaves them enabled with server.control', async () => {
    mockCan = () => true
    primeCommonMocks()
    getAppSettings.mockResolvedValue({ settings: { ...baseSettings, modAutoRestart: true, modRestartDelay: '5' } } as never)

    renderSettings('mods')
    const toggle = await screen.findByRole('switch', { name: /auto-restart server when mods update/i })
    expect(toggle).not.toBeDisabled()
  })
})

describe('Settings.tsx: Access tab CORS actions are gated on diagnostics.manage', () => {
  it('disables Reload CORS Rules and never calls it when the role lacks diagnostics.manage', async () => {
    mockCan = (cap) => cap !== 'diagnostics.manage'
    primeCommonMocks()

    renderSettings('access')
    const reloadButton = await screen.findByRole('button', { name: /reload.*cors.*rules/i })
    expect(reloadButton).toBeDisabled()

    fireEvent.click(reloadButton)
    await new Promise((r) => setTimeout(r, 0))
    expect(reloadCorsDiagnostics).not.toHaveBeenCalled()
  })
})

describe('Settings.tsx: Connection Test is gated on server.configure', () => {
  it('disables Test and never calls testRcon when the role lacks server.configure', async () => {
    mockCan = (cap) => cap !== 'server.configure'
    primeCommonMocks()

    renderSettings('connection')
    const testButton = await screen.findByRole('button', { name: /test connection/i })
    expect(testButton).toBeDisabled()

    fireEvent.click(testButton)
    await new Promise((r) => setTimeout(r, 0))
    expect(testRcon).not.toHaveBeenCalled()
  })
})

describe('Settings.tsx: Bridge tab setup actions are gated on bridge.setup', () => {
  it('disables the auto-setup action and never calls autoConfigure when the role lacks bridge.setup', async () => {
    mockCan = (cap) => cap !== 'bridge.setup'
    primeCommonMocks()

    renderSettings('bridge')
    const autoSetupButton = await screen.findByRole('button', { name: /auto.?setup|one.?click/i })
    expect(autoSetupButton).toBeDisabled()

    fireEvent.click(autoSetupButton)
    await new Promise((r) => setTimeout(r, 0))
    expect(autoConfigure).not.toHaveBeenCalled()
  })
})

describe('Settings.tsx: Restart and Apply / Restart Panel are restricted to the admin role', () => {
  it('disables Restart Panel (General tab) for a non-admin role', async () => {
    mockCan = () => true
    primeCommonMocks()

    renderSettings('general')
    const restartButton = await screen.findByRole('button', { name: /^restart panel$/i })
    expect(restartButton).toBeDisabled()
  })
})

// #193 moved update-check, update-preflight and update-apply-log behind
// panel.settings. Without it, Check for Updates stayed enabled and failed
// with a 403 toast, and every Settings visit with an update available
// fired a preflight that 403'd into the client error log.
describe('Settings.tsx: panel update checks are gated on panel.settings', () => {
  function primeUpdateAvailable() {
    primeCommonMocks()
    getUpdateStatus.mockResolvedValue({
      currentVersion: '1.0.0', updateAvailable: true, latestVersion: '1.1.0',
      releaseUrl: null, releaseNotes: null, publishedAt: null, isChecking: false,
      isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
      updateMode: 'direct', stagedUpdate: null,
      // What update-status gives a role without panel.settings: no helperLog.
      lastApplyResult: { status: 'failed', pendingVersion: '1.1.0', canRetryApply: false },
    } as never)
    getApplyLog.mockResolvedValue({ log: null, logPath: '' } as never)
  }

  it('disables Check for Updates and calls none of the gated routes without panel.settings', async () => {
    mockCan = (cap) => cap !== 'panel.settings'
    primeUpdateAvailable()

    renderSettings('updates')
    const checkButton = await screen.findByRole('button', { name: 'Check for Updates' })
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled())
    expect(checkButton).toBeDisabled()

    fireEvent.click(checkButton)
    await new Promise((r) => setTimeout(r, 0))
    expect(checkForUpdate).not.toHaveBeenCalled()
    expect(preflight).not.toHaveBeenCalled()
    expect(getApplyLog).not.toHaveBeenCalled()
  })

  it('still runs the preflight and reads the apply log for a panel.settings holder', async () => {
    mockCan = () => true
    primeUpdateAvailable()

    renderSettings('updates')
    const checkButton = await screen.findByRole('button', { name: 'Check for Updates' })
    expect(checkButton).toBeEnabled()
    await waitFor(() => expect(preflight).toHaveBeenCalled())
    await waitFor(() => expect(getApplyLog).toHaveBeenCalled())
  })
})
