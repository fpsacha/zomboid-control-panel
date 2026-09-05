import { describe, it, expect } from 'vitest'
import { getUnpersistedSandboxKeys } from '../ServerConfig'

// client-bundle-integrity follow-up, 2026-09-05: server/routes/serverFiles.js's
// PUT /sandbox reads the SandboxVars.lua file back after writing it, added
// specifically because a key with no matching line to update was silently
// dropped while the route still reported success -- attached as
// `unpersistedKeys` on the response when that happens. Nothing on the client
// ever read that field: saveSandbox()'s return value was discarded entirely,
// so the fix written to stop a silent-success bug was itself silently inert.
// This pins the read-side contract in isolation.
describe('ServerConfig.tsx getUnpersistedSandboxKeys: reads PUT /sandbox\'s unpersistedKeys diagnostic', () => {
  it('returns the keys when the route reports some did not persist', () => {
    expect(getUnpersistedSandboxKeys({ unpersistedKeys: ['ZombieConfig.speed', 'Foraging'] })).toEqual([
      'ZombieConfig.speed',
      'Foraging',
    ])
  })

  it('returns null when unpersistedKeys is an empty array (everything persisted)', () => {
    expect(getUnpersistedSandboxKeys({ unpersistedKeys: [] })).toBeNull()
  })

  it('returns null when unpersistedKeys is absent (normal successful save)', () => {
    expect(getUnpersistedSandboxKeys({})).toBeNull()
    expect(getUnpersistedSandboxKeys(undefined)).toBeNull()
    expect(getUnpersistedSandboxKeys(null)).toBeNull()
  })
})
