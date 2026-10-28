import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { modsViewButton } from './modsNav'

// Caldac (v1.6.0, 431 tracked mods, 415 in the config): the status bar said
// "1 update", the Installed menu item had a 1 badge and the "Updates only"
// chip a 1, but with that chip on the Installed list was empty. The update
// was on a tracked Workshop item that is not in WorkshopItems= (Deactivated)
// -- the counts read every tracked mod, the list only the ones on the server.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

const m = vi.mocked(modsApi)

const tracked = (id: number, workshopId: string, name: string, update: 0 | 1) => ({
  id, workshop_id: workshopId, name, last_updated: '2026-10-20T00:00:00.000Z',
  last_checked: '2026-10-25T00:00:00.000Z', update_available: update, created_at: '',
})

function prime(mods: ReturnType<typeof tracked>[], configured: string[]) {
  m.getTrackedMods.mockResolvedValue({ mods } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: mods.length, workshopAcfConfigured: true, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: configured.map((id) => `Mod${id}`),
    workshopIds: configured,
    maps: [],
    totalMods: configured.length,
    workshopModMap: Object.fromEntries(configured.map((id) => [id, [{ id: `Mod${id}`, name: `Mod ${id}`, enabled: true }]])),
  } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

async function renderInstalled() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  // The list has drawn its status groups (Up to Date starts collapsed).
  await screen.findAllByText(/^Up to Date/)
}

const updatesChip = () => screen.getByRole('button', { name: /^Updates only/i, pressed: false })

beforeEach(() => {
  // jsdom lays nothing out: an 800px list viewport and 64px rows (the
  // virtualizer reads the viewport through clientHeight, rows through
  // offsetHeight).
  const height = function (this: HTMLElement) {
    return this.className.includes('overflow-y-auto') ? 800 : 64
  }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(height)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(height)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Installed: the update counts and the list agree', () => {
  it('does not count an update on a Deactivated item the Installed list never shows', async () => {
    prime([
      tracked(1, '100', 'Alpha Mod', 0),
      tracked(2, '3809901056', 'PanelBridge', 1),
    ], ['100'])
    await renderInstalled()

    expect(screen.queryByRole('button', { name: /^1 update$/ })).not.toBeInTheDocument()
    expect(updatesChip().textContent).toBe('Updates Only')
    expect(modsViewButton('Installed').textContent).not.toMatch(/1/)
    await act(async () => {})
  })

  it('counts the item and lists it under "Updates only" when it is on the server', async () => {
    prime([
      tracked(1, '100', 'Alpha Mod', 0),
      tracked(2, '200', 'Bravo Vehicles', 1),
      tracked(3, '3809901056', 'PanelBridge', 1),
    ], ['100', '200'])
    await renderInstalled()

    expect(updatesChip().textContent).toBe('Updates Only1')
    fireEvent.click(screen.getByRole('button', { name: /^1 update$/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /^Updates only/i, pressed: true })).toBeInTheDocument())
    expect((await screen.findAllByText('Bravo Vehicles')).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(/^Up to Date/)).toHaveLength(0)
    expect(screen.queryAllByText('PanelBridge')).toHaveLength(0)
  })

  // The same day: "431 on server · 415 in config" while Installed listed the
  // 415 and Deactivated the other 16. "On server" counted every tracked mod.
  it('the status bar\'s "on server" count is the Installed list, not every tracked mod', async () => {
    prime([
      tracked(1, '100', 'Alpha Mod', 0),
      tracked(2, '200', 'Bravo Vehicles', 0),
      tracked(3, '3809901056', 'PanelBridge', 0),
    ], ['100', '200'])
    await renderInstalled()

    expect(screen.getByText('2 on server')).toBeInTheDocument()
    expect(screen.queryByText('3 on server')).not.toBeInTheDocument()
    await act(async () => {})
  })
})
