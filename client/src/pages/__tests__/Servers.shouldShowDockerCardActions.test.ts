import { describe, it, expect } from 'vitest'
import { shouldShowDockerCardActions } from '../Servers'

// unknown-window-instances-outside-the-bridge, 2026-09-10: the action block
// used to hide Start/Stop whenever dockerAvailable wasn't strictly true --
// including the window right after a single transient poll failure, even
// though the container itself (found in the still-present, likely-accurate
// dockerContainers list) says otherwise. Mirrors resolveDockerCardHostStatus's
// own already-fixed pattern: a momentarily-unavailable dockerAvailable flag
// must not speak for a container we still have real data about.
describe('Servers -- shouldShowDockerCardActions', () => {
  it('shows the actions when a container is found, independent of dockerAvailable', () => {
    expect(shouldShowDockerCardActions({ state: 'running' })).toBe(true)
  })

  it('hides the actions only when no container is found at all', () => {
    expect(shouldShowDockerCardActions(undefined)).toBe(false)
  })
})
