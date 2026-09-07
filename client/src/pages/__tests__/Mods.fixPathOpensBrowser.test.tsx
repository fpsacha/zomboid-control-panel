import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// bug-hunt-2026-09-07 (Discord report, #panel-general, user "carl": "when
// pressing fix path nothing happens"): <FolderBrowser> -- the dialog "Fix
// path" exists to open -- was nested inside the pendingRestart-only banner,
// several hundred lines away from the button itself, instead of being an
// always-mounted page-level dialog like every other one on this page. For
// anyone who is NOT mid-restart when they click Fix Path (the ordinary
// case, including the reporting user's), handleOpenWorkshopBrowser ran to
// completion and called setWorkshopBrowserOpen(true), but there was no
// <FolderBrowser> anywhere in the tree to read that state -- an offered
// action that can never succeed, invisible from the button's own code
// (onClick fires, no throw, no rejected promise) and invisible from
// Mods.capabilityGating.test.tsx's existing "Fix Path" coverage (which only
// asserts the button's disabled state, never that clicking it opens
// anything). This proves the actual user-visible contract: click the
// button while NOT mid-restart, the folder browser must actually open.

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
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const getActive = vi.mocked(serversApi.getActive)
const listDirectory = vi.mocked(serverApi.listDirectory)

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Mods.tsx: "Fix Path" actually opens the folder browser', () => {
  it('opens the folder browser dialog on click when there is no pending restart', async () => {
    getTrackedMods.mockResolvedValue({ mods: [] } as any)
    // pendingRestart deliberately absent/false -- the ordinary state a real
    // operator is in when their Workshop path is simply misconfigured, not
    // mid-restart. This is the exact state the bug was invisible in.
    getStatus.mockResolvedValue({
      totalModsTracked: 1,
      workshopAcfConfigured: false,
      autoRestartEnabled: false,
      pendingRestart: false,
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
    // Never needs to resolve for this test -- the dialog's title/header
    // render immediately from the `open` prop, independent of the
    // directory listing's own load state.
    listDirectory.mockReturnValue(new Promise(() => {}))

    renderMods()
    await waitForLoaded()

    const fixPathBtn = await screen.findByRole('button', { name: /fix path/i })
    fireEvent.click(fixPathBtn)

    await waitFor(() => expect(getActive).toHaveBeenCalled())
    await screen.findByRole('dialog')
    expect(listDirectory).toHaveBeenCalled()
  })
})
