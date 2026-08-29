import { describe, expect, it } from 'vitest'
import { getDashboardLocalProcessStatus } from '../dashboardStatus'

describe('Dashboard host-status source', () => {
  it('does not let the host process result override a Docker container status', () => {
    expect(
      getDashboardLocalProcessStatus(
        { isRemote: false, dockerContainerName: 'pz-container', dockerContainerId: null },
        { running: false },
      ),
    ).toBeNull()
  })

  it('uses the legacy process result for native servers', () => {
    expect(
      getDashboardLocalProcessStatus(
        { isRemote: false, dockerContainerName: null, dockerContainerId: null },
        { running: true },
      ),
    ).toBe(true)
  })

  it('recognizes a container ID as a managed Docker server', () => {
    expect(
      getDashboardLocalProcessStatus(
        { isRemote: false, dockerContainerName: null, dockerContainerId: 'abc123' },
        { running: false },
      ),
    ).toBeNull()
  })
})