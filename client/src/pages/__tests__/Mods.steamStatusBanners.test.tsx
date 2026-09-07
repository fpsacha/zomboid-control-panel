import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'

// hunt-wave7-2026-08-29: modChecker.js's getStatus() has carried
// steamApiHealthy/lastSteamApiFailureAt/removedWorkshopIds for a while with
// ZERO consumers anywhere in client/src (confirmed by Pam's grep) -- not
// even declared on the ModStatus interface. This file covers the two new
// quiet/warning indicators built on those fields: a Steam-API-unreachable
// notice (quiet, dismissible, re-surfaces on the next failed cycle) and a
// removed-from-Workshop warning (actionable -- names the mods, offers
// Remove) that must never collapse into the same signal as a transient
// outage.

// toast() renders into a <Toaster/> this test's render tree doesn't mount
// (it lives at the app root, not under Mods) -- asserting on DOM text for it
// hangs findByText for the full vitest testTimeout rather than failing fast
// (Events.utilitiesPersistWarning.test.tsx's own toastSpy convention).
// Spying on useToast directly is the established pattern for this codebase.
const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
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
      batchRemove: vi.fn(),
      checkUpdates: vi.fn(),
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
const batchRemove = vi.mocked(modsApi.batchRemove)
const checkUpdates = vi.mocked(modsApi.checkUpdates)

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Mods />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const BASE_STATUS = {
  totalModsTracked: 1,
  totalModsInWorkshop: 1,
  updatesAvailable: 0,
  lastCheck: null,
  lastUpdateDetected: null,
  autoRestartEnabled: false,
  running: true,
  workshopAcfConfigured: false,
  workshopAcfPath: null,
  checkInterval: 1800000,
  modsNeedingUpdate: [],
  restartWarningMinutes: 5,
  delayIfPlayersOnline: false,
  maxDelayMinutes: 30,
  pendingRestart: false,
  steamApiHealthy: true,
  lastSteamApiFailureAt: null,
  removedWorkshopIds: [] as string[],
  unknownWorkshopIds: [] as Array<{ id: string; resultCode: number }>,
}

function primeReadMocks(statusOverrides: Partial<typeof BASE_STATUS> = {}, trackedMods: any[] = []) {
  getTrackedMods.mockResolvedValue({ mods: trackedMods } as any)
  getStatus.mockResolvedValue({ ...BASE_STATUS, ...statusOverrides } as any)
  getCurrentConfig.mockResolvedValue({
    configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0,
  } as any)
  getIgnoredMods.mockResolvedValue([] as any)
  getIgnoredModPairs.mockResolvedValue([] as any)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
  getPresets.mockResolvedValue([] as any)
  getCachedConflicts.mockResolvedValue(null as any)
  listDiskOnly.mockResolvedValue({ mods: [] } as any)
}

const STEAM_BANNER_TEXT = /Steam Workshop couldn't be reached/i
const REMOVED_BANNER_KEY = /no longer exists on the Steam Workshop|no longer exist on the Steam Workshop/i

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  toastSpy.mockClear()
  localStorage.clear()
})

describe('Mods -- Steam API health indicator', () => {
  it('does not render when steamApiHealthy is true', async () => {
    primeReadMocks({ steamApiHealthy: true, lastSteamApiFailureAt: null })
    renderMods()
    await screen.findAllByText(/mods/i)
    expect(screen.queryByText(STEAM_BANNER_TEXT)).not.toBeInTheDocument()
  })

  it('renders immediately on a single failed cycle, and dismissing hides it', async () => {
    primeReadMocks({ steamApiHealthy: false, lastSteamApiFailureAt: '2026-08-29T20:00:00.000Z' })
    renderMods()

    expect(await screen.findByText(STEAM_BANNER_TEXT)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /dismiss steam api warning/i }))

    expect(screen.queryByText(STEAM_BANNER_TEXT)).not.toBeInTheDocument()
    expect(localStorage.getItem('pz-mods-steam-api-issue-dismissed')).toBe(
      '2026-08-29T20:00:00.000Z',
    )
  })

  it('a NEW failed cycle (lastSteamApiFailureAt advanced) re-surfaces even though an earlier one was dismissed', async () => {
    localStorage.setItem('pz-mods-steam-api-issue-dismissed', '2026-08-29T20:00:00.000Z')
    primeReadMocks({ steamApiHealthy: false, lastSteamApiFailureAt: '2026-08-29T20:30:00.000Z' })
    renderMods()

    expect(await screen.findByText(STEAM_BANNER_TEXT)).toBeInTheDocument()
  })
})

