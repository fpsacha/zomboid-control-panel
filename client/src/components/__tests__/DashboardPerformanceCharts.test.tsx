import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DashboardPerformanceCharts, { type DashboardPerformancePoint } from '../DashboardPerformanceCharts'

function point(overrides: Partial<DashboardPerformancePoint> = {}): DashboardPerformancePoint {
  return {
    time: '12:00',
    playerCount: 0,
    memoryMB: 512,
    cpuPercent: 10,
    ...overrides,
  }
}

function cpuRow() {
  return screen.getByText('Host CPU').closest('div')!
}

describe('DashboardPerformanceCharts', () => {
  it('renders nothing when there is no history yet, rather than a misleading empty/zeroed report', () => {
    const { container } = render(<DashboardPerformanceCharts performanceHistory={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks critical CPU load (>=90%) as destructive/bad, not neutral or good -- the house failure mode is a healthy-looking bar at high load', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ cpuPercent: 95 })]} />)
    const bar = cpuRow().querySelector('.bg-destructive')
    expect(bar).toBeInTheDocument()
  })

  it('marks moderate load (70-89%) as a warning, distinct from both good and bad', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ cpuPercent: 75 })]} />)
    const row = cpuRow()
    expect(row.querySelector('.bg-warning')).toBeInTheDocument()
    expect(row.querySelector('.bg-destructive')).not.toBeInTheDocument()
  })

  it('marks low load as good, not a false warning', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ cpuPercent: 20 })]} />)
    const row = cpuRow()
    expect(row.querySelector('.bg-success')).toBeInTheDocument()
    expect(row.querySelector('.bg-destructive')).not.toBeInTheDocument()
    expect(row.querySelector('.bg-warning')).not.toBeInTheDocument()
  })

  it('a full disk (>=90%) is reported as critical -- silent disk exhaustion corrupts saves', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ hostDiskUsedGB: 95, hostDiskTotalGB: 100 })]}
      />
    )
    const row = screen.getByText('Disk').closest('div')!
    expect(row.querySelector('.bg-destructive')).toBeInTheDocument()
  })

  it('host RAM at exactly 90% is NOT yet flagged critical (component uses a strict > 0.9), matching the value it actually renders', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ hostMemUsedGB: 90, hostMemTotalGB: 100 })]}
      />
    )
    const row = screen.getByText('Host memory').closest('div')!
    // loadTone uses >= 0.9 -> 'bad' for the bar colour regardless of the alert
    // flag's stricter '> 0.9' threshold, so the bar is still destructive here.
    expect(row.querySelector('.bg-destructive')).toBeInTheDocument()
  })

  it('does not report a Players row when nobody has ever been online in this window -- a flat zero line is not a metric worth a row', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ playerCount: 0 })]} />)
    expect(screen.queryByText('Players')).not.toBeInTheDocument()
  })

  it('reports Players once someone has been online in the window, with the real count', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ playerCount: 0 }), point({ playerCount: 3 })]}
      />
    )
    expect(screen.getByText('Players')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows PZ memory against the real configured ceiling, not a hardcoded one', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ pzMemMB: 2048 })]}
        maxMemoryGB={8}
      />
    )
    expect(screen.getByText('2.0 / 8')).toBeInTheDocument()
  })
})

// Tonin96's Discord report (2026-08-26): HOST MEMORY 7.4/7.8 GB, 95%, red --
// and no way to tell whether swap is absorbing that (fine) or also
// exhausted (not fine). "Absent is not zero" is the rule this whole row
// exists to satisfy: a lookup that could not determine swap must never
// render the same as a host that genuinely has none configured.
describe('DashboardPerformanceCharts -- swap row', () => {
  it('does not show a Swap row when the lookup could not determine an answer (undefined, not zero)', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ hostSwapUsedGB: undefined, hostSwapTotalGB: undefined })]} />)
    expect(screen.queryByText('Host swap')).not.toBeInTheDocument()
  })

  it('shows a real zero as "no swap configured", not as a hidden/failed lookup', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ hostSwapUsedGB: 0, hostSwapTotalGB: 0 })]} />)
    const row = screen.getByText('Host swap').closest('div')!
    expect(row).toHaveTextContent('0.0 / 0')
    // Zero total means no ratio to alert on -- neutral, not destructive.
    expect(row.querySelector('.bg-destructive')).not.toBeInTheDocument()
  })

  it('reports a real reading with its used/total values', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ hostSwapUsedGB: 1.5, hostSwapTotalGB: 4 })]} />)
    expect(screen.getByText('1.5 / 4')).toBeInTheDocument()
  })

  it('flags swap exhaustion (>=90%) as critical, the case that actually answers the 95%-red host-memory question', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ hostSwapUsedGB: 3.8, hostSwapTotalGB: 4 })]} />)
    const row = screen.getByText('Host swap').closest('div')!
    expect(row.querySelector('.bg-destructive')).toBeInTheDocument()
  })
})

// bug-hunt-2026-09-08 (operator screenshot, Arabic UI): "23.8 / 31.3"
// rendered as "31.3 / 23.8" -- the Unicode bidi algorithm treats
// `number space slash space number` as a run of neutrals inside an RTL
// paragraph and lays the pair out right-to-left. jsdom does not implement
// bidi visual reordering at all (it is a text-shaping behaviour, not
// something exposed on the DOM), so this cannot assert the actual on-screen
// order the way a real browser would render it -- what it CAN and must
// assert is the mechanism real browsers use to prevent the reorder: the
// used/total text is isolated inside a <bdi> element, in used-then-total
// source order. A test that only checked getByText('23.8 / 31.3') exists
// would keep passing even if someone silently dropped the <bdi> wrapper
// (or swapped the args to `used / total`) -- this asserts the wrapper
// AND the order together, which is the actual contract.
describe('DashboardPerformanceCharts -- RTL bidi isolation on used/total values', () => {
  it('wraps the host memory used/total value in <bdi>, used before total', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ hostMemUsedGB: 2.3, hostMemTotalGB: 16 })]}
      />
    )
    const row = screen.getByText('Host memory').closest('div')!
    const bdi = row.querySelector('bdi')
    expect(bdi).toBeInTheDocument()
    expect(bdi).toHaveTextContent('2.3 / 16')
  })

  it('wraps the disk used/total value in <bdi>, used before total', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ hostDiskUsedGB: 24, hostDiskTotalGB: 31 })]}
      />
    )
    const row = screen.getByText('Disk').closest('div')!
    const bdi = row.querySelector('bdi')
    expect(bdi).toBeInTheDocument()
    expect(bdi).toHaveTextContent('24 / 31')
  })

  it('wraps the swap used/total value in <bdi>, used before total', () => {
    render(<DashboardPerformanceCharts performanceHistory={[point({ hostSwapUsedGB: 1.5, hostSwapTotalGB: 4 })]} />)
    const row = screen.getByText('Host swap').closest('div')!
    const bdi = row.querySelector('bdi')
    expect(bdi).toBeInTheDocument()
    expect(bdi).toHaveTextContent('1.5 / 4')
  })

  it('wraps the PZ memory used/ceiling value in <bdi>, used before ceiling', () => {
    render(
      <DashboardPerformanceCharts
        performanceHistory={[point({ pzMemMB: 2048 })]}
        maxMemoryGB={8}
      />
    )
    const bdi = screen.getByText('2.0 / 8').closest('bdi')
    expect(bdi).toBeInTheDocument()
  })
})
