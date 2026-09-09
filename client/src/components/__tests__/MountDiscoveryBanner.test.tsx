import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MountDiscoveryBanner, InaccessibleMountBanner } from '../MountDiscoveryBanner'
import type { DiscoveredMount, InaccessibleMountCandidate } from '@/lib/api'

const mount: DiscoveredMount = {
  installPath: '/pz-server',
  dataPath: '/pz-data',
  source: 'known-path',
  serverNames: ['servertest'],
  hasStartScript: true,
  hasPanelBridge: false,
}

// 2026-09-09 ruling (god): a discovered mount without a confirmed data path
// AND a server config used to be filtered out entirely before it ever
// reached this component -- now Servers.tsx sends it through with
// confidence="partial" instead of hiding it. No dataPath and no serverNames.
const partialMount: DiscoveredMount = {
  installPath: '/data',
  dataPath: null,
  source: 'common-mount',
  serverNames: [],
  hasStartScript: false,
  hasPanelBridge: false,
}

describe('MountDiscoveryBanner', () => {
  beforeEach(() => localStorage.clear())

  it('passes the discovered mount to the add action', () => {
    const onConnect = vi.fn()
    render(<MountDiscoveryBanner mount={mount} confidence="confirmed" onConnect={onConnect} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(onConnect).toHaveBeenCalledWith(mount)
  })

  it('remembers dismissal for the install path', () => {
    render(<MountDiscoveryBanner mount={mount} confidence="confirmed" onConnect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss discovered install' }))

    expect(screen.queryByText('PZ install')).not.toBeInTheDocument()
    expect(localStorage.getItem(`pz-mount-discovery-dismissed-${mount.installPath}`)).toBe('true')
  })

  describe('confidence="partial"', () => {
    it('shows different copy and a different action label than a confirmed mount, but still passes the mount through on click', () => {
      const onConnect = vi.fn()
      render(<MountDiscoveryBanner mount={partialMount} confidence="partial" onConnect={onConnect} />)

      // Not the confirmed-mount title, and not the confirmed-mount button
      // label -- proves this isn't just rendering identically regardless of
      // the prop.
      expect(screen.queryByText('PZ install')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
      expect(screen.getByText('Possible PZ install found')).toBeInTheDocument()
      expect(screen.getByText(/No save data folder confirmed yet/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Review & Add' }))
      expect(onConnect).toHaveBeenCalledWith(partialMount)
    })

    it('mentions a missing server config specifically when a data path WAS found but no .ini was', () => {
      render(
        <MountDiscoveryBanner
          mount={{ ...partialMount, dataPath: '/data/Zomboid' }}
          confidence="partial"
          onConnect={vi.fn()}
        />,
      )

      expect(screen.getByText(/No server config found yet/)).toBeInTheDocument()
      expect(screen.queryByText(/No save data folder confirmed yet/)).not.toBeInTheDocument()
    })
  })
})

describe('InaccessibleMountBanner', () => {
  const entry: InaccessibleMountCandidate = {
    path: '/pz-server',
    source: 'common-mount',
    reason: 'permission-denied',
  }

  beforeEach(() => localStorage.clear())

  it('shows the path and a Retry action, with no Add action since nothing here can become a profile yet', () => {
    const onRetry = vi.fn()
    render(<InaccessibleMountBanner entry={entry} onRetry={onRetry} />)

    expect(screen.getByText('/pz-server')).toBeInTheDocument()
    expect(screen.getByText('Found something here, but could not read it')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('remembers dismissal for the path, independent of MountDiscoveryBanner dismissal keys', () => {
    render(<InaccessibleMountBanner entry={entry} onRetry={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Dismiss'))

    expect(screen.queryByText('Found something here, but could not read it')).not.toBeInTheDocument()
    expect(localStorage.getItem(`pz-mount-discovery-dismissed-${entry.path}`)).toBe('true')
  })
})
