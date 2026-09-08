import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// bug-hunt-2026-08-27 Tier-3 capability-gating sweep, later split
// 2026-08-27 (operator ruling on ranked-bug #5): three genuinely different
// capabilities gate this one page. Sending on the 'server' channel (plain
// broadcast, POST /panel-bridge/message) requires server.world_events, the
// same capability that gates weather/zombie/climate tools. Sending on
// 'admin' or 'general' requires players.endanger_or_impersonate instead --
// carved out of server.world_events specifically because chat/general
// accepts an arbitrary custom author name, indistinguishable in the chat
// log from that player having said it themselves (see Chat.tsx's own
// comment). Managing the quick-broadcast preset list requires
// panel.settings instead. None of TECHNICIAN/MODERATOR hold
// players.endanger_or_impersonate or panel.settings by default, so this is
// a live stock-role gap, not a hypothetical one.
//
// The Enter-key path is the sharpest risk here (Angela's Console.tsx
// finding tonight: a disabled button alone is not a gate if a keypress
// reaches the handler directly) -- sendMessage() is called both by the
// Send button's onClick AND by handleKeyDown's Enter path, and
// handleAddPreset/handleSaveEdit/handleDeletePreset are each reachable by
// both a button click and their own input's Enter-key handler. The real
// guards live inside sendMessage() and persistPresets() themselves, so
// they cover every entry point; this file proves that by firing Enter
// directly, not just clicking the visible button.
//
// The channel Select is a Radix Select -- Players.capabilityGating.test.tsx
// already confirmed empirically (not just suspected) that a real pointer
// interaction on a Radix Select throws in jsdom (target.hasPointerCapture
// is not a function, then scrollIntoView is not a function). Mocking
// '@/components/ui/select' below with a native <select> is the workaround:
// it preserves Chat.tsx's REAL per-channel canSendChat logic untouched
// (nothing about the capability gate itself is mocked), it just swaps the
// picker widget so a channel switch is drivable via fireEvent.change.
vi.mock('@/components/ui/select', () => {
  function findAriaLabel(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const label = (child.props as { 'aria-label'?: string })['aria-label']
      if (label) found = label
    })
    return found
  }
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select
        aria-label={findAriaLabel(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

// jsdom doesn't implement scrollIntoView -- Chat.tsx calls it on every
// chatHistory update to auto-scroll the message log, which is unrelated to
// capability gating but throws in every test here without a stub. No prior
// test file for this page existed to have already discovered this.
Element.prototype.scrollIntoView = vi.fn()

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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendToServerChat: vi.fn(),
      sendToAdminChat: vi.fn(),
      sendToGeneralChat: vi.fn(),
      getChatInfo: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const sendToServerChat = vi.mocked(panelBridgeApi.sendToServerChat)
const sendToAdminChat = vi.mocked(panelBridgeApi.sendToAdminChat)
const sendToGeneralChat = vi.mocked(panelBridgeApi.sendToGeneralChat)
const getChatInfo = vi.mocked(panelBridgeApi.getChatInfo)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChat() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Chat />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

async function setUp() {
  getPlayers.mockResolvedValue({ players: [] } as Awaited<ReturnType<typeof playersApi.getPlayers>>)
  getAppSettings.mockResolvedValue({ chatPresets: ['Test preset'] } as unknown as Awaited<ReturnType<typeof configApi.getAppSettings>>)
  getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)
}

describe("Chat.tsx: sending on the 'server' channel (default) gates on server.world_events", () => {
  it('disables Send and never reaches the API on click or Enter when the role lacks server.world_events', async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()

    renderChat()

    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    const sendButton = screen.getByRole('button', { name: 'send' })

    // bug-hunt-2026-08-27 (Angela's fixture-masking finding): Send's
    // disabled expression is `sending || !message.trim() ||
    // !canSendChat` -- with the input still empty, `!message.trim()`
    // alone already disables it regardless of the capability check, so
    // asserting disabled here (before typing) would pass even with the
    // capability gate deleted entirely. Type first, then assert.
    fireEvent.change(input, { target: { value: 'hello players' } })
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendToServerChat).not.toHaveBeenCalled()
  })

  it('enables Send and reaches the API when the role holds server.world_events', async () => {
    mockCan = () => true
    await setUp()
    sendToServerChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToServerChat>>)

    renderChat()

    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'hello players' } })

    const sendButton = screen.getByRole('button', { name: 'send' })
    expect(sendButton).not.toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToServerChat).toHaveBeenCalledWith('hello players', false))
  })
})

