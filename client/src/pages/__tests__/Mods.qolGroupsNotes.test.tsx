import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi, type ModGroup } from '@/lib/api'
import { modsViewButton, openModsView } from './modsNav'

// The Mod Manager's group and note features on the page: the view in the URL,
// the Groups view on Active on server (Enable all / Disable all, suggestions,
// conflict badges), "Add to group" and notes from a row's menu, remembered
// filter chips, "What changed" links, Auto-sort with groups, and a 600-item
// list that still renders quickly.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))
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
      saveModOrder: vi.fn(),
      planLoadOrder: vi.fn(),
      getGroups: vi.fn(),
      getGroupsStatus: vi.fn(),
      createGroup: vi.fn(),
      updateGroup: vi.fn(),
      enableGroup: vi.fn(),
      disableGroup: vi.fn(),
      getGroupSuggestions: vi.fn(),
      dismissGroupSuggestion: vi.fn(),
      getNotes: vi.fn(),
      setNote: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

Element.prototype.scrollIntoView = vi.fn()

const m = vi.mocked(modsApi)
const STAMP = '2026-10-01T00:00:00.000Z'

type ModMap = Record<string, Array<{ id: string; name: string; enabled: boolean; require?: string[] }>>

// Four single-ID items; Bravo is not enabled.
const MODS: ModMap = {
  '100': [{ id: 'ModA', name: 'Alpha Mod', enabled: true }],
  '200': [{ id: 'ModB', name: 'Bravo Mod', enabled: false }],
  '300': [{ id: 'ModC', name: 'Charlie Mod', enabled: true }],
  '400': [{ id: 'ModD', name: 'Delta Mod', enabled: true }],
}

const VEHICLES: ModGroup = { id: 'g1', name: 'Vehicles', description: '', modIds: ['ModA', 'ModB'], createdAt: STAMP, updatedAt: STAMP, color: 'amber' }

