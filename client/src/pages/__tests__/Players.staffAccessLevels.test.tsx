import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import en from '../../locales/en/players.json'

// SECURITY (2026-10-28, audit R2-5): POST /players/access-level requires
// rcon.execute on top of players.moderate for a staff level (admin,
// moderator, gm, observer, a custom role with more than login rights), since
// those levels run server console commands in game. GET /access-levels names
// them in `staffLevels`; a role without rcon.execute is offered the others
// only, with a line saying why.

// Same plain-<select> stand-in as Players.lastAdminAccessLevelConfirm.test.tsx.
vi.mock('@/components/ui/select', () => {
  function findId(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (found || !React.isValidElement(child)) return
      const props = child.props as { id?: string; children?: React.ReactNode }
      if (props.id) {
        found = props.id
        return
      }
      found = findId(props.children)
    })
    return found
  }
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
      <select id={findId(children)} value={value} onChange={(e) => onValueChange(e.target.value)}>
        <option value="" disabled></option>
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
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getWhitelist: vi.fn(),
      getPerks: vi.fn(),
      getAccessLevels: vi.fn(),
      getSteamIdBans: vi.fn(),
      getNotes: vi.fn(),
      getStats: vi.fn(),
      getExports: vi.fn(),
      getActivityLogs: vi.fn(),
      setAccessLevel: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

function setUpFixtures() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({
    success: true,
    available: true,
    accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'user', authType: 0, steamId: null, ownerId: null, displayName: null }],
    allowedSteamIds: [],
  })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({
    levels: ['banned', 'user', 'priority', 'observer', 'gm', 'moderator', 'admin', 'VIP', 'none'],
    staffLevels: ['observer', 'gm', 'moderator', 'admin'],
    available: true,
  })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [] })
  vi.mocked(playersApi.getStats).mockResolvedValue({ stats: [] })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(panelBridgeApi.getAllPlayerDetails).mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function openAccessLevelDialog() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  await waitFor(() => expect(playersApi.getAccessLevels).toHaveBeenCalled())
  fireEvent.click(screen.getByText(en.actionTiles.accessLevelLabel).closest('button')!)
  return screen.findByRole('dialog')
}

function optionValues(dialog: HTMLElement) {
  const select = within(dialog).getByLabelText(en.accessLevelDialog.label) as HTMLSelectElement
  return Array.from(select.options).map(option => option.value).filter(Boolean)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Players.tsx: staff access levels need rcon.execute', () => {
  it('offers a role without rcon.execute only the plain levels, and says why', async () => {
    mockCan = (capability) => capability !== 'rcon.execute'
    setUpFixtures()
    const dialog = await openAccessLevelDialog()

    await waitFor(() => expect(optionValues(dialog)).toEqual(['banned', 'user', 'priority', 'VIP', 'none']))
    expect(within(dialog).getByText(en.accessLevelDialog.staffLevelsHint)).toBeInTheDocument()
  })

  it('offers every level to a role with rcon.execute, without the note', async () => {
    setUpFixtures()
    const dialog = await openAccessLevelDialog()

    await waitFor(() => expect(optionValues(dialog)).toContain('admin'))
    expect(optionValues(dialog)).toHaveLength(9)
    expect(within(dialog).queryByText(en.accessLevelDialog.staffLevelsHint)).not.toBeInTheDocument()
  })
})
