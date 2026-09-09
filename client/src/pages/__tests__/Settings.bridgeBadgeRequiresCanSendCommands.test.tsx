import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'

// bughunt-2026-08-31: bridgeStatus.modConnected reflects modStatus.alive,
// which is DEBOUNCED (server keeps it true through up to 5 consecutive poll
// misses -- deliberate anti-flap, see panelBridge.js's maxConsecutiveFailures).
// connection.canSendCommands is a separate, undebounced, live check of
// whether the panel can actually write to the bridge (dir writable + status
// file fresh) -- it can go false while modConnected is still true, e.g. a
// single stale poll tick that hasn't yet crossed the 5-failure threshold, or
// a persistent bridge-directory permissions problem. The Ping button's
// handler (handlePingMod -> panelBridgeApi.ping() -> server's sendCommand())
// throws "Bridge file connection is unhealthy" whenever canSendCommands is
// false, independent of modConnected. Before this fix, the badge and the
// Ping button's disabled state read modConnected alone, so this exact state
// showed a "Bridge connected" badge with an enabled Ping button that was
// guaranteed to throw the instant it was clicked.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        bridgePath: '/some/bridge/path',
        isRunning: true,
        pendingCommands: 0,
        modConnected: true,
        consecutiveFailures: 2,
        modStatus: {
          alive: true,
          version: '1.0.0',
          serverName: 'Test Server',
          playerCount: 3,
          players: ['a', 'b', 'c'],
          path: '/some/path',
          timestamp: Date.now(),
        },
        connection: {
          healthy: false,
          canSendCommands: false,
          summary: { key: 'statusFileStale', params: { age: '12s' }, text: 'Status file is stale (12s old) — is the PZ server running?' },
          issues: [{ key: 'statusFileStale', params: { age: '12s' }, text: 'Status file is stale (12s old) — is the PZ server running?' }],
          checks: { bridgePathExists: true, bridgePathWritable: true, statusFilePresent: true, statusFresh: false },
        },
      }),
    },
  }
})

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

describe('Settings -> Bridge tab: badge and Ping button when modConnected but !canSendCommands', () => {
  it('does not show "Bridge connected" and disables Ping when the mod is alive but the panel cannot currently send commands', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=bridge']}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ping Mod' })).toBeInTheDocument())

    expect(screen.queryByText('Bridge connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ping Mod' })).toBeDisabled()
  })
})
