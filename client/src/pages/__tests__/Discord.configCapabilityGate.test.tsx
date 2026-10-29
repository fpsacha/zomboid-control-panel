import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// Security sweep AUTHZ-3: PUT /discord/config now refuses a bot token,
// guild ID or admin role ID change unless the caller holds every capability
// behind the bot's commands, and a mod role ID change unless they hold those
// of the Moderator-tier commands (server/routes/discord.js). The page locks
// those fields to match, with a DisabledReason, and its save handler refuses
// a locked change even if one reached its state.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'integrator', capabilities: [] },
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
      updateConfig: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)
const updateConfig = vi.mocked(discordApi.updateConfig)

const GUILD = '123456789012345678'
const ADMIN_ROLE = '223456789012345678'
const CHANNEL = '234567890123456789'
const NEW_CHANNEL = '334567890123456789'
const NEW_ROLE = '434567890123456789'

const DEFAULT_TIERS = {
  status: 'everyone',
  players: 'everyone',
  save: 'moderator',
  broadcast: 'moderator',
  kick: 'moderator',
  start: 'admin',
  stop: 'admin',
  restart: 'admin',
  rcon: 'admin',
}

function holding(...capabilities: string[]) {
  return (capability: string) => capabilities.includes(capability)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderConfiguredBot(events: Record<string, { enabled: boolean; template: string }> = {}) {
  getStatus.mockResolvedValue({ running: true, configured: true })
  getConfig.mockResolvedValue({
    token: null,
    hasToken: true,
    guildId: GUILD,
    adminRoleId: ADMIN_ROLE,
    modRoleId: '',
    channelId: CHANNEL,
    autoStart: true,
    chatRelayEnabled: true,
    chatRelayChannelId: '',
    chatRelayScope: 'public',
  })
  getWebhookEvents.mockResolvedValue({ events })
  getPermissions.mockResolvedValue({ permissions: DEFAULT_TIERS })
  updateConfig.mockResolvedValue({ success: true })

  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())
}

const fields = () => ({
  token: screen.getByLabelText(/Bot Token/),
  guild: screen.getByLabelText(/Guild \(Server\) ID/),
  adminRole: screen.getByLabelText(/Admin Role ID/),
  modRole: screen.getByLabelText(/Moderator Role ID/),
  channel: screen.getByLabelText(/Notification \/ Chat Channel/),
})

describe('Discord.tsx: connection and role fields follow the PUT /config capability gate', () => {
  it('integrations.manage alone locks the token, guild and both role IDs but still saves the rest', async () => {
    mockCan = holding('integrations.manage')
    await renderConfiguredBot()

    const { token, guild, adminRole, modRole, channel } = fields()
    expect(token).toBeDisabled()
    expect(guild).toBeDisabled()
    expect(adminRole).toBeDisabled()
    expect(modRole).toBeDisabled()
    expect(channel).not.toBeDisabled()

    fireEvent.change(channel, { target: { value: NEW_CHANNEL } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
    const [sentToken, sentGuild, sentAdminRole, sentChannel, , sentModRole] = updateConfig.mock.calls[0]
    expect(sentToken).toBe('KEEP_EXISTING')
    expect(sentGuild).toBe(GUILD)
    expect(sentAdminRole).toBe(ADMIN_ROLE)
    expect(sentChannel).toBe(NEW_CHANNEL)
    expect(sentModRole).toBeUndefined()
  })

  it('the save handler refuses a locked change that reached its state anyway', async () => {
    mockCan = holding('integrations.manage')
    await renderConfiguredBot()

    fireEvent.change(fields().adminRole, { target: { value: NEW_ROLE } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('the Moderator-tier capabilities unlock the mod role ID only', async () => {
    mockCan = holding('integrations.manage', 'server.control', 'server.world_events', 'players.moderate')
    await renderConfiguredBot()

    const { token, guild, adminRole, modRole } = fields()
    expect(token).toBeDisabled()
    expect(guild).toBeDisabled()
    expect(adminRole).toBeDisabled()
    expect(modRole).not.toBeDisabled()

    fireEvent.change(modRole, { target: { value: NEW_ROLE } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
    expect(updateConfig.mock.calls[0][5]).toBe(NEW_ROLE)
  })

  it('every command capability unlocks every field', async () => {
    mockCan = holding(
      'integrations.manage',
      'players.view',
      'server.control',
      'server.world_events',
      'players.moderate',
      'rcon.execute',
    )
    await renderConfiguredBot()

    const { token, guild, adminRole, modRole, channel } = fields()
    for (const field of [token, guild, adminRole, modRole, channel]) {
      expect(field).not.toBeDisabled()
    }

    fireEvent.change(adminRole, { target: { value: NEW_ROLE } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
    expect(updateConfig.mock.calls[0][2]).toBe(NEW_ROLE)
  })
})

// Security audit R1-23: join, leave and death notifications post player data,
// so the server requires players.view to turn one on, change an enabled one's
// message, or move the notification channel while one is on.
describe('Discord.tsx: player notifications follow the players.view gate', () => {
  const JOIN_ON = { playerJoin: { enabled: true, template: '{player} joined' } }
  const switchFor = (key: string) => document.getElementById(`event-${key}`) as HTMLElement
  const GATE_TEXT = /Only someone who can view player info/

  it('without players.view: a player notification can be turned off, not on or edited, and the channel stays put', async () => {
    mockCan = holding('integrations.manage')
    await renderConfiguredBot(JOIN_ON)

    expect(fields().channel).toBeDisabled()
    expect(switchFor('playerJoin')).not.toBeDisabled()
    expect(switchFor('playerDeath')).toBeDisabled()
    expect(switchFor('playerLeave')).toBeDisabled()
    expect(switchFor('serverStart')).not.toBeDisabled()
    expect(document.getElementById('template-playerJoin')).toHaveAttribute('readonly')
    expect(screen.getAllByText(GATE_TEXT).length).toBeGreaterThan(0)
  })

  it('with players.view: every notification and the channel stay editable', async () => {
    mockCan = holding('integrations.manage', 'players.view')
    await renderConfiguredBot(JOIN_ON)

    expect(fields().channel).not.toBeDisabled()
    for (const key of ['playerJoin', 'playerDeath', 'playerLeave']) {
      expect(switchFor(key)).not.toBeDisabled()
    }
    expect(document.getElementById('template-playerJoin')).not.toHaveAttribute('readonly')
    expect(screen.queryByText(GATE_TEXT)).not.toBeInTheDocument()
  })
})
