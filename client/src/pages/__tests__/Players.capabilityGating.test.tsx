import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'

// bug-hunt-2026-08-27: Players.tsx had zero client-side capability gating.
// Every mutating action reaches one of TWO distinct server gates --
// players.moderate (kick/ban/whitelist/access-level/notes) and
// players.gm_tools (teleport/spawn items+vehicles/xp/character import-export,
// AND godmode/invisible/noclip/heal -- these route through the generic
// PanelBridge passthrough, POST /panel-bridge/command, gated on
// players.gm_tools alone there per an operator ruling, bug-hunt-2026-08-27;
// see server/routes/panelBridge.js's GM_TOOLS_ONLY_ACTIONS). Kill joined
// the same players.gm_tools gate when wired up killplayer-ui-2026-08-30,
// but via its own dedicated route (not the passthrough) -- see that
// card's comment further down.
// Several actions have more than one render-level trigger (Kick and Ban each
// have an ActionTile AND a dossier quick-action button; Unban SteamID has
// THREE: a summary banner, a Banned-tab row button, and an ActionTile) --
// this test asserts every one of them, not just the first found, per the
// Scheduler.tsx restart-now lesson.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
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
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getWhitelist: vi.fn(),
      getPerks: vi.fn(),
      getAccessLevels: vi.fn(),
      getSteamIdBans: vi.fn(),
      getNotes: vi.fn(),
      getStats: vi.fn(),
      getExports: vi.fn(),
      getActivityLogs: vi.fn(),
      kick: vi.fn(),
      ban: vi.fn(),
      unban: vi.fn(),
      unbanSteamId: vi.fn(),
      banSteamId: vi.fn(),
      voiceBan: vi.fn(),
      addUser: vi.fn(),
      addAllowedSteamId: vi.fn(),
      removeAllowedSteamId: vi.fn(),
      removeFromWhitelist: vi.fn(),
      setAccessLevel: vi.fn(),
      saveNote: vi.fn(),
      deleteNote: vi.fn(),
      teleport: vi.fn(),
      addItem: vi.fn(),
      addVehicle: vi.fn(),
      addXp: vi.fn(),
      getExport: vi.fn(),
      deleteExport: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      exportCharacter: vi.fn(),
      importCharacter: vi.fn(),
      killPlayer: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const kick = vi.mocked(playersApi.kick)
