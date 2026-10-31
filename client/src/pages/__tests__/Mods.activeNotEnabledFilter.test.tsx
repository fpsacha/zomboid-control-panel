import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openModsView } from './modsNav'

// "Active on server" says "170 of 186 IDs enabled" and gave no way to see which
// 16 are not. A "Not enabled (n)" chip now shows only the workshop items that
// have a mod ID which is not in the server config.

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

const m = vi.mocked(modsApi)

type ModMap = Record<string, Array<{ id: string; name: string; enabled: boolean }>>

// A: fully enabled. B: its only ID is not enabled. C: two IDs, one enabled.
const MIXED: ModMap = {
  '100': [{ id: 'ModA', name: 'Alpha Mod', enabled: true }],
  '200': [{ id: 'ModB', name: 'Bravo Mod', enabled: false }],
  '300': [
    { id: 'ModC1', name: 'Charlie One', enabled: true },
    { id: 'ModC2', name: 'Charlie Two', enabled: false },
  ],
}

function prime(workshopModMap: ModMap) {
  const ids = Object.values(workshopModMap).flat()
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 3, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ids.filter((i) => i.enabled).map((i) => i.id),
    workshopIds: Object.keys(workshopModMap),
    maps: [],
    totalMods: ids.length,
    workshopModMap,
  } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

async function openActive() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  await openModsView('Active on server')
  await screen.findByText(/IDs enabled/)
}

// The Multi-ID chip starts off; if a remembered filter left it on, it hides single-ID items; turn it off so every item is listed.
function showAllItems() {
  // The chip itself, not the "Remove filter" button of its remembered-filter tag.
  const multi = screen.queryByRole('button', { name: /^Multi-ID/ })
  if (multi?.getAttribute('aria-pressed') === 'true') fireEvent.click(multi)
}

const shown = (text: string) => screen.queryAllByText(text).length > 0

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Active on server: Not enabled filter', () => {
  it('counts the IDs that are not enabled and lists only the items that have one', async () => {
    prime(MIXED)
    await openActive()
    showAllItems()

    const chip = await screen.findByRole('button', { name: 'Not enabled (2)' })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(shown('Alpha Mod')).toBe(true)

    fireEvent.click(chip)

    await waitFor(() => expect(shown('Alpha Mod')).toBe(false))
    expect(shown('Bravo Mod')).toBe(true)
    expect(shown('Charlie One')).toBe(true) // a multi-ID item is listed under its first mod's name
    expect(screen.getByRole('button', { name: 'Not enabled (2)' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Not enabled (2)' }))
    await waitFor(() => expect(shown('Alpha Mod')).toBe(true))
  })

  it('narrows the default view to the not-enabled items (the Multi-ID filter is off by default)', async () => {
    prime(MIXED)
    await openActive()
    // Default view: every item, single-ID ones included.
    expect(shown('Bravo Mod')).toBe(true)
    expect(shown('Alpha Mod')).toBe(true)

    fireEvent.click(await screen.findByRole('button', { name: 'Not enabled (2)' }))

    await waitFor(() => expect(shown('Bravo Mod')).toBe(true))
    expect(shown('Alpha Mod')).toBe(false)
  })

  it('has no chip when every ID is enabled', async () => {
    prime({ '100': [{ id: 'ModA', name: 'Alpha Mod', enabled: true }] })
    await openActive()
    showAllItems()

    expect(screen.queryByRole('button', { name: /Not enabled/ })).toBeNull()
  })

  it('keeps the chip, and says so, when the filter was left on and everything is enabled now', async () => {
    localStorage.setItem('zcp:mods:active:notEnabledOnly', JSON.stringify(true))
    prime({ '100': [{ id: 'ModA', name: 'Alpha Mod', enabled: true }] })
    await openActive()
    showAllItems()

    expect(await screen.findByText(/Everything is enabled/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all workshop items' }))
    await waitFor(() => expect(shown('Alpha Mod')).toBe(true))
  })
})
