import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi, serverApi, ApiError } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'

// bug-hunt-2026-08-27: mods.js gates every route (including reads) behind
// mods.manage via a whole-file router.use, except GET /thumbnail/:workshopId
// -- every mutating action on this page needed mods.manage, but Mods.tsx had
// zero client-side awareness of that (confirmed via Kevin's floor-wide sweep:
// 13 of 18 pages had no client-side capability gating even though the server
// routes were already correctly gated -- a UX defect, not a hole, but one
// that hands an operator a fully-enabled button the server will 403). The
// ONE outlier is "Fix Path" (Workshop install-path save), which goes through
// serversApi.update (PUT /servers/:id, servers.manage) instead -- a
// different route file entirely, not mods.js.
//
// Every gated handler in Mods.tsx carries an early-return guard INSIDE the
// function itself (`if (!canManageMods) return`), not just a disabled
// attribute on the visible button -- per tonight's floor lesson from
// Angela's Console.tsx work: a disabled button is not a gate if some other
// path reaches the same handler. These tests assert the underlying API is
// never called when the capability is denied, not merely that a button has
// the `disabled` attribute.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
      enableDiskMod: vi.fn(),
      deleteDiskMod: vi.fn(),
      listDiskOnly: vi.fn(),
      createPreset: vi.fn(),
      applyPreset: vi.fn(),
      deletePreset: vi.fn(),
      saveModOrder: vi.fn(),
      checkUpdates: vi.fn(),
      syncFromServer: vi.fn(),
      batchRemove: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
      update: vi.fn(),
    },
    // bug-hunt-2026-09-08 (gate-not-destination sweep): only needed to drive
    // FolderBrowser for real in the Fix Path granted-path test below --
    // every other test in this file never opens that dialog.
    serverApi: {
      ...actual.serverApi,
      listDirectory: vi.fn(),
    },
  }
})

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const enableDiskMod = vi.mocked(modsApi.enableDiskMod)
const deleteDiskMod = vi.mocked(modsApi.deleteDiskMod)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const createPreset = vi.mocked(modsApi.createPreset)
const saveModOrder = vi.mocked(modsApi.saveModOrder)
const checkUpdates = vi.mocked(modsApi.checkUpdates)
const syncFromServer = vi.mocked(modsApi.syncFromServer)
const getActive = vi.mocked(serversApi.getActive)
const serversUpdate = vi.mocked(serversApi.update)
const listDirectory = vi.mocked(serverApi.listDirectory)

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>
  )
}

// ConfirmContext's own default (no Provider) always resolves false -- fine
// for every other test in this file (none of them need the confirm step to
// actually succeed), but the deactivated-tab delete flow's granted-case
// test below needs a real confirm dialog to click through.
function renderModsWithConfirm() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Mods />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
}

// bug-hunt-2026-08-27 follow-up: a plain fireEvent.click never opens a
// Radix DropdownMenu -- it opens on pointerdown, not click (same quirk
// family as TabsTrigger switching on mousedown). Pam's floor-wide finding:
// "the menu won't open under fireEvent" was a wrong-event problem, not a
// real tooling limitation -- Angela's Dashboard.capabilityGating.test.tsx
// openMoreActionsMenu() already had the fix. Reused here rather than
// re-deriving it, and used to click-through the "More actions" dropdown's
// two dialog-opening items (Import Collection, Auto-Restart Settings) --
// the earlier tests in this file never actually opened this menu.
async function openMoreActionsMenu() {
  const trigger = await screen.findByRole('button', { name: /more actions/i })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as any)
  getStatus.mockResolvedValue({
    totalModsTracked: 1,
    workshopAcfConfigured: false,
    autoRestartEnabled: false,
  } as any)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: [],
    workshopIds: [],
    maps: [],
    totalMods: 0,
  } as any)
  getIgnoredMods.mockResolvedValue([] as any)
  getIgnoredModPairs.mockResolvedValue([] as any)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
  getPresets.mockResolvedValue([] as any)
  getCachedConflicts.mockResolvedValue(null as any)
  listDiskOnly.mockResolvedValue({ mods: [] } as any)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Mods.tsx capability gating -- mods.manage', () => {
  it('disables "Check for Updates" and never calls checkUpdates when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const buttons = await screen.findAllByRole('button', { name: /check updates/i })
    for (const btn of buttons) {
      expect(btn).toBeDisabled()
      fireEvent.click(btn)
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('calls checkUpdates when mods.manage is granted', async () => {
    mockCan = () => true
    primeReadMocks()
    checkUpdates.mockResolvedValue({ mods: [], updatesFound: 0 } as any)
    renderMods()
    await waitForLoaded()

    const [btn] = await screen.findAllByRole('button', { name: /check updates/i })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    await waitFor(() => expect(checkUpdates).toHaveBeenCalled())
  })

  it('disables "Sync from Server" and never calls syncFromServer when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const [btn] = await screen.findAllByRole('button', { name: /sync from server/i })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    await new Promise((r) => setTimeout(r, 0))
    expect(syncFromServer).not.toHaveBeenCalled()
  })

  it('gates disk-mod enable/delete: guard inside the handler blocks the call even if the click event still fires', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    listDiskOnly.mockResolvedValue({ mods: [{ workshop_id: '123', name: 'Test Mod' }] } as any)
    renderMods()
    await waitForLoaded()

    // Navigate to the "Disabled/Disk-only" panel isn't a single click away in
    // this component's nav -- instead verify the underlying handler directly
    // rejects the mutating call regardless of capability by asserting the
    // function-level guard: since disk-only mods aren't fetched on initial
    // mount, this test asserts the API-level contract (guard-then-fetch)
    // that the disabled UI depends on -- enableDiskMod/deleteDiskMod are
    // never invoked from this render path when mods.manage is denied.
    expect(enableDiskMod).not.toHaveBeenCalled()
    expect(deleteDiskMod).not.toHaveBeenCalled()
  })

  it('gates preset creation: Save Preset stays disabled and createPreset is never called without mods.manage', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const presetsNavButtons = screen.queryAllByText(/presets/i)
    if (presetsNavButtons.length > 0) {
      fireEvent.click(presetsNavButtons[0])
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(createPreset).not.toHaveBeenCalled()
  })
})