function prime({ mods = MODS, groups = [VEHICLES], tracked = [] as unknown[], order }: { mods?: ModMap; groups?: ModGroup[]; tracked?: unknown[]; order?: string[] } = {}) {
  const ids = Object.values(mods).flat()
  m.getTrackedMods.mockResolvedValue({ mods: tracked } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: tracked.length, workshopAcfConfigured: true, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: order ?? ids.filter((i) => i.enabled).map((i) => i.id),
    workshopIds: Object.keys(mods),
    maps: [],
    totalMods: ids.length,
    workshopModMap: mods,
  } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  m.saveModOrder.mockResolvedValue({ message: 'ok', modCount: ids.length } as never)
  m.getGroups.mockResolvedValue({ groups, enforce: false })
  m.getGroupsStatus.mockResolvedValue({ groups: groups.map((g) => ({ id: g.id, inOrder: true, present: 2, total: 2, missing: [] })), inOrder: true, conflicts: [] })
  m.createGroup.mockResolvedValue({ group: { ...VEHICLES, id: 'g9', name: 'New' } })
  m.updateGroup.mockResolvedValue({ group: VEHICLES })
  m.enableGroup.mockResolvedValue({ enabled: ['ModB'], alreadyEnabled: ['ModA'], missing: [], workshopItemsAdded: [], groupsAdjusted: [] })
  m.disableGroup.mockResolvedValue({ disabled: ['ModA'], keptShared: [], notEnabled: ['ModB'], keptManaged: [] })
  m.getGroupSuggestions.mockResolvedValue({ suggestions: [] })
  m.dismissGroupSuggestion.mockResolvedValue({ success: true })
  m.getNotes.mockResolvedValue({ notes: {} })
  m.setNote.mockImplementation(async (_ws, text) => ({ note: text ? { text, updatedAt: STAMP, updatedBy: 'someone' } : null }))
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

let currentSearch = ''
function LocationProbe() {
  currentSearch = useLocation().search
  return null
}

function renderMods(path = '/mods') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <Mods />
        <LocationProbe />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openActiveGroups() {
  renderMods()
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  await openModsView('Active on server')
  await screen.findByText(/IDs enabled/)
  fireEvent.click(screen.getByRole('radio', { name: 'Groups' }))
  return screen.findByRole('button', { name: 'Vehicles' })
}

// A Radix DropdownMenu opens on pointerdown.
async function openMenu(name: string | RegExp) {
  const trigger = await screen.findByRole('button', { name })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

const toastTitles = () => toastSpy.mock.calls.map((call) => call[0]?.title)

beforeEach(() => {
  localStorage.clear()
  currentSearch = ''
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  confirmSpy.mockReset()
})

describe('Mod Manager views in the URL', () => {
  it('opens the view named in ?view= and writes the view picked from the menu back', async () => {
    prime()
    // A cached scan: opening Conflicts without one starts a scan (EventSource).
    m.getCachedConflicts.mockResolvedValue({ totalConflicts: 0, identicalSkipped: 0, pairs: [], totalPairs: 0, modsScanned: 4, missingDeps: [], modLoadOrder: [] } as never)
    renderMods('/mods?view=order')
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())

    await waitFor(() => expect(modsViewButton('Load order')).toHaveAttribute('aria-current', 'true'))
    await openModsView('Conflicts')

    expect(modsViewButton('Conflicts')).toHaveAttribute('aria-current', 'true')
    expect(currentSearch).toContain('view=conflicts')
  })

  it('falls back to Installed for an unknown view', async () => {
    prime()
    renderMods('/mods?view=nope')
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await waitFor(() => expect(modsViewButton('Installed')).toHaveAttribute('aria-current', 'true'))
  })
})

describe('Active on server, Groups view', () => {
  it('shows each group with how many of its mods are enabled, then the mods in no group', async () => {
    prime()
    await openActiveGroups()

    const header = document.querySelector('[data-group-section="g1"]') as HTMLElement
    expect(header).toHaveTextContent('1 of 2 enabled')
    expect(screen.getByRole('button', { name: 'In no group' })).toBeInTheDocument()
    expect(screen.getAllByText('Alpha Mod').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Charlie Mod').length).toBeGreaterThan(0)
    // The mode is remembered.
    expect(JSON.parse(localStorage.getItem('zcp:mods:active:mode') ?? '""')).toBe('groups')
  })

  it('Enable all enables the group in one request and reloads the config', async () => {
    prime()
    await openActiveGroups()
    const configReads = m.getCurrentConfig.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }))

    await waitFor(() => expect(m.enableGroup).toHaveBeenCalledWith('g1'))
    await waitFor(() => expect(toastTitles()).toContain('Enabled Vehicles'))
    await waitFor(() => expect(m.getCurrentConfig.mock.calls.length).toBeGreaterThan(configReads))
  })

  it('Disable all asks first, then keeps mods other groups need', async () => {
    prime()
    confirmSpy.mockResolvedValue(true)
    await openActiveGroups()

    const menu = await openMenu('Actions for group Vehicles')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Disable all/ }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0].title).toBe('Disable Vehicles?')
    expect(confirmSpy.mock.calls[0][0].description).toContain('1 mod leaves the server config')
    await waitFor(() => expect(m.disableGroup).toHaveBeenCalledWith('g1', true))
  })

  it('names a mod kept for another group whose enabled mods still use it, though that group lists a mod this server lacks', async () => {
    // "Charlie pack" lists ModA too; its ModC is enabled, ModGhost is not on this server.
    const CHARLIE: ModGroup = { id: 'g2', name: 'Charlie pack', description: '', modIds: ['ModA', 'ModC', 'ModGhost'], createdAt: STAMP, updatedAt: STAMP }
    prime({ groups: [VEHICLES, CHARLIE] })
    confirmSpy.mockResolvedValue(false)
    await openActiveGroups()

    const menu = await openMenu('Actions for group Vehicles')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Disable all/ }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    const { description, items } = confirmSpy.mock.calls[0][0]
    expect(description).toContain('0 mods leave the server config')
    expect(description).toContain('Kept, because another group still has enabled mods')
    expect(description).toContain('ModA (Alpha Mod)')
    expect(items).toEqual([])
  })

  it('does nothing when Disable all is declined', async () => {
    prime()
    confirmSpy.mockResolvedValue(false)
    await openActiveGroups()

    const menu = await openMenu('Actions for group Vehicles')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Disable all/ }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(m.disableGroup).not.toHaveBeenCalled()
  })

  it('offers suggested groups: Create opens the group dialog with it, Dismiss hides it', async () => {
    prime()
    m.getGroupSuggestions.mockResolvedValue({
      suggestions: [
        { key: 'prefix:abc', kind: 'prefix', name: 'Charlie', modIds: ['ModC', 'ModD'] },
        { key: 'prefix:def', kind: 'prefix', name: 'Delta', modIds: ['ModD', 'ModA'] },
      ],
    })
    await openActiveGroups()

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss the suggestion Delta' }))
    await waitFor(() => expect(m.dismissGroupSuggestion).toHaveBeenCalledWith('prefix:def'))
    expect(screen.queryByRole('button', { name: 'Dismiss the suggestion Delta' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Create the group Charlie' }))
    expect(await screen.findByRole('heading', { name: 'New mod group' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Charlie')
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))

    await waitFor(() => expect(m.createGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'Charlie', modIds: ['ModC', 'ModD'] })))
  })

  it("opens Conflicts filtered to a group's mods from its conflict badge", async () => {
    prime()
    m.getCachedConflicts.mockResolvedValue({
      totalConflicts: 1,
      identicalSkipped: 0,
      pairs: [{
        modA: { workshopId: '100', modId: 'ModA', modName: 'Alpha Mod' },
        modB: { workshopId: '300', modId: 'ModC', modName: 'Charlie Mod' },
        files: [{ file: 'media/lua/shared/X.lua', category: 'lua', severity: 'high' }],
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      }],
      totalPairs: 1,
      modsScanned: 4,
      missingDeps: [],
      modLoadOrder: ['ModA', 'ModC', 'ModD'],
    } as never)
    await openActiveGroups()

    fireEvent.click(await screen.findByRole('button', { name: '1 file conflict involves Vehicles. Show it' }))

    await waitFor(() => expect(modsViewButton('Conflicts')).toHaveAttribute('aria-current', 'true'))
    expect(await screen.findByText('Mods of Vehicles')).toBeInTheDocument()
  })
})

