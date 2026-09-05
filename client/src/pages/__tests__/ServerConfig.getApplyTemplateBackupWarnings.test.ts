import { describe, it, expect } from 'vitest'
import { getApplyTemplateBackupWarnings } from '../ServerConfig'

// contract-seam-findings, 2026-09-05: server/routes/serverFiles.js's
// POST /templates/:id/apply can write BOTH the INI and the Sandbox file in
// one call, and attaches a `backupWarnings` ARRAY when either write's own
// backup failed. api.ts's globally-handled `backupWarning` field (singular,
// a string) is a different shape used by ~30 other routes that only ever
// touch one file per call, so it never sees this route's plural array --
// applying a template could overwrite both config files with no safety
// copy and no warning at all unless this route's response is read
// explicitly. This pins the read-side contract in isolation.
describe('ServerConfig.tsx getApplyTemplateBackupWarnings: reads POST /templates/:id/apply\'s backupWarnings diagnostic', () => {
  it('returns the warnings when one or both backups failed', () => {
    expect(getApplyTemplateBackupWarnings({ backupWarnings: ['ini backup failed'] })).toEqual([
      'ini backup failed',
    ])
    expect(
      getApplyTemplateBackupWarnings({
        backupWarnings: ['ini backup failed', 'sandbox backup failed'],
      }),
    ).toEqual(['ini backup failed', 'sandbox backup failed'])
  })

  it('returns null when backupWarnings is an empty array (both backups succeeded)', () => {
    expect(getApplyTemplateBackupWarnings({ backupWarnings: [] })).toBeNull()
  })

  it('returns null when backupWarnings is absent (normal successful apply)', () => {
    expect(getApplyTemplateBackupWarnings({})).toBeNull()
    expect(getApplyTemplateBackupWarnings(undefined)).toBeNull()
    expect(getApplyTemplateBackupWarnings(null)).toBeNull()
  })
})
