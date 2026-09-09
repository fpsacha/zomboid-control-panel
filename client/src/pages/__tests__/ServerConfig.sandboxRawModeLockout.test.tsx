import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// sandbox-range-lockout, 2026-09-09 (bernanas in #suggestions): "IF YOU SAVE
// IT ONCE WITH A VALUE OUT OF RANGE YOU THEN CAN'T SAVE IT AGAIN" -- reported
// against the RAW MODE workaround the operator publicly recommended for a
// stale client-side sandbox range table.
//
// Mechanism: invalidSandboxSettings (ServerConfig.tsx) is computed from
// SANDBOX_SCHEMA (a hardcoded client range table) against `sandboxData` --
// the STRUCTURED state -- regardless of which editor mode is active.
// handleSaveSandbox()'s own internal gate already scopes this check to
// `editorMode === 'structured'` (raw saves bypass validation by design, the
// same way hasSandboxChanges already treats raw/structured as independent
// tracks). The Save button's `disabled` prop never got that same scoping --
// so once ANY SANDBOX_SCHEMA-tracked field in the loaded/persisted sandbox
// data sits outside our hardcoded range, the button stays disabled in BOTH
// modes forever, even though raw mode's own save path was never going to be
// blocked by that check. Editing the raw textarea can't clear the flag
// either, since raw edits only ever touch `rawContent`, never `sandboxData`.
// Net effect: a value saved once via raw mode (which is unclamped) can
// permanently lock the Save button for both editor modes on every future
// visit, with no way back out via the workaround the operator told users to
// use.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: () => {}, off: () => {} }),
}))

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// SANDBOX_SCHEMA (serverConfigSchema.ts) declares ZombiesCountBeforeDelete
// as { min: 10, max: 500, section: 'ZombieConfig' } -- 600 is out of range
// per that hardcoded table (whether or not it's out of range in the actual
// running game, which is a separate, live-queried question -- see the
// Mod Settings tab's getAllSandboxOptions path for how that one stays
// accurate across patches).
function sandboxDataWithOutOfRangeZombieDeleteCount() {
  return {
    VERSION: 1,
    settings: {},
    ZombieLore: {},
    ZombieConfig: { ZombiesCountBeforeDelete: 600 },
    MultiplierConfig: {},
    Map: {},
    Basement: {},
  }
}

function renderServerConfigOnSandboxTab() {
  return render(
    <MemoryRouter initialEntries={['/server-config?tab=sandbox']}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: an out-of-range persisted sandbox value must not lock raw-mode Save forever', () => {
  it('disables Save in structured mode (correct, unchanged behavior) but NOT in raw mode after an edit', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getActive.mockResolvedValue({ server: null } as never)
    getPaths.mockResolvedValue({
      exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
    } as never)
    getSandbox.mockResolvedValue({ sandbox: sandboxDataWithOutOfRangeZombieDeleteCount() } as never)
    getRaw.mockResolvedValue({
      content: 'ZombieConfig.ZombiesCountBeforeDelete = 600\n',
      path: '/a',
      filename: 'SandboxVars.lua',
    } as never)

    renderServerConfigOnSandboxTab()

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())

    // Structured mode's own toolbar Save button starts disabled: no edits
    // yet (hasSandboxChanges is false), so this alone doesn't distinguish
    // the bug -- confirmed disabled for the right (no-op) reason first.
    const saveButton = await screen.findByRole('button', { name: /save & reload/i })
    expect(saveButton).toBeDisabled()

    // Switch to raw mode and make a genuine edit (hasSandboxChanges must
    // become true via rawContent !== originalRawContent, the same
    // independent track handleSaveSandbox's internal gate already trusts).
    const rawToggle = screen.getByRole('button', { name: /^raw$/i })
    fireEvent.click(rawToggle)
    await waitFor(() => expect(getRaw).toHaveBeenCalledWith('sandbox'))

    const textarea = await screen.findByDisplayValue(/ZombiesCountBeforeDelete = 600/)
    fireEvent.change(textarea, {
      target: { value: 'ZombieConfig.ZombiesCountBeforeDelete = 300\n' },
    })

    // This is the reported lockout: a genuine, unsaved raw-mode edit still
    // leaves Save disabled, because the button's disabled condition reads
    // `invalidSandboxSettings` unconditionally -- computed from the
    // untouched structured `sandboxData`, which still carries the
    // out-of-range persisted value regardless of what raw mode's own
    // textarea now says. Both the toolbar Save button AND the sticky
    // unsaved-changes bar's Save button share this exact condition
    // (ServerConfig.tsx ~3048 and ~4161) -- assert both.
    const saveButtonsRaw = screen.getAllByRole('button', { name: /save & reload/i })
    expect(saveButtonsRaw.length).toBeGreaterThan(0)
    for (const button of saveButtonsRaw) {
      expect(button).not.toBeDisabled()
    }
  })
})
