import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { getCharacterSheet, type CharacterSection, type CharacterSheetResponse } from '@/lib/characterApi'
import { TooltipProvider } from '@/components/ui/tooltip'

// v1.4.1: the Character tab replaced Vitals (and Players.vitalsTab.test.tsx).
// The page owns the character sheet poll so the dossier badge counts on every
// tab; these pin when it reads and when it doesn't.

let mockCan = (_capability: string) => true
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getPlayerDetails: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
  }
})

vi.mock('@/lib/characterApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/characterApi')>('@/lib/characterApi')
  return { ...actual, getCharacterSheet: vi.fn() }
})

const socketHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => fakeSocket }))

const sheetMock = vi.mocked(getCharacterSheet)
const REFRESH_MS = 10000

function sheetResponse(sections: CharacterSection[] | undefined, overrides: Partial<CharacterSheetResponse> = {}): CharacterSheetResponse {
  const inventory = sections?.includes('inventory')
  return {
    username: 'TestPlayer',
    serverId: 'srv',
    availability: 'live',
    transport: 'local',
    refreshAfterMs: REFRESH_MS,
    inventoryRefreshAfterMs: 30000,
    fetchedAt: new Date().toISOString(),
    sheet: inventory
      ? {
          username: 'TestPlayer',
          inventory: {
            root: { kind: 'container', id: 'main', rows: [{ kind: 'stack', fullType: 'Base.Hammer', name: 'Hammer', qty: 1 }] },
            worn: [],
            equipped: {},
            attached: [],
            totals: {},
          },
        }
      : {
          username: 'TestPlayer',
          summary: { hoursSurvived: 48, zombieKills: 3, profession: { id: 'base:carpenter', label: 'Carpenter' } },
          skills: { categories: [{ id: 'Crafting' }], perks: [{ id: 'Woodwork', parent: 'Crafting', level: 2, passive: false }] },
          traits: [],
        },
    cached: null,
    record: null,
    skillDelta: null,
    hints: [],
    hintSource: 'live',
    hintThresholds: {
      advancedLevelFloor: 3,
      advancedLevelsPerHour: 3,
      advancedLevelsGrace: 6,
      bookMultiplierWeight: 0.5,
      maxedSkillsCount: 3,
      maxedSkillsStrongCount: 6,
      maxedSkillsWithinHours: 40,
      maxedSkillsShareAlways: 0.8,
      jumpLevelsOnePerk: 3,
      jumpMinTargetLevel: 6,
      jumpLevelsPassive: 2,
      jumpTotalLevels: 6,
      jumpWindowMinutes: 60,
      jumpRawXpFloor: 3000,
      unusualQuantity: 500,
      overCapacityFactor: 2,
    },
    ...overrides,
  }
}

function baseCalls() {
  return sheetMock.mock.calls.filter(([, options]) => !options?.sections?.includes('inventory'))
}

function inventoryCalls() {
  return sheetMock.mock.calls.filter(([, options]) => options?.sections?.includes('inventory'))
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

function setUpFixtures({ offlinePlayer = false } = {}) {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [] })
  vi.mocked(playersApi.getStats).mockResolvedValue({
    stats: offlinePlayer
      ? [{ player_name: 'GhostPlayer', total_playtime_seconds: 100, session_count: 1, first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z' }]
      : [],
  })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(panelBridgeApi.getAllPlayerDetails).mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
  sheetMock.mockImplementation(async (_username, options) => sheetResponse(options?.sections))
}

function renderPlayers(initialEntries = ['/players']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

function openTab(name: string) {
  // Radix TabsTrigger switches on mousedown, not click.
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  mockCan = () => true
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  socketHandlers.clear()
  setVisibility('visible')
})

describe('Players.tsx Character tab', () => {
  it('a deep link with ?tab=character opens the tab for the linked player', async () => {
    setUpFixtures()
    renderPlayers(['/players?player=TestPlayer&tab=character'])
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Character' })).toHaveAttribute('aria-selected', 'true'))
    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    expect(sheetMock).toHaveBeenCalledWith('TestPlayer', expect.objectContaining({ sections: ['summary', 'stats', 'skills', 'traits'] }))
  })

  it('moderators land on Moderation; a role that cannot moderate lands on Character', async () => {
    setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    expect(screen.getByRole('tab', { name: 'Moderation' })).toHaveAttribute('aria-selected', 'true')
    cleanup()

    mockCan = (capability) => capability !== 'players.moderate'
    renderPlayers()
    await selectTestPlayer()
    expect(screen.getByRole('tab', { name: 'Character' })).toHaveAttribute('aria-selected', 'true')
  })

  it('an unknown ?tab= falls back to the default', async () => {
    setUpFixtures()
    renderPlayers(['/players?tab=vitals'])
    await selectTestPlayer()
    expect(screen.getByRole('tab', { name: 'Moderation' })).toHaveAttribute('aria-selected', 'true')
  })

  it('selecting a player reads once, whatever the tab, and does not poll from another tab', async () => {
    setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await waitFor(() => expect(baseCalls()).toHaveLength(1))
    await advance(REFRESH_MS * 3)
    expect(baseCalls()).toHaveLength(1)
  })

  it('polls while the Character tab is open and the page is visible, and stops when hidden', async () => {
    setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await waitFor(() => expect(baseCalls()).toHaveLength(1))
    openTab('Character')
    await advance(REFRESH_MS)
    await waitFor(() => expect(baseCalls()).toHaveLength(2))

    act(() => setVisibility('hidden'))
    await advance(REFRESH_MS * 3)
    expect(baseCalls()).toHaveLength(2)

    act(() => setVisibility('visible'))
    await advance(REFRESH_MS)
    await waitFor(() => expect(baseCalls().length).toBeGreaterThanOrEqual(3))
  })

  it('does not poll an offline player: one read for the last known sheet', async () => {
    setUpFixtures({ offlinePlayer: true })
    sheetMock.mockImplementation(async () =>
      sheetResponse(undefined, { availability: 'playerOffline', sheet: null, cached: null, hintSource: null }),
    )
    renderPlayers()
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Roster/ })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Roster/ }), { button: 0 })
    await waitFor(() => expect(screen.getByText('GhostPlayer')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByText('GhostPlayer'))
    await waitFor(() => expect(screen.getAllByText('GhostPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
    openTab('Character')
    expect(await screen.findByText('No saved character yet')).toBeInTheDocument()
    await advance(REFRESH_MS * 3)
    expect(baseCalls()).toHaveLength(1)
    expect(sheetMock).toHaveBeenCalledWith('GhostPlayer', expect.anything())
  })

  it('reads the inventory only when asked', async () => {
    setUpFixtures()
    renderPlayers(['/players?tab=character'])
    await selectTestPlayer()
    await screen.findByRole('heading', { name: 'Skills' })
    await advance(REFRESH_MS)
    expect(inventoryCalls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }))
    await waitFor(() => expect(inventoryCalls()).toHaveLength(1))
    expect(await screen.findByText('Hammer')).toBeInTheDocument()
  })

  it('re-reads the player after a server switch', async () => {
    setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await waitFor(() => expect(baseCalls()).toHaveLength(1))
    act(() => {
      socketHandlers.get('activeServerChanged')?.forEach((handler) => handler())
    })
    await waitFor(() => expect(baseCalls()).toHaveLength(2))
  })

  it('the dossier badge counts unexplained hints on any tab and opens the Character tab', async () => {
    setUpFixtures()
    sheetMock.mockImplementation(async (_username, options) =>
      sheetResponse(options?.sections, {
        hints: [
          { id: 'overCapacity', weight: 'strong', params: { carried: 40, max: 15 }, evidence: [], staff: false, source: 'live' },
          {
            id: 'debugItems',
            weight: 'strong',
            params: {},
            evidence: [{ kind: 'item', ref: 'Base.TestMug' }],
            explainedBy: [{ action: 'add_item', at: '2026-09-29T10:00:00.000Z', details: 'Base.TestMug x1' }],
            staff: false,
            source: 'live',
          },
        ],
      }),
    )
    renderPlayers()
    await selectTestPlayer()
    expect(screen.getByRole('tab', { name: 'Moderation' })).toHaveAttribute('aria-selected', 'true')
    const badge = await screen.findByRole('button', { name: /^1 to look at\./ })
    fireEvent.click(badge)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Character' })).toHaveAttribute('aria-selected', 'true'))
    expect(await screen.findByText('Carrying far over the limit')).toBeInTheDocument()
  })
})

