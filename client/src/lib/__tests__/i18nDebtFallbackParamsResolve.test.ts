import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { getUnrecognizedSandboxOptionWarning, getSandboxOutOfRangeAllowedBody } from '../serverConfigSchema'
import { getBridgeStalenessBody } from '../bridgeVersionStaleness'

// i18n-debt follow-up, 2026-09-10 (god's HOLD on the 31-key mirror commit):
// registering a translatedOrFallback/resolveRegisteredTranslation-shaped
// key CHANGES WHICH BRANCH RUNS the moment the key resolves for the active
// language -- resolveRegisteredTranslation(ns, key, params) starts
// returning a non-null value instead of null, so the caller's `?? fallback`
// stops firing. For a key whose registered text has NO {{placeholder}},
// that's harmless (the registered text and the JS fallback say the same
// thing). For a key that DOES have a placeholder, the caller must actually
// forward matching `params`, or the interpolation never has values to work
// with.
//
// resolveRegisteredTranslation has its own explicit backstop for this
// (paramTranslation.ts: "a key with placeholders only translates once
// every required name is present in params... returns null otherwise") --
// so a placeholder key called with NO params does not leak a literal
// "{{name}}" to the user; it falls straight through to the caller's
// already-interpolated JS fallback string, same output as before the key
// existed. That was verified here (a live repro against the real en
// locale data showed clean text, not "{{value}}") before writing this file
// -- it is not the failure mode this suite guards.
//
// What omitting params actually breaks is quieter and easy to miss: the
// key can never resolve to anything OTHER than the JS fallback, for any
// language, ever -- including a real French/German/etc. translation
// written into it later. That's a permanently inert registration, not a
// live bug, but it defeats the entire point of having mirrored the key in
// the first place (see the 31-key mirror commit this file follows up on).
// getUnrecognizedSandboxOptionWarning was exactly this case: its call to
// translatedOrFallback() passed no params at all.
//
// Each test below distinguishes "shows the right text" (true even for the
// inert case, since en's registered text and the JS fallback happen to be
// identical) from "the REGISTERED path actually ran and interpolated" --
// proven by injecting a DIFFERENT bundle under a language with no real
// translation yet (`de`, same technique as serverConfigSchema.i18n.test.ts's
// DE_PROOF_BUNDLE) and confirming that injected text -- not the English
// fallback -- comes back with the real value substituted into it. If the
// inert-registration bug ever returns (params stop reaching
// resolveRegisteredTranslation for one of these), these tests fail because
// the injected `de` text never appears -- the function falls through to
// the English-language JS fallback instead, in the WRONG active language.

afterEach(() => {
  i18n.removeResourceBundle('de', 'serverconfig')
  i18n.removeResourceBundle('de', 'settings')
  void i18n.changeLanguage('en')
})

