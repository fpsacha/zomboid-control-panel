import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { getLoginErrorMessage, LOGIN_FAILED_MESSAGE } from '../AuthContext'

// 2026-08-26: login()'s fetch used to discard response status/code entirely,
// throwing a plain Error whose message getLoginErrorMessage() always
// collapsed to one of two fixed strings (network/CORS, or this generic
// auth-failed text) regardless of whether the underlying failure was a real
// auth rejection or a server crash. These pin the fix: a coded/uncoded 5xx
// is no longer swallowed into the same text an actual wrong-password
// response gets, while every existing case (network error, CORS, 4xx auth
// failure) stays byte-identical to preserve the account-enumeration ruling.
describe('getLoginErrorMessage', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('maps a network TypeError to the CORS/connectivity message', () => {
    expect(getLoginErrorMessage(new TypeError('Failed to fetch'))).toContain('Connection blocked by browser origin policy')
  })

  it('maps a cors-flavored Error message to the same CORS message', () => {
    expect(getLoginErrorMessage(new Error('CORS request did not succeed'))).toContain('Connection blocked by browser origin policy')
  })

  it('keeps the exact generic auth-failed text for a 401 -- the enumeration-safe case, unchanged', () => {
    const error = new ApiError('Invalid username or password', { status: 401 })
    expect(getLoginErrorMessage(error)).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('keeps the exact generic auth-failed text for a 400', () => {
    const error = new ApiError('Username and password are required', { status: 400 })
    expect(getLoginErrorMessage(error)).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('does NOT collapse a genuine 500 into the generic auth-failed text -- this is the actual fix', () => {
    const error = new ApiError('Database connection failed', { status: 500 })
    const message = getLoginErrorMessage(error)
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Database connection failed')
  })

  it('translates a registered 5xx-adjacent code the same way getUserErrorMessage does everywhere else', () => {
    void i18n.changeLanguage('fr')
    const error = new ApiError('Some unexpected failure', { status: 503 })
    expect(getLoginErrorMessage(error)).toContain("n'était pas attendu")
  })

  // bug-hunt-2026-09-07: RATE_LIMIT_LOGIN used to be swallowed into
  // LOGIN_FAILED_MESSAGE ("check your username and password") right along
  // with a real wrong-password 401 -- actively wrong, not merely generic,
  // since a rate-limited user is told to recheck credentials that were
  // never the problem. Telling the truth about rate-limiting reveals
  // nothing about whether the account exists, so it doesn't need the
  // enumeration-safe collapse the 401/400 cases above still correctly get.
  it('does NOT collapse a 429 rate-limit into the generic auth-failed text -- shows its own registered message instead', () => {
    const error = new ApiError('Too many login attempts. Please try again later.', {
      status: 429,
      code: 'RATE_LIMIT_LOGIN',
    })
    const message = getLoginErrorMessage(error)
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Too many login attempts')
  })

  it('falls back to the generic text for a non-ApiError, non-network error', () => {
    expect(getLoginErrorMessage(new Error('something else'))).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('falls back to the generic text for a non-error value', () => {
    expect(getLoginErrorMessage('a plain string')).toBe(LOGIN_FAILED_MESSAGE)
  })
})
