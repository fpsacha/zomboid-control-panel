import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'

// remote-bridge-version-staleness-is-never-surfaced-to-sftp-users: proves
// the wiring is real, not just that the pure detectBridgeStaleness() logic
// is correct (bridgeVersionStaleness.test.ts covers that) -- GET
// /panel-bridge/status already carried remoteBridgeVersionCheck,
// localInstall.needsUpdate, and modStatus.protocolVersionMismatch before
// this card; nothing in client/src ever read any of them.

const baseStatus = {
  configured: true,
  bridgePath: '/some/bridge/path',
  isRunning: true,
  pendingCommands: 0,
  modConnected: true,
  modStatus: {
    alive: true,
    version: '1.7.0',
    serverName: 'Test Server',
    playerCount: 3,
    players: ['a', 'b', 'c'],
    path: '/some/path',
    timestamp: Date.now(),
  },
  connection: {
    healthy: true,
    canSendCommands: true,
    summary: { key: 'healthy', text: 'Bridge file connection looks healthy.' },
    issues: [],
    checks: {},
  },
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

describe('Settings -> Bridge tab: version staleness warning', () => {
  it('shows a warning naming both protocol versions, and no action button, on a protocolVersionMismatch', async () => {
    vi.resetModules()
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
      return {
        ...actual,
        configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
        panelBridgeApi: {
          ...actual.panelBridgeApi,
          getStatus: vi.fn().mockResolvedValue({
            ...baseStatus,
            modStatus: {
              ...baseStatus.modStatus,
              protocolVersionMismatch: { expected: 'queue-v1', actual: 'queue-v2' },
            },
          }),
        },
      }
    })
    const { default: SettingsWithMismatch } = await import('../Settings')
    render(
      <MemoryRouter initialEntries={['/settings?tab=bridge']}>
        <TooltipProvider>
          <SettingsWithMismatch />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText(/queue-v1/)).toBeInTheDocument())
    expect(screen.getByText(/queue-v2/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update Now' })).not.toBeInTheDocument()
    vi.doUnmock('@/lib/api')
  })

  it('shows an Update Now button when a local, auto-installable bridge needs an update', async () => {
    vi.resetModules()
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
      return {
        ...actual,
        configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
        panelBridgeApi: {
          ...actual.panelBridgeApi,
          getStatus: vi.fn().mockResolvedValue({
            ...baseStatus,
            localInstall: {
              canAutoInstall: true,
              installed: true,
              version: '1.6.0',
              needsUpdate: true,
              sourcePath: '/src',
              targetPath: '/tgt',
            },
          }),
        },
      }
    })
    const { default: SettingsWithLocalStale } = await import('../Settings')
    render(
      <MemoryRouter initialEntries={['/settings?tab=bridge']}>
        <TooltipProvider>
          <SettingsWithLocalStale />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Now' })).toBeInTheDocument())
    vi.doUnmock('@/lib/api')
  })

  it('shows no staleness warning when nothing is stale', async () => {
    vi.resetModules()
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
      return {
        ...actual,
        configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
        panelBridgeApi: {
          ...actual.panelBridgeApi,
          getStatus: vi.fn().mockResolvedValue(baseStatus),
        },
      }
    })
    const { default: SettingsClean } = await import('../Settings')
    render(
      <MemoryRouter initialEntries={['/settings?tab=bridge']}>
        <TooltipProvider>
          <SettingsClean />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText(/Test Server/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Update Now' })).not.toBeInTheDocument()
    vi.doUnmock('@/lib/api')
  })
})