describe("Chat.tsx: sending on the 'admin'/'general' channels gates on players.endanger_or_impersonate, NOT server.world_events", () => {
  it("disables Send and never reaches the API on 'admin' when the role holds server.world_events but lacks players.endanger_or_impersonate", async () => {
    mockCan = (capability) => capability !== 'players.endanger_or_impersonate'
    await setUp()

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'admin' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    const sendButton = screen.getByRole('button', { name: 'send' })

    // Same fixture-masking risk as the 'server' channel tests above: type
    // first, so `!message.trim()` alone can't be the reason Send is
    // disabled.
    fireEvent.change(input, { target: { value: 'fake admin notice' } })
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendToAdminChat).not.toHaveBeenCalled()
  })

  it("disables Send and never reaches the API on 'general' when the role holds server.world_events but lacks players.endanger_or_impersonate", async () => {
    mockCan = (capability) => capability !== 'players.endanger_or_impersonate'
    await setUp()

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'general' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    const sendButton = screen.getByRole('button', { name: 'send' })

    fireEvent.change(input, { target: { value: 'pretend to be someone else' } })
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendToGeneralChat).not.toHaveBeenCalled()
  })

  it("enables Send and reaches the API on 'admin' when the role holds players.endanger_or_impersonate even without server.world_events", async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()
    sendToAdminChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToAdminChat>>)

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'admin' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'real admin notice' } })

    const sendButton = screen.getByRole('button', { name: 'send' })
    expect(sendButton).not.toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToAdminChat).toHaveBeenCalledWith('real admin notice'))
  })

  it("enables Send and reaches the API on 'general' when the role holds players.endanger_or_impersonate even without server.world_events", async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()
    sendToGeneralChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToGeneralChat>>)

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'general' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'hello from "Admin"' } })

    const sendButton = screen.getByRole('button', { name: 'send' })
    expect(sendButton).not.toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToGeneralChat).toHaveBeenCalledWith('hello from "Admin"', 'Admin'))
  })
})

