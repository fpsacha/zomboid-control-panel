import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// bridge-tri-state sweep (2026-09-10): bridgeConnected has no null state, so
// "haven't checked yet" and "checked, disconnected" rendered as the same
// confident amber "Offline" badge -- for the full round trip of the FIRST
// getStatus() call, not just one frame. This is the clearest instance named
// in that sweep (statusBar's badge + Configure link, Events.tsx:2260-2293).
// Proven here with a getStatus() that never resolves during the assertion:
// without a third loading state, the badge shows "offline" the instant this
// page mounts, before any answer has come back at all.

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
      sendCommand: vi.fn(),
    },
  }
})

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)

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

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  // Never resolves during the test -- stands in for "the first answer
  // hasn't come back yet," however long that round trip actually takes.
  getStatus.mockReset().mockReturnValue(new Promise(() => {}))
})

describe('Events.tsx: bridge status badge during the unknown window before the first getStatus() answer', () => {
  it('does not render a confident "offline" state while the first check is still in flight', async () => {
    renderEvents()

    expect(screen.queryByText('offline')).not.toBeInTheDocument()
    expect(screen.queryByText('configure →')).not.toBeInTheDocument()
    expect(await screen.findByText('Checking…')).toBeInTheDocument()
  })
})
