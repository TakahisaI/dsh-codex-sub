import { describe, expect, it } from 'vitest'

import { CodexError } from '../src/core/errors.js'
import {
  canonicalStringifyJson,
  utf8ByteLength,
  validateJsonObject,
  validateJsonValue,
} from '../src/core/json.js'

function expectInvalid(operation: () => unknown): CodexError {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(CodexError)
    expect((error as CodexError).code).toBe('CODEX_AUTH_STORAGE_INVALID')
    return error as CodexError
  }
  throw new Error('Expected JSON validation to fail.')
}

describe('JSON-safe validation', () => {
  it('returns a detached, frozen, canonical value', () => {
    const input = { zebra: [true, null, 2], alpha: { nested: 'value' } }
    const validated = validateJsonObject(input)

    expect(validated).toEqual(input)
    expect(validated).not.toBe(input)
    expect(Object.getPrototypeOf(validated)).toBeNull()
    expect(Object.isFrozen(validated)).toBe(true)
    expect(canonicalStringifyJson(input)).toBe(
      '{"alpha":{"nested":"value"},"zebra":[true,null,2]}',
    )
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite number %s',
    (value) => {
      expectInvalid(() => validateJsonValue(value))
    },
  )

  it.each([undefined, 1n, Symbol('value'), () => undefined])(
    'rejects unsupported value %s',
    (value) => {
      expectInvalid(() => validateJsonValue(value))
    },
  )

  it('rejects custom prototypes', () => {
    expectInvalid(() => validateJsonValue(new Date()))
    expectInvalid(() => validateJsonValue(Object.create({ inherited: true })))
  })

  it('accepts null-prototype objects without prototype pollution', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as unknown
    const validated = validateJsonObject(input)

    expect(Object.getPrototypeOf(validated)).toBeNull()
    expect(Object.hasOwn(validated, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('rejects accessors without invoking them', () => {
    let invoked = false
    const input = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        invoked = true
        return 'value'
      },
    })

    expectInvalid(() => validateJsonValue(input))
    expect(invoked).toBe(false)
  })

  it('rejects symbol and non-enumerable properties', () => {
    expectInvalid(() => validateJsonValue({ [Symbol('secret')]: 'value' }))
    expectInvalid(() => validateJsonValue(Object.defineProperty({}, 'hidden', { value: 'value' })))
  })

  it('rejects cyclic and sparse collections', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const sparse = Array.from({ length: 2 }) as unknown[]
    delete sparse[0]

    expectInvalid(() => validateJsonValue(cyclic))
    expectInvalid(() => validateJsonValue(sparse))
  })

  it('enforces depth, key, array, string, and byte limits', () => {
    expectInvalid(() => validateJsonValue({ a: { b: {} } }, { maxDepth: 1 }))
    expectInvalid(() => validateJsonValue({ a: 1, b: 2 }, { maxKeys: 1 }))
    expectInvalid(() => validateJsonValue([1, 2], { maxArrayLength: 1 }))
    expectInvalid(() => validateJsonValue('abcd', { maxStringLength: 3 }))
    expectInvalid(() => validateJsonValue('éé', { maxBytes: 5 }))
  })

  it('enforces the byte limit cumulatively before cloning the full value', () => {
    const shared = 'x'.repeat(64)
    const input = Array.from({ length: 1_024 }, () => shared)

    const error = expectInvalid(() => validateJsonValue(input, {
      maxArrayLength: input.length,
      maxBytes: 256,
      maxStringLength: shared.length,
    }))

    expect(error.safeDetails).toEqual({ reason: 'max_bytes' })
  })

  it.each([
    null,
    true,
    -0,
    'quote" slash\\ controls\b\t\n\f\r\u0000',
    'ASCII é 😀 \ud800',
    [1, 'two', false],
    { nested: { value: 'é' }, list: [null] },
  ])('matches JSON.stringify byte accounting for %j', (value) => {
    const encodedBytes = utf8ByteLength(JSON.stringify(value))
    const canonical = canonicalStringifyJson(value, { maxBytes: encodedBytes })

    expect(utf8ByteLength(canonical)).toBe(encodedBytes)
    if (encodedBytes > 1) {
      const error = expectInvalid(() => canonicalStringifyJson(value, {
        maxBytes: encodedBytes - 1,
      }))
      expect(error.safeDetails).toEqual({ reason: 'max_bytes' })
    }
  })

  it('rejects invalid validation limits', () => {
    const error = expectInvalid(() => validateJsonValue(null, { maxDepth: -1 }))
    expect(error.safeDetails).toEqual({ reason: 'invalid_limit' })
  })

  it('measures UTF-8 bytes rather than UTF-16 code units', () => {
    expect(utf8ByteLength('A')).toBe(1)
    expect(utf8ByteLength('😀')).toBe(4)
  })
})
