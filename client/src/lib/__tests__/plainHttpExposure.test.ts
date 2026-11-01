import { describe, expect, it } from 'vitest'
import { isPlainHttpExposed } from '../plainHttpExposure'

describe('isPlainHttpExposed', () => {
  it.each([
    ['http:', '203.0.113.7'],
    ['http:', '8.8.8.8'],
    ['http:', 'panel.example.com'],
    ['http:', '2001:db8::1'],
  ])('warns for %s//%s', (protocol, host) => expect(isPlainHttpExposed(protocol, host)).toBe(true))

  it.each([
    ['https:', '203.0.113.7'],
    ['http:', 'localhost'],
    ['http:', '127.0.0.1'],
    ['http:', '192.168.1.20'],
    ['http:', '10.0.0.5'],
    ['http:', '172.20.1.1'],
    ['http:', '100.100.1.1'],
    ['http:', 'tower'],
    ['http:', 'tower.local'],
    ['http:', '[::1]'],
    ['http:', 'fd00::1'],
  ])('stays quiet for %s//%s', (protocol, host) => expect(isPlainHttpExposed(protocol, host)).toBe(false))
})
