import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi, BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS } from '@/lib/api'

// 2026-08-31 quality pass: runBridgeOperation (the general Bridge Tools "Run
// Operation" button -- distinct from handleAction/handleBridgeAction/
// runInlineAction, which all already called pushActivity) toasted a success
// message and populated the results table, but never touched the activity
// log. Same-frame proof it was a real bug, not a loading race: the sidebar
// "Recent actions" panel read "No recent actions -- actions triggered from
// this page will be logged here" at the exact moment the main panel showed a
// completed, timestamped "List Vehicles" result -- two demonstrably-resolved
// pieces of one screenshot disagreeing about whether an action ran.

// Same jsdom-Radix-Select workaround as Events.vehicleSirenControl.test.tsx /
// Chat.capabilityGating.test.tsx / Players.capabilityGating.test.tsx.
vi.mock('@/components/ui/select', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
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

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver
Element.prototype.scrollIntoView = vi.fn()

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

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

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

async function openBridgeToolsWithVehicles() {
  const nav = await screen.findByText('Bridge tools')
  fireEvent.click(nav)
  const combo = await screen.findByRole('combobox', { name: 'Select operation' })
  fireEvent.change(combo, { target: { value: 'getVehiclesDetailed' } })
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
})

describe('Events -- Bridge Tools "Run Operation" now logs to Recent Actions', () => {
  it('defers vehicle option polling until the Vehicles section is active', async () => {
    sendCommand.mockReset().mockResolvedValue({
      success: true,
      data: { safehouses: [], factions: [], vehicles: [] },
    } as never)
    renderEvents()

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getSafehouses', {}))
    expect(sendCommand).not.toHaveBeenCalledWith('getVehiclesDetailed', {}, expect.anything())

    fireEvent.click(await screen.findByRole('button', { name: 'Spawn vehicle' }))

    // support-bundle-2026-09-08 (sandbox-range-lockout follow-up): 3-arg
    // call now -- getVehiclesDetailed carries the slow-enumeration timeout
    // override, same as getAllSandboxOptions.
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(
      'getVehiclesDetailed', {}, { timeout: BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS },
    ))
  })

  it('replaces "No recent actions" with the operation label on a successful run', async () => {
    sendCommand.mockReset().mockResolvedValue({ success: true, data: { vehicles: [] } } as never)
    renderEvents()
    await openBridgeToolsWithVehicles()

    expect(screen.getByText(/no recent actions/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))

    await waitFor(() => {
      expect(screen.queryByText(/no recent actions/i)).not.toBeInTheDocument()
    })
    // "List Vehicles" appears twice once run (the dropdown's selected option
    // and the new Recent Actions entry) -- assert presence, not uniqueness.
    expect(screen.getAllByText('List Vehicles').length).toBeGreaterThan(0)
  })

  it('logs a failed run too, not just successes', async () => {
    sendCommand.mockReset().mockRejectedValue(new Error('bridge unreachable'))
    renderEvents()
    await openBridgeToolsWithVehicles()

    fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))

    await waitFor(() => {
      expect(screen.queryByText(/no recent actions/i)).not.toBeInTheDocument()
    })
  })
})