describe('Groups and notes from a row', () => {
  it('adds a mod to a group from its menu', async () => {
    prime()
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    const menu = await openMenu('More actions for Charlie Mod')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to group…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add to a group' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Vehicles/ }))

    await waitFor(() => expect(m.updateGroup).toHaveBeenCalledWith('g1', { modIds: ['ModA', 'ModB', 'ModC'] }))
    await waitFor(() => expect(toastTitles()).toContain('Added to Vehicles'))
  })

  it('adds several selected items to a group at once', async () => {
    prime()
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    const addSelected = screen.getByRole('button', { name: 'Add selected to group' })
    expect(addSelected).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Charlie Mod' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Delta Mod' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add selected to group' }))

    const dialog = await screen.findByRole('dialog', { name: 'Add to a group' })
    expect(dialog).toHaveTextContent('Pick the group for 2 mods.')
    fireEvent.click(within(dialog).getByRole('button', { name: /Vehicles/ }))

    await waitFor(() => expect(m.updateGroup).toHaveBeenCalledWith('g1', { modIds: ['ModA', 'ModB', 'ModC', 'ModD'] }))
  })

  it('starts a new group with every selected mod, the ones not in the load order last', async () => {
    prime()
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    // Bravo is not enabled, so it is not in the load order.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bravo Mod' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Delta Mod' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add selected to group' }))
    const picker = await screen.findByRole('dialog', { name: 'Add to a group' })
    fireEvent.click(within(picker).getByRole('button', { name: 'New group…' }))

    const dialog = await screen.findByRole('dialog', { name: 'New mod group' })
    const members = Array.from(dialog.querySelectorAll('[data-member-id]')).map((el) => el.getAttribute('data-member-id'))
    expect(members).toEqual(['ModD', 'ModB'])
  })

  it("shows a group member's colour dots and offers to remove it from the group", async () => {
    prime({ groups: [{ ...VEHICLES, modIds: ['ModA', 'ModB', 'ModC'] }] })
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    expect((await screen.findAllByText('In groups: Vehicles')).length).toBeGreaterThan(0)
    const menu = await openMenu('More actions for Charlie Mod')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Vehicles' }))

    await waitFor(() => expect(m.updateGroup).toHaveBeenCalledWith('g1', { modIds: ['ModA', 'ModB'] }))
  })

  it('adds a note from the menu, shows it on the row, and finds the row by its text', async () => {
    prime()
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    const menu = await openMenu('More actions for Delta Mod')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add note' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Note' }), { target: { value: 'Keep 1.2, 1.3 breaks saves' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))

    await waitFor(() => expect(m.setNote).toHaveBeenCalledWith('400', 'Keep 1.2, 1.3 breaks saves'))
    expect(await screen.findByRole('button', { name: 'Note: Keep 1.2, 1.3 breaks saves' })).toBeInTheDocument()

    // The search finds an item by its note.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter active mods' }), { target: { value: 'breaks saves' } })
    await waitFor(() => expect(screen.queryByText('Alpha Mod')).toBeNull())
    expect(screen.getAllByText('Delta Mod').length).toBeGreaterThan(0)
  })

  it('filters on notes with a chip that is remembered, and removed from the "Filtered by" row', async () => {
    prime()
    m.getNotes.mockResolvedValue({ notes: { '300': { text: 'Needs Arsenal', updatedAt: STAMP, updatedBy: null } } })
    const first = renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    fireEvent.click(await screen.findByRole('button', { name: 'With a note (1)' }))
    await waitFor(() => expect(screen.queryByText('Alpha Mod')).toBeNull())
    expect(screen.getAllByText('Charlie Mod').length).toBeGreaterThan(0)

    first.unmount()
    renderMods('/mods?view=active')
    await waitFor(() => expect(screen.getByRole('button', { name: 'With a note (1)' })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.queryByText('Alpha Mod')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Has a note' }))
    expect((await screen.findAllByText('Alpha Mod')).length).toBeGreaterThan(0)
  })
})