describe('Players.tsx Activity list', () => {
  const LOG = { id: 1, player_name: 'TestPlayer', action: 'KICKED_FOR_TEST', details: 'detail', logged_at: '2026-09-29T10:00:00Z' }

  it('opening /players?list=activity (a reload, or Back) reads the activity log', async () => {
    setUpFixtures()
    vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [LOG] } as never)
    renderPlayers(['/players?list=activity'])
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true'))
    expect(await screen.findByText('KICKED_FOR_TEST')).toBeInTheDocument()
    expect(screen.queryByText(/No activity yet/)).toBeNull()
  })

  // Security audit R2-6: each deliberate action names the panel account
  // that made it; automatic and older rows have none.
  it('names the panel account behind an action, and nothing on a row without one', async () => {
    setUpFixtures()
    vi.mocked(playersApi.getActivityLogs).mockResolvedValue({
      logs: [{ ...LOG, actor: 'alice' }, { ...LOG, id: 2, action: 'AUTOMATIC_ROW' }],
    } as never)
    renderPlayers(['/players?list=activity'])
    expect(await screen.findByText('by alice')).toBeInTheDocument()
    expect(await screen.findByText('AUTOMATIC_ROW')).toBeInTheDocument()
    expect(screen.getAllByText(/^by /)).toHaveLength(1)
  })

  it('switching to the list reads it too, however the list is chosen', async () => {
    setUpFixtures()
    vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [LOG] } as never)
    renderPlayers()
    await selectTestPlayer()
    expect(playersApi.getActivityLogs).not.toHaveBeenCalled()
    openTab('Activity')
    expect(await screen.findByText('KICKED_FOR_TEST')).toBeInTheDocument()
  })
})

describe('Players.tsx manual target', () => {
  it('typing a name reads the character once the typing pauses, not per keystroke', async () => {
    setUpFixtures()
    renderPlayers()
    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
    const input = screen.getByPlaceholderText(/username/i)
    for (const value of ['B', 'Ba', 'Bar', 'Bart', 'Barth', 'Bartho']) {
      fireEvent.change(input, { target: { value } })
      await advance(60)
    }
    expect(baseCalls()).toHaveLength(0)
    await advance(2000)
    expect(baseCalls().map(([username]) => username)).toEqual(['Bartho'])
  })

  it('a roster click still reads at once', async () => {
    setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await waitFor(() => expect(baseCalls().map(([username]) => username)).toEqual(['TestPlayer']))
  })

  it('a name typed in another case is the online player: the Character tab polls it live', async () => {
    setUpFixtures()
    renderPlayers(['/players?tab=character'])
    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.change(screen.getByPlaceholderText(/username/i), { target: { value: 'testplayer' } })
    await advance(1000)
    expect(await screen.findByRole('button', { name: 'Load inventory' })).toBeInTheDocument()
    await advance(REFRESH_MS + 100)
    expect(baseCalls().length).toBeGreaterThanOrEqual(2)
  })
})
