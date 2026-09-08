import { describe, expect, it } from 'vitest'
import { ApiError, buildResponseError } from '../api'

// Small, self-contained follow-up in tonight's through-line: the panel knows
// something true (the server's own Retry-After header, sent by every rate
// limiter in this app via express-rate-limit's standardHeaders mode) and
// didn't tell the user. "Too many requests, please try again later" never
// said when -- buildResponseError discarded Retry-After entirely.
function rateLimitedResponse(retryAfterHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (retryAfterHeader !== undefined) headers['retry-after'] = retryAfterHeader
  return new Response(null, { status: 429, headers })
}

describe('buildResponseError: Retry-After', () => {
  it('appends a human wait time (seconds) from a delta-seconds Retry-After header', () => {
    const response = rateLimitedResponse('42')
    const error = buildResponseError(response, { error: 'Too many requests, please try again later.' })

    expect(error).toBeInstanceOf(ApiError)
    expect(error.retryAfterSeconds).toBe(42)
    expect(error.message).toBe('Too many requests, please try again later. Try again in 42 seconds.')
  })

  it('rounds up to minutes once the wait crosses 60 seconds', () => {
    const response = rateLimitedResponse('125')
    const error = buildResponseError(response, { error: 'Rate limit exceeded for this operation.' })

    expect(error.retryAfterSeconds).toBe(125)
    expect(error.message).toBe('Rate limit exceeded for this operation. Try again in 3 minutes.')
  })

  it('parses an HTTP-date Retry-After (the other RFC 7231 form) relative to now', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const response = rateLimitedResponse(future)
    const error = buildResponseError(response, { error: 'Too many requests, please try again later.' })

    // Allow a little slack for the time the test itself takes to run.
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(8)
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(11)
    expect(error.message).toMatch(/Try again in \d+ seconds\.$/)
  })

  it('leaves the message and retryAfterSeconds untouched when the header is absent', () => {
    const response = rateLimitedResponse()
    const error = buildResponseError(response, { error: 'Too many requests, please try again later.' })

    expect(error.retryAfterSeconds).toBeUndefined()
    expect(error.message).toBe('Too many requests, please try again later.')
  })

  it('ignores a header that is neither a valid delta-seconds count nor a parseable date', () => {
    const response = rateLimitedResponse('not-a-real-value')
    const error = buildResponseError(response, { error: 'Too many requests, please try again later.' })

    expect(error.retryAfterSeconds).toBeUndefined()
    expect(error.message).toBe('Too many requests, please try again later.')
  })

  it('falls back to the generic 429 message plus the wait time when the server sends no error field at all', () => {
    const response = rateLimitedResponse('5')
    const error = buildResponseError(response, {})

    expect(error.message).toBe('Too many requests were sent. Wait a moment and try again. Try again in 5 seconds.')
  })
})
