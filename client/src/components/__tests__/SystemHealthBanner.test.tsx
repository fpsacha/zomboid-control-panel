import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SystemHealthBanner } from '../SystemHealthBanner'
import { systemApi, type StorageHealth } from '@/lib/api'
import en from '@/locales/en/systemHealthBanner.json'

vi.mock('@/lib/api', () => ({
  systemApi: { getStorageHealth: vi.fn() },
}))

function healthWith(overrides: Partial<StorageHealth>): StorageHealth {
  return {
    diskSpace: {
      saveVolume: { path: '/saves', totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false },
      panelData: { path: '/data', totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false },
    },
    circuitBreaker: { open: false, lastError: null, failCount: 0, cooldownEndsAt: null },
    ...overrides,
  }
}

const getStorageHealth = vi.mocked(systemApi.getStorageHealth)

beforeEach(() => {
  getStorageHealth.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

async function renderBanner() {
  render(
    <MemoryRouter>
      <SystemHealthBanner />
    </MemoryRouter>
  )
  // let the initial fetch effect resolve
  await waitFor(() => expect(getStorageHealth).toHaveBeenCalled())
}

describe('SystemHealthBanner', () => {
  it('shows nothing when storage is healthy -- no false alarm', async () => {
    getStorageHealth.mockResolvedValue(healthWith({}))
    const { container } = render(
      <MemoryRouter>
        <SystemHealthBanner />
      </MemoryRouter>
    )
    await waitFor(() => expect(getStorageHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces a critical, non-dismissible banner when the write circuit breaker is open', async () => {
    getStorageHealth.mockResolvedValue(healthWith({ circuitBreaker: { open: true, lastError: 'ENOSPC', failCount: 5, cooldownEndsAt: null } }))
    await renderBanner()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(en.writesBlockedTitle)).toBeInTheDocument()
    // A blocked-writes condition must not offer a dismiss that hides it from the operator.
    expect(screen.queryByRole('button', { name: en.dismissAria })).not.toBeInTheDocument()
  })

  it('surfaces a critical banner when the save volume itself is critical', async () => {
    getStorageHealth.mockResolvedValue(
      healthWith({
        diskSpace: {
          saveVolume: { path: '/saves', totalBytes: 100, freeBytes: 1, usedPercent: 99, warning: false, critical: true },
          panelData: { path: '/data', totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false },
        },
      })
    )
    await renderBanner()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(en.saveVolumeCriticalTitle)).toBeInTheDocument()
    expect(screen.getByText(en.usedPercent.replace('{{percent}}', '99'))).toBeInTheDocument()
  })

  it('lets a warning-level banner be dismissed', async () => {
    getStorageHealth.mockResolvedValue(
      healthWith({
        diskSpace: {
          saveVolume: { path: '/saves', totalBytes: 100, freeBytes: 15, usedPercent: 85, warning: true, critical: false },
          panelData: { path: '/data', totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false },
        },
      })
    )
    await renderBanner()

    expect(await screen.findByRole('status')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en.dismissAria }))
    expect(screen.queryByText(en.saveVolumeWarningTitle)).not.toBeInTheDocument()
  })

  it('does not render a false-healthy banner when the health fetch itself fails', async () => {
    getStorageHealth.mockRejectedValue(new Error('network down'))
    const { container } = render(
      <MemoryRouter>
        <SystemHealthBanner />
      </MemoryRouter>
    )
    await waitFor(() => expect(getStorageHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('bug-hunt-2026-09-04: keeps a live critical banner up through an unverifiable reading instead of clearing it', async () => {
    // diskMonitor.js's computeDiskStatus() forces warning/critical to false
    // whenever it can't verify the disk (ok: false) -- an unreachable mount,
    // a permission error, a momentary network-drive hiccup. Its own
    // socket-emit path already guards against treating that as an all-clear
    // (it holds the last known level rather than firing disk:normal), but
    // this component's 30s REST poll bypassed that guard entirely: it just
    // read save?.critical off the fresh (meaningless, forced-false) reading
    // and silently cleared a real critical banner the moment the mount
    // blipped, with no socket event involved at all.
    vi.useFakeTimers()
    getStorageHealth
      .mockResolvedValueOnce(
        healthWith({
          diskSpace: {
            saveVolume: { path: '/saves', totalBytes: 100, freeBytes: 1, usedPercent: 99, warning: false, critical: true, ok: true },
            panelData: { path: '/data', totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false, ok: true },
          },
        })
      )
      .mockResolvedValueOnce(
        healthWith({
          diskSpace: {
            saveVolume: { path: '/saves', totalBytes: 0, freeBytes: 0, usedPercent: 0, warning: false, critical: false, ok: false },
            panelData: { path: '/data', totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false, ok: true },
          },
        })
      )

    render(
      <MemoryRouter>
        <SystemHealthBanner />
      </MemoryRouter>
    )
    // The initial fetch's .then() resolves on a microtask, then triggers a
    // state update and a follow-on effect (the dismissed-reset effect) --
    // advancing fake timers by 0 doesn't reliably drain that whole chain
    // before the next line runs, so the first assertion needs the same
    // explicit act()-wrapped flush the second one needs by construction
    // (real elapsed time via advanceTimersByTimeAsync(30_000)).
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(en.saveVolumeCriticalTitle)).toBeInTheDocument()

    // Advance past the 30s poll interval to trigger the second, unverifiable reading.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(getStorageHealth).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(en.saveVolumeCriticalTitle)).toBeInTheDocument()
  })

  it('ignores an incomplete health response without crashing the layout', async () => {
    getStorageHealth.mockResolvedValue({ success: true, demo: true } as unknown as StorageHealth)
    const { container } = render(
      <MemoryRouter>
        <SystemHealthBanner />
      </MemoryRouter>
    )
    await waitFor(() => expect(getStorageHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
