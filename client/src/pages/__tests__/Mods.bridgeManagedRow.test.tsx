import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import en from '@/locales/en/bridgeDelivery.json'
import { openModsView } from './modsNav'

// PanelBridge delivered by the Steam Workshop (spec §4.11): GET
// /mods/current-config names the item in `bridgeManaged`, and the "Active on
// server" list marks that entry "Panel bridge" and locks its enable and
// remove controls, with the badge's own text as the reason. Reordering stays
// allowed (Load Order's move controls and drag): the bridge's position in
// Mods= changes nothing, and the server's ini guard (routes/mods.js
// protectBridgeIniEntries) keeps reorders and only puts removed entries
// back. That guard is the real enforcement; this lock only explains it.

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
      toggleModId: vi.fn(),
      batchToggleModIds: vi.fn(),
      removeFromIni: vi.fn(),
      saveModOrder: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

// jsdom doesn't implement scrollIntoView; Load Order's move controls call it.
Element.prototype.scrollIntoView = vi.fn()

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const toggleModId = vi.mocked(modsApi.toggleModId)
const batchToggleModIds = vi.mocked(modsApi.batchToggleModIds)
const removeFromIni = vi.mocked(modsApi.removeFromIni)
const saveModOrder = vi.mocked(modsApi.saveModOrder)
const getActive = vi.mocked(serversApi.getActive)

const BRIDGE_WS = '3712345678'
const BRIDGE_MOD = 'ZCPB'
const BRIDGE_NAME = 'Zomboid Control Panel Bridge'
const OTHER_WS = '2200148440'
const OTHER_MOD = 'SomeOtherMod'
const EXTRA_WS = '2169435993'
const EXTRA_MOD = 'ExtraMod'
// One item with two mod ids: "Active on server" opens filtered to such items,
// and its Multi-ID toggle (only offered when one exists) shows the rest.
const PACK_WS = '1111111111'

// The bridge sits in the middle of the load order, so every move control
// has somewhere to go and "enabled" means the lock left it alone.
const MOD_IDS = [OTHER_MOD, BRIDGE_MOD, EXTRA_MOD, 'PackA', 'PackB']

