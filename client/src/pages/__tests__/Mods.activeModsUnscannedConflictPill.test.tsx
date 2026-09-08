import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// honest-unknown-renderings-have-no-regression-coverage (2026-09-09): the
// second and last member of tonight's three-state-collapse family named as
// unguarded. d37e8367's own commit message named exactly why it skipped a
// dedicated test ("this file's Active Mods sub-tab sits behind two more
// layers of tab/sub-tab state ... on top of a multi-ID workshop-group
// fixture, ... judged disproportionate") -- reusing the fixture pattern
// Mods.capabilityGating.test.tsx already established for mounting this page
// makes that cost much lower than it looked in isolation, which is why this
// card exists: pay the fixture cost once, not per fix.
//
// Fix under test: the Active Mods sub-tab's per-mod conflict-toggle pill
// used to fall through to the same bg-success/bg-muted styling a genuinely
// scanned-and-cleared mod gets whenever `conflicts` was still null (no scan
// has ever run) -- so an unscanned mod displayed identically to a confirmed-
// clean one. Fixed by gating the "clean" branch on `scanned = conflicts !==
// null` and falling back to the file's own dashed/muted "unverified"
// treatment when unscanned (Mods.tsx ~4711).
//
// Break-verified: removing the `!scanned ? (...) :` branch (restoring the
// pre-fix two-way `mod.enabled ? 'bg-success/15 ...' : 'bg-muted/15 ...'`
// fallback) makes the first test below fail -- the pill picks up
// 'bg-success/15' and no 'border-dashed' while `conflicts` is still null.
// Restored after confirming the predicted failure.

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
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
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
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const getActive = vi.mocked(serversApi.getActive)

// Two mod IDs delivered by one Workshop item -- the "multi-ID workshop-group"
// fixture the original commit called out as the standing cost of this test.
const WORKSHOP_MOD_MAP = {
  '111222333': [
    { id: 'ModA', name: 'Mod A', enabled: true },
    { id: 'ModB', name: 'Mod B', enabled: true },
  ],
}

function primeReadMocks(cachedConflicts: unknown) {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  getStatus.mockResolvedValue({
    totalModsTracked: 2,
    workshopAcfConfigured: false,
    autoRestartEnabled: false,
  } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ['ModA', 'ModB'],
    workshopIds: ['111222333'],
    maps: [],
    totalMods: 2,
    workshopModMap: WORKSHOP_MOD_MAP,
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(cachedConflicts as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
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

async function goToActiveModsDetailed() {
  // activeDensity defaults to 'compact', which hides chips on an
  // uninspected row (showChips = !isSingle && (detailed || isInspected)) --
  // force 'detailed' so the pill renders without also needing a click to
  // inspect the group.
  localStorage.setItem('zcp:mods:active:density', JSON.stringify('detailed'))
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
  fireEvent.click(await screen.findByText('Active on server'))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

// The Active Mods row's own mono workshop-ID/name inspector panel (the
// xl:grid-cols-[...]_21rem right column) also renders each mod id as plain
// text, so a bare getByText('ModA') matches two elements -- scope to the one
// that is actually inside the toggle pill.
async function findPill(modId: string): Promise<HTMLElement> {
  const candidates = await screen.findAllByText(modId)
  const pill = candidates
    .map((el) => el.closest('button.mod-toggle-pill'))
    .find((el): el is HTMLElement => el !== null)
  if (!pill) throw new Error(`no mod-toggle-pill found for ${modId}`)
  return pill
}

describe('Mods.tsx Active Mods sub-tab: unscanned conflict pills do not render identically to confirmed-clean ones', () => {
  it('conflicts never scanned (getCachedConflicts resolves null) -- pill gets the dashed/unverified treatment, not bg-success', async () => {
    primeReadMocks(null)
    renderMods()
    await goToActiveModsDetailed()

    const pill = await findPill('ModA')
    expect(pill.className).toMatch(/border-dashed/)
    expect(pill.className).not.toMatch(/bg-success/)
  })

  it('break-verify control: a real scan with zero conflicts (getCachedConflicts resolves non-null) -- pill reads confirmed-clean bg-success, not dashed', async () => {
    primeReadMocks({
      totalConflicts: 0,
      identicalSkipped: 0,
      pairs: [],
      totalPairs: 0,
      modsScanned: 2,
      missingDeps: [],
      modLoadOrder: ['ModA', 'ModB'],
    })
    renderMods()
    await goToActiveModsDetailed()

    const pill = await findPill('ModA')
    expect(pill.className).toMatch(/bg-success\/15/)
    expect(pill.className).not.toMatch(/border-dashed/)
  })
})
