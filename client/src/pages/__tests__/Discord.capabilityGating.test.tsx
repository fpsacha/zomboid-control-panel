import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// bug-hunt-2026-08-27 Tier-3 capability-gating sweep: every mutating route
// this page touches sits behind one whole-file server gate --
// router.use(requirePermission("integrations.manage")) in
// server/routes/discord.js:41, no per-route override, confirmed by reading
// the full route list -- so this page is genuinely page-grain, unlike
// Mods/Servers/ServerSetup/Chat (all mixed). Before this change Discord.tsx
// had zero client-side capability awareness at all: every mutating button
// was enabled purely on its own loading/validation state, so a role lacking
// integrations.manage saw a fully clickable dashboard that would 403 on
// every action. Each handler now has an early-return guard
// (`if (!canManageIntegrations) return`) as the real gate, in addition to
// the disabled+DisabledReason affordance on the visible control -- per
// tonight's floor rule (Angela's Console.tsx finding) that a disabled
// button alone is not a gate. This file asserts the ACTION is unreachable
// (mocked API never called on click), not merely that a control renders
// with the disabled attribute.

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
    discordApi: {
      ...actual.discordApi,
      getStatus: vi.fn(),
      getConfig: vi.fn(),
      getWebhookEvents: vi.fn(),
      getPermissions: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      testToken: vi.fn(),
      sendTestMessage: vi.fn(),
      resetConfig: vi.fn(),
      updateConfig: vi.fn(),
      updateWebhookEvents: vi.fn(),
      updatePermissions: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)
const stop = vi.mocked(discordApi.stop)
const testToken = vi.mocked(discordApi.testToken)
const sendTestMessage = vi.mocked(discordApi.sendTestMessage)
const resetConfig = vi.mocked(discordApi.resetConfig)
const updateConfig = vi.mocked(discordApi.updateConfig)
const updateWebhookEvents = vi.mocked(discordApi.updateWebhookEvents)
const updatePermissions = vi.mocked(discordApi.updatePermissions)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDiscord() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

async function setUpConfiguredRunningBot() {
  getStatus.mockResolvedValue({ running: true, configured: true })
  getConfig.mockResolvedValue({
    token: null,
    hasToken: true,
    guildId: '123456789012345678',
    adminRoleId: '',
    modRoleId: '',
    channelId: '234567890123456789',
    autoStart: true,
    chatRelayEnabled: true,
    chatRelayChannelId: '',
    chatRelayScope: 'public',
  })
  getWebhookEvents.mockResolvedValue({ events: {} })
  getPermissions.mockResolvedValue({ permissions: {} })
}

describe('Discord.tsx: every mutating control gates on integrations.manage', () => {
  it('disables every action and never reaches the API when the role lacks integrations.manage', async () => {
    mockCan = () => false
    await setUpConfiguredRunningBot()

    renderDiscord()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())

    // bug-hunt-2026-08-27 (Angela's fixture-masking finding): Verify
    // Token's disabled expression is `testing || !token ||
    // !canManageIntegrations` -- with no token typed, `!token` alone
    // already disables it regardless of the capability check, so a denied
    // assertion here would pass even with the capability gate deleted
    // entirely. Type a token first so canManageIntegrations is the only
    // thing left disabling it.
    fireEvent.change(screen.getByLabelText(/Bot Token/), { target: { value: 'fake-token-value' } })

    const buttonNames = ['Stop Bot', 'Send Test', 'Verify Token', 'Wipe Discord Setup', 'Save Changes', 'Save Events', 'Save Permissions']
    const buttons = buttonNames.map((name) => screen.getByRole('button', { name }))
    for (const button of buttons) {
      expect(button).toBeDisabled()
    }

    for (const button of buttons) {
      fireEvent.click(button)
    }

    expect(stop).not.toHaveBeenCalled()
    expect(sendTestMessage).not.toHaveBeenCalled()
    expect(testToken).not.toHaveBeenCalled()
    // handleResetConfig's guard sits before the confirm() dialog -- a denied
    // click must never even open the "are you sure" prompt.
    expect(resetConfig).not.toHaveBeenCalled()
    expect(updateConfig).not.toHaveBeenCalled()
    expect(updateWebhookEvents).not.toHaveBeenCalled()
    expect(updatePermissions).not.toHaveBeenCalled()
  })

  it('enables every action when the role holds integrations.manage', async () => {
    mockCan = () => true
    await setUpConfiguredRunningBot()

    renderDiscord()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())

    const buttonNames = ['Stop Bot', 'Send Test', 'Wipe Discord Setup', 'Save Events', 'Save Permissions']
    for (const name of buttonNames) {
      expect(screen.getByRole('button', { name })).not.toBeDisabled()
    }
    // Verify Token / Save Changes stay disabled here for reasons unrelated
    // to capability (no token typed yet / canSaveConfig's own validation) --
    // covered by their own existing tests, not this file's concern.
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): the test above stopped
  // at not.toBeDisabled() for all 5 buttons -- none were ever clicked, so a
  // regression in any one handler's own body (as opposed to the shared
  // canManageIntegrations disabled expression) would have sat green. Each
  // button's real destination is a distinct mock, proven individually.
  // Wipe Discord Setup goes last -- its handler clears every field and
  // resets setupStep, which would otherwise destabilize the DOM this test
  // still needs for the other four.
  it('reaches each of the 5 real APIs when clicked, holding integrations.manage', async () => {
    mockCan = () => true
    await setUpConfiguredRunningBot()

    renderDiscord()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Send Test' }))
    await waitFor(() => expect(sendTestMessage).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Save Events' }))
    await waitFor(() => expect(updateWebhookEvents).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Save Permissions' }))
    await waitFor(() => expect(updatePermissions).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Stop Bot' }))
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Wipe Discord Setup' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wipe Discord Settings' }))
    await waitFor(() => expect(resetConfig).toHaveBeenCalledTimes(1))
  })
})