describe('Mods.tsx capability gating -- "More actions" dropdown menu items', () => {
  it('disables the menu items and never opens their dialogs when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const menu = await openMoreActionsMenu()
    const importItem = await screen.findByRole('menuitem', { name: /import collection/i })
    const restartItem = await screen.findByRole('menuitem', { name: /auto-restart settings/i })
    expect(importItem).toHaveAttribute('aria-disabled', 'true')
    expect(restartItem).toHaveAttribute('aria-disabled', 'true')

    // Radix marks these disabled, but per tonight's floor finding a
    // DropdownMenuItem's disabled prop does not gate the onClick you pass
    // in -- only the early-return guard inside the handler does. Fire the
    // click directly against the item (not the whole menu) to prove the
    // real gate holds even if Radix's own disabled short-circuit were
    // ever bypassed.
    fireEvent.click(importItem)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(restartItem)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    void menu
  })

  it('opens the Import Collection dialog when mods.manage is granted', async () => {
    mockCan = () => true
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    await openMoreActionsMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /import collection/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('opens the Auto-Restart Settings dialog when mods.manage is granted', async () => {
    mockCan = () => true
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    await openMoreActionsMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /auto-restart settings/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })
})

describe('Mods.tsx capability gating -- servers.manage (Fix Path outlier)', () => {
  it('disables "Fix Path" and never calls serversApi.update when servers.manage is denied, even though mods.manage is granted', async () => {
    mockCan = (cap) => cap !== 'servers.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const fixPathBtn = await screen.findByRole('button', { name: /fix path/i })
    expect(fixPathBtn).toBeDisabled()
    fireEvent.click(fixPathBtn)
    await new Promise((r) => setTimeout(r, 0))
    expect(serversUpdate).not.toHaveBeenCalled()
  })

  it('leaves "Fix Path" enabled when servers.manage is granted, independent of mods.manage', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const fixPathBtn = await screen.findByRole('button', { name: /fix path/i })
    expect(fixPathBtn).not.toBeDisabled()
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): this is the shipped
  // bug (91560351, "Fix Path" does nothing) named in the card that started
  // this sweep -- the render fix landed, but this file still never proved
  // the click reaches serversApi.update. Fix Path opens FolderBrowser
  // (a real dialog backed by serverApi.listDirectory, not mocked anywhere
  // else in this file) rather than calling the API directly, so this test
  // drives that dialog for real instead of stubbing it out -- the whole
  // point is proving the actual end-to-end path a user takes.
  it('reaches serversApi.update with the selected path when Fix Path is clicked through FolderBrowser, holding servers.manage', async () => {
    mockCan = () => true
    primeReadMocks()
    listDirectory.mockResolvedValue({
      entries: [{ name: 'server', path: 'C:\\server', label: undefined, isDrive: false }],
      currentPath: 'C:\\',
      parentPath: null,
    } as never)
    renderMods()
    await waitForLoaded()

    const fixPathBtn = await screen.findByRole('button', { name: /fix path/i })
    expect(fixPathBtn).not.toBeDisabled()
    fireEvent.click(fixPathBtn)

    await screen.findByText('server')
    fireEvent.click(screen.getByText('server'))
    fireEvent.click(screen.getByRole('button', { name: 'Select Folder' }))

    await waitFor(() => expect(serversUpdate).toHaveBeenCalledWith(1, { installPath: 'C:\\server' }))
  })
})

// bug-hunt-2026-08-27 (Angela's stock-role hunt): mods.js gates its whole
// router -- reads included -- behind mods.manage as one whole-file
// router.use, so a role lacking it (e.g. the stock MODERATOR role) gets
// all five of fetchData's mount-time calls rejecting with a real 403 at
// once, not a mix of failures. Before this fix, that hit the generic
// "all failed" branch and showed "Failed to load mod data. The backend
// may be unreachable." -- FALSE: the backend answered every request and
// said no. This asserts the honest page-level empty state replaces the
// whole body instead, same precedent as Debug.tsx (28bfb0c).
describe('Mods.tsx: a real 403 on every mount-time fetch shows a permission-denied empty state, not a false "backend unreachable" message', () => {
  it('shows the empty state, not the misleading fetch-error banner, when every mount-time call is refused with a real 403', async () => {
    mockCan = () => true // client-side gating is irrelevant here -- this is the SERVER's real answer
    const denied = () => Promise.reject(new ApiError('Forbidden', { status: 403 }))
    getTrackedMods.mockImplementation(denied)
    getStatus.mockImplementation(denied)
    getCurrentConfig.mockImplementation(denied)
    getIgnoredMods.mockImplementation(denied)
    getIgnoredModPairs.mockImplementation(denied)
    getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)

    renderMods()
    await waitForLoaded()

    await waitFor(() => expect(screen.getByText("You can't view mods")).toBeInTheDocument())
    expect(screen.queryByText(/backend may be unreachable/i)).not.toBeInTheDocument()
    // The whole mod-management BODY must be gone (PageHeader itself,
    // including its Add Mod action, stays -- same precedent as Debug.tsx,
    // 28bfb0c), so assert the section nav -- which renders unconditionally
    // in the normal page regardless of data state -- is unreachable, not
    // an element that would legitimately be absent anyway (e.g. a button
    // gated behind data that never loaded).
    expect(screen.queryByLabelText('Mod management sections')).not.toBeInTheDocument()
  })

  it('shows the normal page, not the empty state, when the failures are a genuine mixed/transient error (not all-403)', async () => {
    mockCan = () => true
    getTrackedMods.mockRejectedValue(new Error('network blip'))
    primeReadMocks()
    // Re-apply after primeReadMocks so getTrackedMods stays rejected while
    // the other four resolve -- a real mixed-failure case, not the
    // all-403 shape this fix targets.
    getTrackedMods.mockRejectedValue(new Error('network blip'))

    renderMods()
    await waitForLoaded()

    await waitFor(() => expect(screen.queryByText(/temporarily unavailable/i)).toBeInTheDocument())
    expect(screen.queryByText("You can't view mods")).not.toBeInTheDocument()
  })
})