function primeReadMocks({ bridgeDownloaded = true }: { bridgeDownloaded?: boolean } = {}) {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  getStatus.mockResolvedValue({ totalModsTracked: 0, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: MOD_IDS,
    // Bridge first: the inspector opens on the first row.
    workshopIds: [BRIDGE_WS, OTHER_WS, EXTRA_WS, PACK_WS],
    maps: [],
    totalMods: MOD_IDS.length,
    workshopModMap: {
      // Before Steam has downloaded the item the server knows no mod ids for
      // it, and its Mods= entry shows as "not on disk" instead.
      [BRIDGE_WS]: bridgeDownloaded ? [{ id: BRIDGE_MOD, name: BRIDGE_NAME, enabled: true }] : [],
      [OTHER_WS]: [{ id: OTHER_MOD, name: 'Some Other Mod', enabled: true }],
      [EXTRA_WS]: [{ id: EXTRA_MOD, name: 'Extra Mod', enabled: true }],
      [PACK_WS]: [
        { id: 'PackA', name: 'Pack A', enabled: true },
        { id: 'PackB', name: 'Pack B', enabled: true },
      ],
    },
    bridgeManaged: { modId: BRIDGE_MOD, workshopId: BRIDGE_WS },
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(null as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
  toggleModId.mockResolvedValue({ success: true } as never)
  batchToggleModIds.mockResolvedValue({ success: true } as never)
  removeFromIni.mockResolvedValue({ success: true } as never)
  saveModOrder.mockResolvedValue({ message: 'Mod load order saved successfully', modCount: MOD_IDS.length } as never)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openActiveOnServer() {
  renderMods()
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
  await openModsView('Active on server')
}

// A Radix DropdownMenu opens on pointerdown, not click.
async function openKebab(name: string) {
  const trigger = await screen.findByRole('button', { name: `More actions for ${name}` })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

const rowOf = (el: HTMLElement) => el.closest('.perf-list-row') as HTMLElement
const reasonWrapperOf = (el: HTMLElement) => el.closest('[tabindex="0"]') as HTMLElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Mods.tsx: the PanelBridge Workshop entry in "Active on server"', () => {
  it('badges the bridge row only, and locks its toggle with the badge text as the reason', async () => {
    primeReadMocks()
    await openActiveOnServer()

    const bridgeToggle = await screen.findByRole('checkbox', { name: `Disable ${BRIDGE_NAME}` })
    const otherToggle = screen.getByRole('checkbox', { name: 'Disable Some Other Mod' })
    const bridgeRow = rowOf(bridgeToggle)
    const otherRow = rowOf(otherToggle)

    expect(within(bridgeRow).getByText(en.mods.badge)).toBeInTheDocument()
    expect(within(otherRow).queryByText(en.mods.badge)).toBeNull()
    expect(within(rowOf(screen.getByRole('checkbox', { name: 'Disable Extra Mod' }))).queryByText(en.mods.badge)).toBeNull()

    expect(bridgeToggle).toBeDisabled()
    expect(otherToggle).toBeEnabled()

    // The disabled toggle explains itself, in the badge's words.
    expect(screen.queryByText(en.mods.badgeTooltip)).toBeNull()
    fireEvent.focus(reasonWrapperOf(bridgeToggle))
    expect((await screen.findAllByText(en.mods.badgeTooltip)).length).toBeGreaterThan(0)

    fireEvent.click(bridgeToggle)
    await new Promise((r) => setTimeout(r, 0))
    expect(toggleModId).not.toHaveBeenCalled()

    // Control: the lock is the bridge's alone.
    fireEvent.click(otherToggle)
    await waitFor(() => expect(toggleModId).toHaveBeenCalledWith(OTHER_MOD, false))
  })

  it("disables both kebab removes on the bridge row, but not Copy workshop ID or the other rows' removes", async () => {
    primeReadMocks()
    await openActiveOnServer()

    const menu = await openKebab(BRIDGE_NAME)
    // A disabled item says why under its label, so its name starts with the label.
    const removeFromIniItem = within(menu).getByRole('menuitem', { name: /^Remove from server INI/ })
    const removeFromServerItem = within(menu).getByRole('menuitem', { name: /^Remove from server(?! INI)/ })
    expect(removeFromIniItem).toHaveAttribute('aria-disabled', 'true')
    expect(removeFromServerItem).toHaveAttribute('aria-disabled', 'true')
    expect(within(menu).getByRole('menuitem', { name: 'Copy Workshop ID' })).not.toHaveAttribute('aria-disabled')

    expect(removeFromIniItem).toHaveTextContent(en.mods.badgeTooltip)
    expect(removeFromServerItem).toHaveTextContent(en.mods.badgeTooltip)

    fireEvent.click(removeFromIniItem)
    fireEvent.click(removeFromServerItem)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(removeFromIni).not.toHaveBeenCalled()

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    const otherMenu = await openKebab('Some Other Mod')
    expect(within(otherMenu).getByRole('menuitem', { name: 'Remove from server INI' })).not.toHaveAttribute('aria-disabled')
    expect(within(otherMenu).getByRole('menuitem', { name: 'Remove from server' })).not.toHaveAttribute('aria-disabled')
  })

  it("locks the inspector's toggles and Remove from server INI while it shows the bridge, and only then", async () => {
    primeReadMocks()
    await openActiveOnServer()

    await screen.findByRole('checkbox', { name: `Disable ${BRIDGE_NAME}` })
    const inspector = document.querySelector('aside') as HTMLElement
    expect(within(inspector).getByText(en.mods.badge)).toBeInTheDocument()
    expect(within(inspector).getByRole('button', { name: 'Disable all' })).toBeDisabled()
    expect(within(inspector).getByRole('button', { name: new RegExp(BRIDGE_MOD) })).toBeDisabled()
    const remove = within(inspector).getByRole('button', { name: 'Remove from server INI' })
    expect(remove).toBeDisabled()
    fireEvent.focus(reasonWrapperOf(remove))
    expect((await screen.findAllByText(en.mods.badgeTooltip)).length).toBeGreaterThan(0)

    fireEvent.click(within(inspector).getByRole('button', { name: 'Disable all' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(batchToggleModIds).not.toHaveBeenCalled()

    // Inspect another item: nothing there is locked.
    fireEvent.click(screen.getByText('Some Other Mod'))
    await waitFor(() => expect(within(inspector).queryByText(en.mods.badge)).toBeNull())
    expect(within(inspector).getByRole('button', { name: 'Disable all' })).toBeEnabled()
    expect(within(inspector).getByRole('button', { name: 'Remove from server INI' })).toBeEnabled()
  })

  it('locks the "not on disk" entry too, before Steam has downloaded the item', async () => {
    primeReadMocks({ bridgeDownloaded: false })
    await openActiveOnServer()

    const removeOrphan = await screen.findByRole('button', { name: `Remove ${BRIDGE_MOD}` })
    expect(removeOrphan).toBeDisabled()
    const orphanRow = removeOrphan.closest('div.group') as HTMLElement
    expect(within(orphanRow).getByText(en.mods.badge)).toBeInTheDocument()

    fireEvent.click(removeOrphan)
    await new Promise((r) => setTimeout(r, 0))
    expect(toggleModId).not.toHaveBeenCalled()
  })

  it('keeps reordering the bridge allowed in Load Order: every move control, drag, and Save Order', async () => {
    primeReadMocks()
    renderMods()
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
    await screen.findByText(EXTRA_MOD)

    for (const name of ['to the top', 'up', 'down', 'to the bottom']) {
      expect(screen.getByRole('button', { name: `Move ${BRIDGE_MOD} ${name}` })).toBeEnabled()
    }
    const bridgeRow = screen.getByRole('button', { name: `Move ${BRIDGE_MOD} up` }).closest('[data-load-order-index]') as HTMLElement
    expect(bridgeRow).toHaveAttribute('draggable', 'true')
    expect(screen.getByRole('button', { name: /auto-sort/i })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: `Move ${BRIDGE_MOD} to the top` }))
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    await waitFor(() => expect(saveModOrder).toHaveBeenCalledWith([BRIDGE_MOD, OTHER_MOD, EXTRA_MOD, 'PackA', 'PackB']))
  })
})
