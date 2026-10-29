import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi, serversApi, permissionsApi, usersApi } from '@/lib/api'

// Security audit R2-27 (2026-10-28): with panel logins off, the panel only
// answers the browser extensions named under Remote Access, and its refusal
// tells the Steam Sync extension the exact line to add
// (chrome-extension://<id> or moz-extension://<uuid>). The list used to take
// http:// and https:// origins only, so that line could not be saved.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: false,
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
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), getCorsDiagnostics: vi.fn() },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

function primeMocks(corsAllowedOrigins: string) {
  vi.mocked(configApi.getAppSettings).mockResolvedValue({
    settings: { panelPort: 8080, httpsEnabled: false, httpsPort: 8443, corsAllowedOrigins, autoReconnect: false, autoStartServer: false },
  } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null, releaseNotes: null,
    publishedAt: null, isChecking: false, isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  vi.mocked(panelUpdateApi.preflight).mockResolvedValue({
    ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
    info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
  } as never)
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(configApi.getCorsDiagnostics).mockResolvedValue({ diagnostics: null } as never)
  vi.mocked(serverApi.getNetworkInterfaces).mockResolvedValue({ interfaces: [] } as never)
  vi.mocked(permissionsApi.getCapabilities).mockResolvedValue({ groups: [] } as never)
  vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] } as never)
  vi.mocked(usersApi.list).mockResolvedValue({ users: [] } as never)
}

async function renderAccessTab(corsAllowedOrigins: string) {
  primeMocks(corsAllowedOrigins)
  render(
    <MemoryRouter initialEntries={['/settings?tab=access']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
  const field = await screen.findByLabelText('Additional Allowed Origins')
  await vi.waitFor(() => expect(field).toHaveValue(corsAllowedOrigins))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings > Remote Access: a browser extension can be named (R2-27)', () => {
  it('takes a Chrome or Firefox extension origin next to web addresses', async () => {
    await renderAccessTab(
      'https://panel.example.com\nchrome-extension://abcdefghijklmnopabcdefghijklmnop\nmoz-extension://0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
    )
    expect(screen.queryByText(/Only http\/https origins are allowed/)).toBeNull()
    expect(screen.queryByText(/Invalid origin format/)).toBeNull()
  })

  it('still refuses an extension address with anything after the id', async () => {
    await renderAccessTab('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html')
    expect(await screen.findByText(/Invalid origin format/)).toBeInTheDocument()
  })
})
