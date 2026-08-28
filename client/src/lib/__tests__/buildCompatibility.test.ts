import { describe, expect, it } from 'vitest'
import { assessBuildCompatibility, type BuildMetadata } from '../buildCompatibility'

const backend: BuildMetadata = {
  panelVersion: '2.0.0',
  buildSha: 'same-build',
  apiContractVersion: 1,
}

describe('build compatibility', () => {
  it('accepts identical frontend and backend metadata', () => {
    expect(assessBuildCompatibility(backend, backend)).toEqual({ compatible: true })
  })

  it('rejects both frontend-older and backend-older version mixes', () => {
    expect(
      assessBuildCompatibility({ ...backend, panelVersion: '1.9.0' }, backend),
    ).toEqual(expect.objectContaining({ compatible: false, code: 'version_mismatch' }))
    expect(
      assessBuildCompatibility({ ...backend, panelVersion: '2.1.0' }, backend),
    ).toEqual(expect.objectContaining({ compatible: false, code: 'version_mismatch' }))
  })

  it('rejects a different build or API contract within the same version', () => {
    expect(
      assessBuildCompatibility({ ...backend, buildSha: 'other-build' }, backend),
    ).toEqual(expect.objectContaining({ compatible: false }))
    expect(
      assessBuildCompatibility({ ...backend, apiContractVersion: 2 }, backend),
    ).toEqual(expect.objectContaining({ compatible: false }))
  })
})
