import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { getDiagnosticsFixAction } from '../Debug'

// Minimal stand-in for i18next's t() -- these tests only assert on the
// boolean openServerConfig/openMods decisions, never on translated text.
const t = ((key: string) => key) as unknown as TFunction

function fallbackCheck(overrides: Partial<{
  id: string
  status: 'ok' | 'warn' | 'fail' | 'info' | 'skip'
  category: string
  hint: string
  meta: { unresolvedMods?: string[] }
}>) {
  return {
    id: 'some.unregistered.check',
    label: 'Some check',
    status: 'fail' as const,
    severity: 'critical' as const,
    message: 'Some message.',
    category: 'services',
    ...overrides,
  }
}

describe('getDiagnosticsFixAction fallback branch (uncovered check ids)', () => {
  it('routes unresolved Mods= entries to the exact editable Server Config field', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({
        id: 'mods.resolved',
        hint: 'Fix in server.ini.',
        meta: { unresolvedMods: ['ArcadiaQOLSafehouse_B42'] },
      }),
      t,
    )
    expect(action).toMatchObject({
      automated: false,
      manualRoute: '/server-config?tab=ini&search=Mods&unresolved=ArcadiaQOLSafehouse_B42',
    })
    expect(action?.openServerConfig).toBeUndefined()
    expect(action?.links).toBeUndefined()
  })

  it('opens server config when the hint contains the literal server.ini token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Edit server.ini to fix this.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(true)
  })

  it('does NOT open server config for translated prose that would have matched the old English phrase', () => {
    // Regression case: this is what a German-translated hint for the same
    // underlying concept looks like. The fallback must never decide UI
    // behaviour from prose, translated or not -- only from the literal
    // do-not-translate INI token, which this string does not contain.
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Öffne die Serverkonfiguration, um dies zu beheben.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
  })

  it('does NOT open server config for the English prose phrase alone, without the literal token', () => {
    // Same check in English: "server config" prose alone no longer
    // triggers the button either -- the fix removes the phrase entirely
    // rather than special-casing English.
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Open server config to fix this.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
  })

  it('opens mods when the hint contains the literal Mods= token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Remove the entry from Mods= and retry.' }),
      t,
    )
    expect(action?.openMods).toBe(true)
  })

  it('is case-insensitive for the literal tokens (hint is lowercased before matching)', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Check SERVER.INI for a stray entry.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(true)
  })

  it('returns neither flag when the hint matches nothing', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Restart the panel and try again.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
    expect(action?.openMods).toBe(false)
  })

  it('returns null for a passing or skipped check regardless of hint content', () => {
    expect(
      getDiagnosticsFixAction(
        fallbackCheck({ status: 'ok', hint: 'server.ini' }),
        t,
      ),
    ).toBeNull()
    expect(
      getDiagnosticsFixAction(
        fallbackCheck({ status: 'skip', hint: 'server.ini' }),
        t,
      ),
    ).toBeNull()
  })

  it('returns null for an info-status check with no explicit switch case', () => {
    expect(
      getDiagnosticsFixAction(fallbackCheck({ status: 'info' }), t),
    ).toBeNull()
  })
})

// 2026-08-27, debug-tsx-destructive-flag-catalogue follow-up: destructive
// used to be a fully independent optional field, only ever read inside the
// requiresConfirm branch -- so destructive:true with no requiresConfirm was
// silently inert (dialog never shown, fix ran immediately, nothing to catch
// it). Folded requiresConfirm/confirmMessage/destructive into one `confirm`
// object where `destructive` is a REQUIRED field, making that combination a
// compile error instead of a trap. These tests pin the three real fixes that
// carry `confirm` today, and confirm every other automated fix has none.
function manyIds(n: number) {
  return Array.from({ length: n }, (_, i) => String(i + 1))
}

describe('getDiagnosticsFixAction -- confirm/destructive pairing', () => {
  it('server.staleLocks always confirms and is destructive (it deletes files)', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ id: 'server.staleLocks', category: 'server' }),
      t,
    )
    expect(action?.confirm).toBeDefined()
    expect(action?.confirm?.destructive).toBe(true)
  })

  it('mods.numericInMods only confirms above the 10-item threshold, and is never destructive (an INI toggle)', () => {
    const few = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.numericInMods', category: 'mods' }),
        meta: { numericInMods: manyIds(3) },
      },
      t,
    )
    expect(few?.confirm).toBeUndefined()

    const many = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.numericInMods', category: 'mods' }),
        meta: { numericInMods: manyIds(11) },
      },
      t,
    )
    expect(many?.confirm).toBeDefined()
    expect(many?.confirm?.destructive).toBe(false)
  })

  it('mods.orphanWorkshop only confirms above the 10-item threshold, and is never destructive (an INI toggle)', () => {
    const few = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.orphanWorkshop', category: 'mods' }),
        meta: { orphanWorkshop: manyIds(3) },
      },
      t,
    )
    expect(few?.confirm).toBeUndefined()

    const many = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.orphanWorkshop', category: 'mods' }),
        meta: { orphanWorkshop: manyIds(11) },
      },
      t,
    )
    expect(many?.confirm).toBeDefined()
    expect(many?.confirm?.destructive).toBe(false)
  })

  it('automated fixes that never ask for confirmation carry no confirm object at all', () => {
    for (const id of ['mods.maps', 'mods.duplicates', 'server.process', 'rcon.connected', 'db.backup']) {
      const action = getDiagnosticsFixAction(fallbackCheck({ id, category: 'server' }), t)
      expect(action?.automated).toBe(true)
      expect(action?.confirm).toBeUndefined()
    }
  })
})