describe('Load order: Auto-sort with groups', () => {
  it('proposes the server plan with its reason in words, and Apply leaves an unsaved change', async () => {
    // The group says ModD loads before ModA; the list has it the other way round.
    prime({ groups: [{ ...VEHICLES, modIds: ['ModD', 'ModA'] }], order: ['ModA', 'ModC', 'ModD'] })
    renderMods('/mods?view=order')
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await screen.findByRole('button', { name: 'Move ModD to the top' })

    m.planLoadOrder.mockResolvedValue({
      order: ['ModD', 'ModA', 'ModC'],
      changed: true,
      moves: [{ modId: 'ModD', from: 2, to: 0, confidence: 'high', reasons: [{ code: 'groupOrder', params: { relation: 'before', other: 'ModA', group: VEHICLES.id, groupName: VEHICLES.name } }] }],
      explanations: {}, satisfied: 1, unsatisfied: [], cycles: [], winnersChanged: [], implicit: [], warnings: [],
      stats: { constraints: 1, hard: 1, strong: 0, soft: 0, ms: 3 },
      steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
    } as never)
    fireEvent.click(screen.getByRole('button', { name: /^Auto-sort$/ }))

    // The server plans the order on screen (unsaved moves included).
    const preview = await screen.findByRole('region', { name: '1 mod moves' })
    expect(m.planLoadOrder).toHaveBeenCalledWith(expect.objectContaining({ order: ['ModA', 'ModC', 'ModD'], mode: 'minimal', groups: true }))
    expect(preview).toHaveTextContent('Vehicles')
    expect(preview).toHaveTextContent('Comes before Alpha Mod in the group Vehicles')
    fireEvent.click(within(preview).getByRole('button', { name: 'Apply' }))

    const order = Array.from(document.querySelectorAll('[data-load-order-index]')).map((row) => row.querySelector('.font-mono')?.textContent)
    expect(order.indexOf('ModD')).toBeLessThan(order.indexOf('ModA'))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(m.saveModOrder).not.toHaveBeenCalled()
  })
})

describe('With a laid-out list', () => {
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
  })

  it('links an item with an update to its Workshop change notes, on Installed and on Active on server', async () => {
    prime({
      tracked: [{ id: 1, workshop_id: '100', name: 'Alpha Mod', last_updated: '', last_checked: STAMP, update_available: 1, created_at: '' }],
    })
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())

    const installedLink = await screen.findByRole('link', { name: 'What changed in Alpha Mod: Steam change notes (opens a new tab)' })
    expect(installedLink).toHaveAttribute('href', 'https://steamcommunity.com/sharedfiles/filedetails/changelog/100')
    expect(installedLink).toHaveAttribute('target', '_blank')

    await openModsView('Active on server')
    const activeLink = await screen.findByRole('link', { name: 'What changed in Alpha Mod: Steam change notes (opens a new tab)' })
    expect(activeLink).toHaveAttribute('href', 'https://steamcommunity.com/sharedfiles/filedetails/changelog/100')
  })

  it('places Installed rows by their measured height, so a row that wraps taller does not overlap the next', async () => {
    prime({
      tracked: ['100', '200', '300'].map((ws, i) => ({ id: i + 1, workshop_id: ws, name: `Tracked ${ws}`, last_updated: '', last_checked: STAMP, update_available: 1, created_at: '' })),
    })
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await screen.findByText('Tracked 300')

    // Every row measures 64px here (the estimate is 40 for the header and 96
    // for a mod): the third entry starts after the measured header and row.
    const third = document.querySelector('[data-index="2"]') as HTMLElement
    await waitFor(() => expect(third.style.transform).toBe('translateY(128px)'))
  })

  it('renders only the rows on screen of a 600-item Active on server list, quickly', async () => {
    const mods: ModMap = {}
    for (let i = 0; i < 600; i++) mods[String(10000 + i)] = [{ id: `Mod${i}`, name: `Mod number ${i}`, enabled: i % 7 !== 0 }]
    prime({ mods, groups: [{ ...VEHICLES, modIds: ['Mod1', 'Mod2', 'Mod3'] }] })
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await screen.findByRole('navigation', { name: 'Mod management sections' })

    const startedAt = performance.now()
    await act(async () => {
      await openModsView('Active on server')
    })
    await screen.findByText(/IDs enabled/)
    const elapsed = performance.now() - startedAt

    const rows = screen.getAllByText(/^Mod number \d+$/).length
    expect(rows).toBeGreaterThan(5)
    expect(rows).toBeLessThan(150)
    // A generous ceiling for a loaded test machine.
    expect(elapsed).toBeLessThan(3000)
  })
})