describe('translatedOrFallback/resolveRegisteredTranslation-backed {{placeholder}} keys genuinely interpolate, not just coincide with the JS fallback', () => {
  it('getUnrecognizedSandboxOptionWarning: en output has no literal {{value}} and contains the real value', async () => {
    await i18n.changeLanguage('en')
    const result = getUnrecognizedSandboxOptionWarning(42)
    expect(result).not.toContain('{{')
    expect(result).toContain('42')
  })

  it('getUnrecognizedSandboxOptionWarning: a real non-English translation actually takes effect (proof this key is NOT permanently stuck on the English fallback)', async () => {
    i18n.addResourceBundle(
      'de',
      'serverconfig',
      { unrecognizedSandboxOptionWarning: 'DE-PROOF unrecognizedSandboxOptionWarning: Wert={{value}}' },
      true,
      true,
    )
    await i18n.changeLanguage('de')
    expect(getUnrecognizedSandboxOptionWarning(42)).toBe('DE-PROOF unrecognizedSandboxOptionWarning: Wert=42')
  })

  it('getSandboxOutOfRangeAllowedBody: en output has no literal {{settings}} and contains the real list', async () => {
    await i18n.changeLanguage('en')
    const result = getSandboxOutOfRangeAllowedBody('Foo, Bar')
    expect(result).not.toContain('{{')
    expect(result).toContain('Foo, Bar')
  })

  it('getSandboxOutOfRangeAllowedBody: a real non-English translation actually takes effect', async () => {
    i18n.addResourceBundle(
      'de',
      'serverconfig',
      { sandboxTab: { outOfRangeAllowedBody: 'DE-PROOF outOfRangeAllowedBody: {{settings}}' } },
      true,
      true,
    )
    await i18n.changeLanguage('de')
    expect(getSandboxOutOfRangeAllowedBody('Foo, Bar')).toBe('DE-PROOF outOfRangeAllowedBody: Foo, Bar')
  })

  it('getBridgeStalenessBody(protocolMismatch): en output has no literal {{expected}}/{{actual}} and contains the real values', async () => {
    await i18n.changeLanguage('en')
    const result = getBridgeStalenessBody({ kind: 'protocolMismatch', expected: '5', actual: '6' })
    expect(result).not.toContain('{{')
    expect(result).toContain('5')
    expect(result).toContain('6')
  })

  it('getBridgeStalenessBody(protocolMismatch): a real non-English translation actually takes effect', async () => {
    i18n.addResourceBundle(
      'de',
      'settings',
      { bridge: { staleness: { protocolMismatchBody: 'DE-PROOF protocolMismatchBody: {{expected}}/{{actual}}' } } },
      true,
      true,
    )
    await i18n.changeLanguage('de')
    expect(getBridgeStalenessBody({ kind: 'protocolMismatch', expected: '5', actual: '6' })).toBe(
      'DE-PROOF protocolMismatchBody: 5/6',
    )
  })

  it('getBridgeStalenessBody(remoteUpdateAvailable): en output has no literal {{liveVersion}}/{{bundledVersion}} and contains the real values', async () => {
    await i18n.changeLanguage('en')
    const result = getBridgeStalenessBody({ kind: 'remoteUpdateAvailable', liveVersion: '1.2', bundledVersion: '1.3' })
    expect(result).not.toContain('{{')
    expect(result).toContain('1.2')
    expect(result).toContain('1.3')
  })

  it('getBridgeStalenessBody(remoteUpdateAvailable): a real non-English translation actually takes effect', async () => {
    i18n.addResourceBundle(
      'de',
      'settings',
      { bridge: { staleness: { remoteUpdateBody: 'DE-PROOF remoteUpdateBody: {{liveVersion}}/{{bundledVersion}}' } } },
      true,
      true,
    )
    await i18n.changeLanguage('de')
    expect(getBridgeStalenessBody({ kind: 'remoteUpdateAvailable', liveVersion: '1.2', bundledVersion: '1.3' })).toBe(
      'DE-PROOF remoteUpdateBody: 1.2/1.3',
    )
  })

  it('getBridgeStalenessBody(localUpdateAvailable): en output has no literal {{liveVersion}} and contains the real value', async () => {
    await i18n.changeLanguage('en')
    const result = getBridgeStalenessBody({ kind: 'localUpdateAvailable', liveVersion: '1.2' })
    expect(result).not.toContain('{{')
    expect(result).toContain('1.2')
  })

  it('getBridgeStalenessBody(localUpdateAvailable): a real non-English translation actually takes effect', async () => {
    i18n.addResourceBundle(
      'de',
      'settings',
      { bridge: { staleness: { localUpdateBody: 'DE-PROOF localUpdateBody: {{liveVersion}}' } } },
      true,
      true,
    )
    await i18n.changeLanguage('de')
    expect(getBridgeStalenessBody({ kind: 'localUpdateAvailable', liveVersion: '1.2' })).toBe(
      'DE-PROOF localUpdateBody: 1.2',
    )
  })
})