describe('Chat.tsx: quick-broadcast preset management gates on panel.settings', () => {
  it('disables Add/Save/Delete and never reaches the API, even via Enter, when the role lacks panel.settings', async () => {
    mockCan = (capability) => capability !== 'panel.settings'
    await setUp()

    renderChat()

    await screen.findByText('Test preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit presets' }))

    // bug-hunt-2026-08-27 (Angela's fixture-masking finding): Add's
    // disabled expression is `!newPresetDraft.trim() ||
    // !canManagePresets` -- with the draft still empty,
    // `!newPresetDraft.trim()` alone already disables it regardless of
    // the capability check. Type first, then assert.
    const addInput = screen.getByPlaceholderText('add a new quick message…')
    fireEvent.change(addInput, { target: { value: 'A new preset' } })
    expect(screen.getByLabelText('Add preset')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Add preset'))
    fireEvent.keyDown(addInput, { key: 'Enter' })

    expect(screen.getByLabelText('Delete preset 1')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Delete preset 1'))

    expect(updateAppSettings).not.toHaveBeenCalled()
  })

  it('enables Add/Save/Delete when the role holds panel.settings', async () => {
    mockCan = () => true
    await setUp()
    updateAppSettings.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof configApi.updateAppSettings>>)

    renderChat()

    await screen.findByText('Test preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit presets' }))

    expect(screen.getByLabelText('Delete preset 1')).not.toBeDisabled()

    // "Add preset" is also legitimately disabled on an empty draft --
    // unrelated to capability -- so only assert its non-disabled state
    // once there is something to add.
    const addInput = screen.getByPlaceholderText('add a new quick message…')
    fireEvent.change(addInput, { target: { value: 'A new preset' } })
    expect(screen.getByLabelText('Add preset')).not.toBeDisabled()
    fireEvent.click(screen.getByLabelText('Add preset'))

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ chatPresets: ['Test preset', 'A new preset'] }))
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): the test above only
  // clicked through Add -- Delete preset 1 was asserted not.toBeDisabled()
  // and never clicked, so a regression in handleDeletePreset's own wiring
  // (as opposed to its disabled prop) would have sat green. Delete has its
  // own extra step none of the other preset actions do: a confirm() dialog
  // between the click and persistPresets(), so this is not just a copy of
  // the Add assertion.
  it('reaches updateAppSettings with the preset removed when Delete preset 1 is clicked and confirmed, holding panel.settings', async () => {
    mockCan = () => true
    await setUp()
    updateAppSettings.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof configApi.updateAppSettings>>)

    renderChat()

    await screen.findByText('Test preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit presets' }))

    const deleteButton = screen.getByLabelText('Delete preset 1')
    expect(deleteButton).not.toBeDisabled()
    fireEvent.click(deleteButton)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Preset' }))

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ chatPresets: [] }))
  })
})

// wired-no-ui-2026-08-30: getChatInfo (GET /panel-bridge/chat/info) had a
// live, gated route and Lua handler but zero client callers. Its two live
// fields (chatServerAvailable/rconFallback, logical opposites of the same
// fact) tell the operator whether sendToServerChat/sendToAdminChat/
// sendToGeneralChat above are actually reaching the game's native
// ChatServer API or silently degrading to player:Say/RCON -- never
// observable before this. Its third field (availableChats, a hardcoded
// description list) is API documentation, not live state, and was
// deliberately not surfaced -- same reasoning as the /commands route in the
// 65-action UI-reachability audit.
describe('Chat.tsx: chat delivery-method status (getChatInfo)', () => {
  it('shows nothing before the fetch resolves and nothing if it fails -- no seeded default', async () => {
    mockCan = () => true
    await setUp()
    getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)

    renderChat()

    await screen.findByRole('textbox', { name: 'Chat message' })
    expect(screen.queryByText('chat delivery: native')).not.toBeInTheDocument()
    expect(screen.queryByText(/chat delivery: RCON fallback/)).not.toBeInTheDocument()
  })

  it('shows "native" when the native ChatServer API is available', async () => {
    mockCan = () => true
    await setUp()
    getChatInfo.mockResolvedValue({
      success: true,
      data: { chatServerAvailable: true, rconFallback: false },
    } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)

    renderChat()

    await waitFor(() => expect(screen.getByText('chat delivery: native')).toBeInTheDocument())
    expect(screen.queryByText(/RCON fallback/)).not.toBeInTheDocument()
  })

  it('shows the RCON fallback warning when the native ChatServer API is not available', async () => {
    mockCan = () => true
    await setUp()
    getChatInfo.mockResolvedValue({
      success: true,
      data: { chatServerAvailable: false, rconFallback: true },
    } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)

    renderChat()

    await waitFor(() => expect(screen.getByText(/chat delivery: RCON fallback/)).toBeInTheDocument())
    expect(screen.queryByText('chat delivery: native')).not.toBeInTheDocument()
  })

  it('is not fetched at all when the role lacks server.world_events', async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()

    renderChat()

    await screen.findByRole('textbox', { name: 'Chat message' })
    expect(getChatInfo).not.toHaveBeenCalled()
  })
})