const ban = vi.mocked(playersApi.ban)
const unban = vi.mocked(playersApi.unban)
const unbanSteamId = vi.mocked(playersApi.unbanSteamId)
const banSteamId = vi.mocked(playersApi.banSteamId)
const voiceBan = vi.mocked(playersApi.voiceBan)
const addUser = vi.mocked(playersApi.addUser)
const addAllowedSteamId = vi.mocked(playersApi.addAllowedSteamId)
const removeAllowedSteamId = vi.mocked(playersApi.removeAllowedSteamId)
const removeFromWhitelist = vi.mocked(playersApi.removeFromWhitelist)
const setAccessLevel = vi.mocked(playersApi.setAccessLevel)
const saveNote = vi.mocked(playersApi.saveNote)
const deleteNote = vi.mocked(playersApi.deleteNote)
const teleport = vi.mocked(playersApi.teleport)
const addItem = vi.mocked(playersApi.addItem)
const addVehicle = vi.mocked(playersApi.addVehicle)
const addXp = vi.mocked(playersApi.addXp)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const killPlayer = vi.mocked(panelBridgeApi.killPlayer)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// ConfirmContext's own default (no Provider) always resolves false, same
// precedent as Mods.capabilityGating.test.tsx's renderModsWithConfirm --
// only Kill needs a real confirm() dialog to click through.
function renderPlayersWithConfirm() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({
    success: true,
    available: true,
    accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'user', authType: 0, steamId: null, ownerId: null, displayName: null }],
    allowedSteamIds: ['76561198000000001'],
  })
  getPerks.mockResolvedValue({ catalog: [{ id: 'Sprinting', label: 'Sprinting', category: 'Combat' }] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [{ steamId: '76561198000000002', banned_at: new Date().toISOString() }] })
  getNotes.mockResolvedValue({ notes: [{ playerName: 'TestPlayer', note: 'existing note', tags: [], updated_at: new Date().toISOString() }] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

// Radix's DropdownMenuTrigger opens on pointerdown, not click (same quirk
// family as TabsTrigger switching on mousedown) -- a plain fireEvent.click
// never dispatches pointerdown, so the menu never opens and a query against
// its content sits at the suite's timeout instead of failing fast. Per
// Dashboard.capabilityGating.test.tsx's openMoreActionsMenu precedent.
async function openMoreActionsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More player actions' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

describe('Players.tsx: capability gating', () => {
  it('disables every gated trigger, and clicking any of them never calls the API, when the role holds none of the three capabilities', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    // Moderation tab -- players.moderate. Kick and Ban each have TWO
    // triggers (ActionTile + dossier quick-action button). The ActionTile's
    // accessible name is "Kick <description text>" (label + description are
    // both rendered inside the trigger <button>), so match by prefix.
    const kickButtons = screen.getAllByRole('button', { name: /^Kick\b/ })
    expect(kickButtons).toHaveLength(2)
    kickButtons.forEach(b => expect(b).toBeDisabled())

    const banButtons = screen.getAllByRole('button', { name: /^Ban\b/ })
    expect(banButtons).toHaveLength(2)
    banButtons.forEach(b => expect(b).toBeDisabled())

    expect(screen.getByRole('button', { name: /^Access Level\b/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Voice Ban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SteamID Ban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add User' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban SteamID' })).toBeDisabled()
    // Unban SteamID's second trigger: the summary banner (only rendered
    // because getSteamIdBans returned one ban).
    expect(screen.getByRole('button', { name: /View \d+ banned SteamIDs/ })).toBeDisabled()

    // Teleport is players.gm_tools, not players.moderate -- confirm it is
    // NOT disabled by the moderate-less role in this pass (asserted properly
    // in the gm_tools-only pass below; here we just confirm the two gates
    // are independent by not touching it).

    ;[...kickButtons, ...banButtons,
      screen.getByRole('button', { name: /^Access Level\b/ }),
      screen.getByRole('button', { name: 'Voice Ban' }),
      screen.getByRole('button', { name: 'SteamID Ban' }),
      screen.getByRole('button', { name: 'Add User' }),
      screen.getByRole('button', { name: 'Unban' }),
      screen.getByRole('button', { name: 'Unban SteamID' }),
    ].forEach(b => fireEvent.click(b))

    expect(kick).not.toHaveBeenCalled()
    expect(ban).not.toHaveBeenCalled()
    expect(setAccessLevel).not.toHaveBeenCalled()
    expect(voiceBan).not.toHaveBeenCalled()
    expect(banSteamId).not.toHaveBeenCalled()
    expect(addUser).not.toHaveBeenCalled()
    expect(unban).not.toHaveBeenCalled()
    expect(unbanSteamId).not.toHaveBeenCalled()

    // Banned tab -- third Unban SteamID trigger (per-row button). The
    // Moderation tab's own "Unban" ActionTile stays mounted in the right
    // panel throughout (it's a separate Tabs instance from the roster tabs
    // on the left), so disambiguate by the row button's title.
    fireEvent.click(screen.getByRole('button', { name: /Banned/ }))
    await waitFor(() => expect(screen.getByText('76561198000000002')).toBeInTheDocument(), { timeout: 3000 })
    const bannedRowUnban = screen.getAllByRole('button', { name: 'Unban' }).find(b => b.title?.includes('76561198000000002'))
    expect(bannedRowUnban).toBeDisabled()
    if (bannedRowUnban) fireEvent.click(bannedRowUnban)
    expect(unbanSteamId).not.toHaveBeenCalled()

    // Whitelist tab -- Add/Remove allowed SteamID, Remove account.
    fireEvent.click(screen.getByRole('button', { name: /Whitelist/ }))
    await waitFor(() => expect(screen.getByPlaceholderText('76561198XXXXXXXXX')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.change(screen.getByPlaceholderText('76561198XXXXXXXXX'), { target: { value: '76561198000000099' } })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addAllowedSteamId).not.toHaveBeenCalled()
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons.length).toBeGreaterThanOrEqual(2)
    removeButtons.forEach(b => expect(b).toBeDisabled())
    removeButtons.forEach(b => fireEvent.click(b))
    expect(removeAllowedSteamId).not.toHaveBeenCalled()
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    // Spawn tab -- players.gm_tools.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /Give XP/ })).toBeInTheDocument(), { timeout: 3000 })
    const giveItemButton = screen.getByText('Give items').closest('button')
    const spawnVehicleButton = screen.getByText('Spawn vehicles').closest('button')
    expect(giveItemButton).toBeDisabled()
    expect(spawnVehicleButton).toBeDisabled()
    // Give XP is NOT asserted here (bug-hunt-2026-08-27 gating-test audit):
    // it's also gated on !selectedPerk, and no perk is selected in this
    // fixture, so .toBeDisabled() would pass regardless of canGmTools --
    // exactly the fixture-masking shape Angela found on Dashboard's Wipe
    // button. Confirmed empirically (not assumed) that a real Select pick
    // can't drive this in jsdom either: fireEvent.pointerDown+click on the
    // combobox throws inside @radix-ui/react-select itself
    // (target.hasPointerCapture is not a function, then
    // candidate?.scrollIntoView is not a function) -- genuine missing jsdom
    // APIs, not a wrong-event mistake like Tabs/DropdownMenu turned out to
    // be. A real, confirmed (not just suspected) jsdom limitation for Radix
    // Select specifically, matching Kevin's original ChunkCleaner
    // reasoning -- see zzHighRiskDiagnostic's throwaway run for the full
    // stack. Give XP's canGmTools gate is untested here as a result; the
    // other three gm_tools triggers on this tab (Teleport, Give Items,
    // Spawn Vehicle) still are.
    if (giveItemButton) fireEvent.click(giveItemButton)
    if (spawnVehicleButton) fireEvent.click(spawnVehicleButton)
    expect(addItem).not.toHaveBeenCalled()
    expect(addVehicle).not.toHaveBeenCalled()
    // addXp not asserted here -- Give XP is never clicked in this test
    // (see the comment above), so it would be a vacuous assertion.

    // Powers tab -- players.gm_tools (see the dedicated split-capability
    // tests below for the bridge.command-is-irrelevant proof).
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    enableButtons.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(sendCommand).not.toHaveBeenCalled()
    // A disabled native <button> never fires onClick, so this proves the
    // click above never even reached the confirm() call that would have
    // opened the typed-confirmation dialog -- not just that killPlayer
    // wasn't invoked after some dialog step.
    expect(screen.queryByText('Kill player')).not.toBeInTheDocument()
    expect(killPlayer).not.toHaveBeenCalled()

    // Notes tab -- players.moderate.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Notes/ }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Note' })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: 'Save Note' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save Note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(saveNote).not.toHaveBeenCalled()
    expect(deleteNote).not.toHaveBeenCalled()

    // Teleport -- players.gm_tools, confirmed disabled here too since this
    // role holds neither gm_tools nor moderate.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Moderation' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Teleport\b/ })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /^Teleport\b/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Teleport\b/ }))
    expect(teleport).not.toHaveBeenCalled()
  })

  // bug-hunt-2026-08-31: a71c947a added `!canModerate` to the wrapping
  // <button disabled={...}> for Kick/Ban/Access Level (correctly blocking
  // the click, confirmed by the toBeDisabled() assertions above) but never
  // extended ActionTile's OWN `disabled` prop to match -- ActionTile is a
  // plain <div>, not a real form control, so its "looks disabled" signal is
  // entirely the manually-threaded `disabled` prop driving one Tailwind
  // class (`opacity-50`); DisabledReason (components/DisabledReason.tsx)
  // adds only a hover tooltip and cursor-not-allowed, no dimming of its own,
  // and nothing in the CSS resets a bare <button> to any dimmed appearance.
  // Net effect before this fix: an operator who holds no players.moderate
  // capability but HAS a player selected saw these three tiles at full
  // opacity -- indistinguishable from enabled -- while the click was
  // silently swallowed. This test targets the visual class directly, since
  // toBeDisabled() above only proves the click gate, not the appearance.
  it('dims Kick/Ban/Access Level ActionTiles (not just blocks the click) when a player is selected but the role lacks players.moderate', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    // index [0] of each pair is the dossier header's quick-action <Button>
    // (a real shadcn Button, which dims itself natively via its own
    // disabled: variant) -- index [1] is the ActionTile trigger this fix
    // targets, the one with no native disabled styling of its own.
    const kickTile = screen.getAllByRole('button', { name: /^Kick\b/ })[1].firstElementChild
    const banTile = screen.getAllByRole('button', { name: /^Ban\b/ })[1].firstElementChild
    const accessLevelTile = screen.getByRole('button', { name: /^Access Level\b/ }).firstElementChild
    expect(kickTile?.className).toContain('opacity-50')
    expect(banTile?.className).toContain('opacity-50')
    expect(accessLevelTile?.className).toContain('opacity-50')
  })

  it('enables gated triggers once the role holds the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    screen.getAllByRole('button', { name: /^Kick\b/ }).forEach(b => expect(b).not.toBeDisabled())
    screen.getAllByRole('button', { name: /^Ban\b/ }).forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: /^Access Level\b/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /^Teleport\b/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Voice Ban' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'SteamID Ban' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add User' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban SteamID' })).not.toBeDisabled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    screen.getAllByRole('button', { name: 'Enable' }).forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): the test above stopped
  // at not.toBeDisabled() for every one of these triggers -- none were ever
  // clicked, so a regression in any one handler's own body (as opposed to
  // the shared canModerate/canGmTools disabled expressions) would have sat
  // green. Each opens its own real dialog (some two-step, per Ban) and is
  // driven through to its own distinct mock, not just clicked and assumed.
  //
  // NAMED EXCLUSION: Access Level is NOT covered here. Its dialog's picker
  // is a real Radix Select, and Players.tsx's own denied-path test above
  // (search "Give XP") already established -- empirically, not by
  // assumption -- that fireEvent.pointerDown+click on a Radix Select throws
  // in jsdom (target.hasPointerCapture is not a function, then
  // scrollIntoView is not a function). Building a workaround for one
  // control here would be scaffolding out of proportion to what it proves;
  // Access Level's granted-path gate is left unproven by this file, same as
  // Give XP already is.
  // Kick and Ban both clear selectedPlayer on success (handleKick/handleBan's
  // own cleanup callbacks), which collapses the dossier panel -- kept as
  // their own tests rather than folded into the sequence below, since
  // running either one first would deselect the player out from under every
  // trigger that follows it.
  it('Kick reaches playersApi.kick when clicked through, holding players.moderate', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.click(screen.getAllByRole('button', { name: /^Kick\b/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Kick Player' }))
    await waitFor(() => expect(kick).toHaveBeenCalledWith('TestPlayer', ''))
  })

  it('Ban reaches playersApi.ban through its two-step confirm, holding players.moderate', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.click(screen.getAllByRole('button', { name: /^Ban\b/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Ban' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Ban Player' }))
    await waitFor(() => expect(ban).toHaveBeenCalledWith('TestPlayer', false, ''))
  })

  it('every remaining dialog-driven trigger reaches its own real API when clicked through, holding the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    // Voice Ban -- username pre-fills from selectedPlayer, nothing to type.
    // voiceBanEnabled defaults true, so the submit button reads "Mute".
    fireEvent.click(screen.getByRole('button', { name: 'Voice Ban' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mute' }))
    await waitFor(() => expect(voiceBan).toHaveBeenCalledWith('TestPlayer', true))

    // Unban -- username field is NOT pre-filled here (this ActionTile isn't
    // scoped to the selected player), type it.
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }))
    fireEvent.change(await screen.findByPlaceholderText('Enter username to unban...'), { target: { value: 'TestPlayer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban Player' }))
    await waitFor(() => expect(unban).toHaveBeenCalledWith('TestPlayer'))

    // Unban SteamID -- manual-entry fallback Input (not the Select list),
    // same field this dialog offers "or enter manually" for.
    fireEvent.click(screen.getByRole('button', { name: 'Unban SteamID' }))
    const unbanSteamIdInput = await screen.findByPlaceholderText('Enter Steam ID to unban...')
    fireEvent.change(unbanSteamIdInput, { target: { value: '76561198000000042' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban SteamID' }))
    await waitFor(() => expect(unbanSteamId).toHaveBeenCalledWith('76561198000000042'))

    // SteamID Ban -- exactly 17 digits required to enable submit.
    fireEvent.click(screen.getByRole('button', { name: 'SteamID Ban' }))
    fireEvent.change(await screen.findByPlaceholderText('76561198XXXXXXXXX'), { target: { value: '76561198000000099' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ban SteamID' }))
    await waitFor(() => expect(banSteamId).toHaveBeenCalledWith('76561198000000099', ''))

    // Add User -- username required, password optional.
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }))
    fireEvent.change(await screen.findByPlaceholderText('Enter username...'), { target: { value: 'newmod' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }))
    await waitFor(() => expect(addUser).toHaveBeenCalledWith('newmod', ''))

    // Teleport -- a quick-location preset fills x/y/z in one click, no
    // manual numeric typing needed; target field is pre-filled too.
    fireEvent.click(screen.getByRole('button', { name: /^Teleport\b/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Muldraugh' }))
    fireEvent.click(screen.getByRole('button', { name: 'Teleport' }))
    await waitFor(() => expect(teleport).toHaveBeenCalledWith('TestPlayer', { x: 10500, y: 9700, z: 0 }))
  })

  // Kill needs a real ConfirmProvider (typed-confirmation dialog), unlike
  // every other trigger above -- kept as its own test rather than folding
  // it into the one above, since it's the only one needing a different
  // render setup.
  it('Kill reaches panelBridgeApi.killPlayer once the target name is typed into the confirm dialog', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayersWithConfirm()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    fireEvent.click(await screen.findByRole('button', { name: 'Kill' }))

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText(/type.*TestPlayer/i), { target: { value: 'TestPlayer' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill player' }))

    await waitFor(() => expect(killPlayer).toHaveBeenCalledWith('TestPlayer'))
  })

  // bug-hunt-2026-08-27, operator ruling (supersedes server commit c3083d5
  // from earlier the same day): setGodMode/setInvisible/setNoclip/healPlayer
  // are gated on players.gm_tools ALONE again, not "gm_tools AND
  // bridge.command". c3083d5's combined requirement was itself a fix for a
  // real problem (these four were reachable on bridge.command alone, no
  // gm_tools check at all, since commit 8bd0edc) -- but the operator ruled
  // requiring BOTH was never the intended fix: bridge.command was only ever
  // an accidental side effect of these four routing through the generic
  // passthrough, and requiring it denies Technician (who holds gm_tools but
  // not bridge.command by default) the GM tools it's meant to have. This
  // test pair now proves the opposite direction from before: gm_tools alone
  // must be SUFFICIENT (not just necessary, which the deny-all test above
  // already covers), and bridge.command alone must remain insufficient
  // (gm_tools is still the real gate, not dropped entirely).
  //
  // killPlayer-ui-2026-08-30: Kill joined this same players.gm_tools gate
  // when it was wired up (see server/routes/panelBridge.js's POST
  // /players/:username/kill, requirePermission("players.gm_tools") --
  // the same capability the four above are checked against, not a new
  // one). Asserted alongside the original four in both tests below rather
  // than in a separate pair, since it is the same gate, not a new one.
  it('bridge.command alone is not sufficient for the GM-tools four -- players.gm_tools is still required', async () => {
    mockCan = (capability) => capability === 'bridge.command'
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    enableButtons.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(sendCommand).not.toHaveBeenCalled()
    expect(killPlayer).not.toHaveBeenCalled()
  })

  it('players.gm_tools alone is sufficient for the GM-tools four, without bridge.command (Technician regains all four)', async () => {
    mockCan = (capability) => capability === 'players.gm_tools'
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()

    // Teleport still reachable too -- confirms gm_tools wasn't accidentally
    // narrowed anywhere else on the page by this change.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Moderation' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Teleport\b/ })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /^Teleport\b/ })).not.toBeDisabled()
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): the test above stopped
  // at not.toBeDisabled() for all three Enable buttons and Heal -- none were
  // ever clicked, so a regression in handleGodMode/handleInvisible/
  // handleNoclip/handleHealPlayer's own bodies (as opposed to the shared
  // canGmTools disabled expression) would have sat green. All four are
  // direct sendCommand calls with no intervening dialog.
  it('the GM-tools four each reach sendCommand with their own verb when clicked, holding only players.gm_tools', async () => {
    mockCan = (capability) => capability === 'players.gm_tools'
    await setUpFixtures()
    sendCommand.mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })

    const [godModeBtn, invisibleBtn, noclipBtn] = screen.getAllByRole('button', { name: 'Enable' })
    fireEvent.click(godModeBtn)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setGodMode', { username: 'TestPlayer', enabled: true }))
    fireEvent.click(invisibleBtn)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setInvisible', { username: 'TestPlayer', enabled: true }))
    fireEvent.click(noclipBtn)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setNoclip', { username: 'TestPlayer', enabled: true }))

    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('healPlayer', { username: 'TestPlayer' }))
  })

  // bug-hunt-2026-08-27: Radix's DropdownMenuItem composes the caller's
  // onClick with its own select handler and runs it UNCONDITIONALLY --
  // the internal disabled check only guards Radix's own side effect, never
  // the onClick prop. All six capability-gated items in the dossier "..."
  // menu now carry an explicit `if (!canX) return` as the first line of
  // their onClick body. This closes the residual gap from the earlier
  // report: the menu opens correctly with fireEvent.pointerDown (Radix
  // opens DropdownMenuTrigger on pointerdown, not click), so this exercises
  // the guard THROUGH THE UI, not just as a direct function assertion.
  it('the dossier "..." menu\'s six gated items never call their API when clicked, even though Radix runs onClick regardless of disabled', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    await openMoreActionsMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable God Mode' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable Invisible' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable Noclip' }))
    expect(sendCommand).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Whitelist' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Whitelist' }))
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Import/Export Character' }))
    expect(screen.queryByText('Export Character')).not.toBeInTheDocument()
  })
})