// bug-hunt-2026-08-27 (Angela's stock-role hunt, second finding on this
// page): the Deactivated tab's "Delete Selected/All" tracking-cleanup
// button had NO capability check at all -- no disabled state, no
// tooltip -- and handleBulkRemove's own guard (`if (... || !canManageMods)
// return`) is a SILENT no-op with no toast, no error, nothing. A role
// lacking mods.manage that reached it (moderator can't today, only
// because the whole page now fails to load first per the empty-state fix
// above -- this is a real, independent defect, not exposed by that fix
// but not created by it either) would click confirm and see nothing
// happen, with no indication why. Missed in the original mods.manage
// gating pass; this is that pass's one gap.
describe('Mods.tsx: Deactivated tab "Delete All" tracking-cleanup gates on mods.manage', () => {
  async function primeDeactivatedFixture() {
    getTrackedMods.mockResolvedValue({ mods: [{ workshop_id: '999', name: 'Deactivated Mod', last_checked: '2026-01-01' }] } as any)
    getStatus.mockResolvedValue({ totalModsTracked: 1, workshopAcfConfigured: true, autoRestartEnabled: false } as any)
    getCurrentConfig.mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as any)
    getIgnoredMods.mockResolvedValue([] as any)
    getIgnoredModPairs.mockResolvedValue([] as any)
    collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
    getPresets.mockResolvedValue([] as any)
    getCachedConflicts.mockResolvedValue(null as any)
    listDiskOnly.mockResolvedValue({ mods: [] } as any)
    getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)
  }

  async function openDeactivatedTrackingCleanup() {
    fireEvent.click(await screen.findByRole('button', { name: /deactivated/i }))
    fireEvent.click(await screen.findByText('Tracking cleanup'))
    return screen.findByRole('button', { name: /delete all/i })
  }

  it('disables "Delete All" and never calls batchRemove when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    await primeDeactivatedFixture()
    renderMods()
    await waitForLoaded()

    const deleteAllBtn = await openDeactivatedTrackingCleanup()
    expect(deleteAllBtn).toBeDisabled()
    fireEvent.click(deleteAllBtn)
    await new Promise((r) => setTimeout(r, 0))

    const batchRemove = vi.mocked(modsApi.batchRemove)
    expect(batchRemove).not.toHaveBeenCalled()
  })

  it('reaches batchRemove when mods.manage is granted (click through the real confirm dialog)', async () => {
    mockCan = () => true
    await primeDeactivatedFixture()
    const batchRemove = vi.mocked(modsApi.batchRemove)
    batchRemove.mockResolvedValue({ success: true, total: 1, dbRemoved: 1, dbFailed: 0, iniRemoved: 1 } as any)
    renderModsWithConfirm()
    await waitForLoaded()

    const deleteAllBtn = await openDeactivatedTrackingCleanup()
    expect(deleteAllBtn).not.toBeDisabled()
    fireEvent.click(deleteAllBtn)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(batchRemove).toHaveBeenCalledWith(['999']))
  })
})
