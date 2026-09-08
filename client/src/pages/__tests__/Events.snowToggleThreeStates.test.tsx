import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// paired-buttons-2026-08-31: operator complaint -- "if i enable snow, the
// same button should show disable, not have 2 buttons". Severe Weather's
// Enable Snow / Disable Snow pair became a single Switch reflecting
// liveWeather.isSnowing (from panelBridgeApi.getWeather()). This file proves
// the three states the request explicitly requires: ON, OFF, and UNKNOWN
// (getWeather hasn't landed yet, or failed) -- UNKNOWN must render neither a
// confident "on" nor "off" claim, and must not be interactable, since a
// Switch's checked position is itself a claim about current state.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      getWeather: vi.fn(),
      setSnow: vi.fn(),
      stopWeather: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const setSnow = vi.mocked(panelBridgeApi.setSnow)

function renderEvents() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openSevereSection() {
  const nav = await screen.findByText('Severe weather')
  nav.click()
  // Sublabel text unique to the mounted severe-weather section -- confirms
  // the panel actually swapped in before proceeding.
  await screen.findByText('Blizzards, tropical storms, and snowfall.')
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  setSnow.mockReset().mockResolvedValue({ success: true } as never)
})

function snowSwitch() {
  return screen.findByRole('switch', { name: 'snow toggle' })
}

describe('Events -- Severe Weather snow toggle reflects real state (three states)', () => {
  it('ON: renders checked when liveWeather.isSnowing is true, and clicking disables snow', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: true, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    expect(sw).toBeEnabled()

    sw.click()
    await waitFor(() => expect(setSnow).toHaveBeenCalledWith(false))
  })

  it('OPTIMISTIC: flips immediately on click (does not wait for the next poll), then reverts if the command fails', async () => {
    // toggle-latency-2026-08-31, operator report on the live panel ("it take
    // like 5 sec to trigger and see the change"): handleBridgeAction never
    // refetched weather, so the switch stayed on the OLD value until the
    // next scheduled 10s poll happened to land. This proves the fix without
    // needing a real poll interval to fire in the test.
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: false, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)

    let rejectSetSnow!: (err: Error) => void
    setSnow.mockReturnValue(new Promise((_, reject) => { rejectSetSnow = reject }))

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))

    sw.click()

    // Optimistic: flips to checked immediately, before setSnow's promise has
    // even settled -- this is the state the operator wants to see instantly.
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))

    rejectSetSnow(new Error('bridge command failed'))

    // Reverts to the last known-real state on failure -- never leaves the
    // optimistic guess standing as if it were confirmed.
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))
  })

  it('RECONCILE: refetches the real weather after a successful command, and the real answer wins over the optimistic guess', async () => {
    // The optimistic flip is a GUESS, not a claim of confirmed knowledge --
    // if the real post-command read disagrees (mod silently rejected it,
    // another admin changed it in between, ...), the refetch's answer must
    // win, not the click's assumption.
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: false, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)
    setSnow.mockResolvedValue({ success: true } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))

    sw.click()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true')) // optimistic
    await waitFor(() => expect(setSnow).toHaveBeenCalledWith(true))

    // sweep-2026-09-08 (unbounded-waitFor-on-a-polling-page class):
    // Events.tsx's own bridgeInterval also calls getWeather every 10000ms
    // (checkBridgeStatus's poll tick, independent of this toggle), so an
    // open-ended wait here can't tell refetchWeather()'s deliberate
    // immediate reconcile apart from just outlasting that unrelated tick.
    // Confirmed by break-verify: commenting out the snow toggle's own
    // `await refetchWeather()` call left the switch still correcting to
    // 'false' eventually, just ~10s later via the periodic poll instead of
    // near-instantly -- the 10.1s duration this test used to have was the
    // tell, not a slow machine. Bounding well under 10000ms makes this
    // assertion actually prove the immediate path exists.
    //
    // An earlier version of this fix tried to additionally assert on
    // getWeather's call COUNT growing past a baseline captured right after
    // "setSnow was called" -- that raced the same async chain it was
    // measuring (refetchWeather can already have run, in the same
    // microtask window, by the time waitFor's own polling notices setSnow
    // was called), and flaked with "N is not greater than N". The switch's
    // own final state is the real, user-visible signal that matters here;
    // bounding ONLY that assertion is enough to discriminate the fix
    // without needing a second, racier measurement alongside it.
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'), { timeout: 3000 })
  })

  it('OFF: renders unchecked when liveWeather.isSnowing is false, and clicking enables snow', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: false, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))
    expect(sw).toBeEnabled()

    sw.click()
    await waitFor(() => expect(setSnow).toHaveBeenCalledWith(true))
  })

  it('UNKNOWN: renders disabled and unchecked (not a faked "off") when getWeather fails, and never calls setSnow', async () => {
    getWeather.mockResolvedValue({ success: false } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    // Neither a confident "on" nor "off" claim: disabled communicates the
    // state genuinely isn't known yet, distinct from a real, known "off".
    await waitFor(() => expect(sw).toBeDisabled())
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByText('…').length).toBeGreaterThan(0)

    sw.click()
    expect(setSnow).not.toHaveBeenCalled()
  })

  it('UNKNOWN: renders disabled before getWeather resolves at all (pending, not yet failed)', async () => {
    // Never resolves within this test -- models the real gap between the
    // bridge connecting and the independent, non-batched getWeather() call
    // landing (Events.tsx:1266's own comment on why it's fired separately).
    getWeather.mockReturnValue(new Promise(() => {}))

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    expect(sw).toBeDisabled()
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })
})