describe('Mods -- removed-from-Workshop warning', () => {
  it('does not render when removedWorkshopIds is empty', async () => {
    primeReadMocks({ removedWorkshopIds: [] })
    renderMods()
    await screen.findAllByText(/mods/i)
    expect(screen.queryByText(REMOVED_BANNER_KEY)).not.toBeInTheDocument()
  })

  it('names the removed mod (resolved from tracked mods) and offers a Remove action', async () => {
    primeReadMocks(
      { removedWorkshopIds: ['123456789'] },
      [{
        id: 1, workshop_id: '123456789', name: 'Definitely Gone Mod',
        last_updated: '', last_checked: null, update_available: 0, created_at: '',
      }],
    )
    renderMods()

    expect(await screen.findByText('Definitely Gone Mod')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove definitely gone mod from the server/i })).toBeInTheDocument()
  })

  it('falls back to the raw workshop id when the removed item has no tracked-mod name', async () => {
    primeReadMocks({ removedWorkshopIds: ['999999999'] }, [])
    renderMods()

    expect(await screen.findByText('999999999')).toBeInTheDocument()
  })

  it('clicking Remove opens the confirm dialog and, on confirm, calls batchRemove with that workshop id', async () => {
    batchRemove.mockResolvedValue({} as any)
    primeReadMocks(
      { removedWorkshopIds: ['555555555'] },
      [{
        id: 1, workshop_id: '555555555', name: 'Ghost Mod',
        last_updated: '', last_checked: null, update_available: 0, created_at: '',
      }],
    )
    renderMods()

    fireEvent.click(await screen.findByRole('button', { name: /remove ghost mod from the server/i }))

    const confirmButton = await screen.findByRole('button', { name: /^remove$/i })
    fireEvent.click(confirmButton)

    await waitFor(() => expect(batchRemove).toHaveBeenCalledWith(['555555555']))
  })
})

describe('Mods -- unknown Steam result (third state, must not collapse into removed or healthy)', () => {
  it('shows the raw resultCode, not invented prose', async () => {
    primeReadMocks({ unknownWorkshopIds: [{ id: '111222333', resultCode: 15 }] })
    renderMods()

    expect(await screen.findByText(/111222333/)).toBeInTheDocument()
    expect(screen.getByText(/code 15/i)).toBeInTheDocument()
  })

  it('the SAME batch producing a removed id and an unknown id renders both, in their own distinct sections, matching Pam\'s server-side discriminating fixture', async () => {
    primeReadMocks(
      {
        removedWorkshopIds: ['999888777'],
        unknownWorkshopIds: [{ id: '111222333', resultCode: 15 }],
      },
      [{
        id: 1, workshop_id: '999888777', name: 'Actually Removed Mod',
        last_updated: '', last_checked: null, update_available: 0, created_at: '',
      }],
    )
    renderMods()

    // The removed one: named, in the warning-style actionable list.
    expect(await screen.findByText('Actually Removed Mod')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove actually removed mod from the server/i })).toBeInTheDocument()

    // The unknown one: raw id + code, in the separate neutral note --
    // and specifically NOT rendered as a removed/actionable item (no
    // Remove button naming it, since it was never confirmed gone).
    expect(screen.getByText(/111222333/)).toBeInTheDocument()
    expect(screen.getByText(/code 15/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove 111222333/i })).not.toBeInTheDocument()
  })

  it('does not render when unknownWorkshopIds is empty', async () => {
    primeReadMocks({ unknownWorkshopIds: [] })
    renderMods()
    await screen.findAllByText(/mods/i)
    expect(screen.queryByText(/code \d/i)).not.toBeInTheDocument()
  })
})

// 2026-09-07 lifecycle-actions hardening, GitHub #148: a non-Steam/GOG
// install has no Workshop ACF file, ever -- that used to render as a
// persistent destructive/red "Workshop path missing" banner and, on Check
// Updates, a red "Update Check Failed / Workshop ACF file not found" toast.
// Neither is a misconfiguration the operator caused; it's indistinguishable
// server-side from a legitimate SteamCMD install with zero downloaded
// Workshop mods. These prove the informational rewording actually replaces
// the alarming one, not just that new text exists somewhere.
describe('Mods -- Workshop ACF not found is informational, not an alarm (GitHub #148)', () => {
  it('renders the status-bar note as neutral text, not the old "path missing" wording', async () => {
    primeReadMocks({ workshopAcfConfigured: false })
    renderMods()

    expect(await screen.findByText('No Workshop data')).toBeInTheDocument()
    expect(screen.queryByText(/workshop path missing/i)).not.toBeInTheDocument()
  })

  it('Check Updates fires an informational toast (not the raw "Workshop ACF file not found" destructive error) when the backend reports MODS_CHECK_UPDATES_ACF_NOT_FOUND', async () => {
    primeReadMocks({ workshopAcfConfigured: false })
    checkUpdates.mockResolvedValue({
      updated: false,
      mods: [],
      error: 'Workshop ACF file not found',
      code: 'MODS_CHECK_UPDATES_ACF_NOT_FOUND',
    } as any)
    renderMods()

    fireEvent.click(await screen.findByRole('button', { name: /check updates/i }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Workshop Data Unavailable',
        description: expect.stringMatching(/expected for a non-Steam install/i),
        variant: 'default',
      }),
    )
    // The old alarming copy must not appear in the call at all.
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Update Check Failed' }),
    )
  })

  it('a genuine, uncoded update-check failure still fires the destructive error toast unchanged', async () => {
    primeReadMocks({ workshopAcfConfigured: true })
    checkUpdates.mockResolvedValue({
      updated: false,
      mods: [],
      error: 'Steam API request failed',
    } as any)
    renderMods()

    fireEvent.click(await screen.findByRole('button', { name: /check updates/i }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Update Check Failed',
          description: 'Steam API request failed',
          variant: 'destructive',
        }),
      ),
    )
  })
})
