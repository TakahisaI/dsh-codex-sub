import { Console } from 'node:console'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { format, inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  CODEX_ERROR_CODES,
  CodexError,
  getCodexErrorCause,
  isCodexError,
} from '../src/core/errors.js'
import type { JsonPrimitive } from '../src/core/json.js'

describe('CodexError', () => {
  it('carries a stable code and frozen safe details', () => {
    const details: Record<string, JsonPrimitive> = { operation: 'request' }
    const error = new CodexError('Authentication is required.', 'CODEX_AUTH_REQUIRED', {
      safeDetails: details,
    })

    details['operation'] = 'mutated'

    expect(error).toBeInstanceOf(Error)
    expect(isCodexError(error)).toBe(true)
    expect(error.code).toBe('CODEX_AUTH_REQUIRED')
    expect(error.safeDetails).toEqual({ operation: 'request' })
    expect(error.safeDetails).not.toBe(details)
    expect(Object.isFrozen(error.safeDetails)).toBe(true)
    expect(() => {
      const mutable = error.safeDetails as Record<string, JsonPrimitive>
      mutable['operation'] = 'mutated again'
    }).toThrow(TypeError)
  })

  it('rejects nested or otherwise non-primitive safe details', () => {
    const nested = {
      diagnostic: { mutable: true },
    } as unknown as Readonly<Record<string, JsonPrimitive>>
    const nonFinite = {
      diagnostic: Number.POSITIVE_INFINITY,
    } as Readonly<Record<string, JsonPrimitive>>

    expect(() => new CodexError('Invalid details.', 'CODEX_UPSTREAM_PROTOCOL', {
      safeDetails: nested,
    })).toThrow('CodexError safe details must be a plain record of JSON primitives.')
    expect(() => new CodexError('Invalid details.', 'CODEX_UPSTREAM_PROTOCOL', {
      safeDetails: nonFinite,
    })).toThrow('CodexError safe details must be a plain record of JSON primitives.')
  })

  it('does not expose a failure thrown while inspecting safe details', () => {
    const sentinel = `ACCESS_SENTINEL_${randomUUID()}`
    const hostileDetails = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(sentinel)
      },
    }) as Readonly<Record<string, JsonPrimitive>>

    expect(() => new CodexError('Invalid details.', 'CODEX_UPSTREAM_PROTOCOL', {
      safeDetails: hostileDetails,
    })).toThrow('CodexError safe details must be a plain record of JSON primitives.')
    try {
      new CodexError('Invalid details.', 'CODEX_UPSTREAM_PROTOCOL', {
        safeDetails: hostileDetails,
      })
    } catch (error) {
      expect(inspect(error)).not.toContain(sentinel)
    }
  })

  it('does not serialize or print an internal cause', () => {
    const sentinel = `ACCESS_SENTINEL_${randomUUID()}`
    const cause = new Error(sentinel)
    const error = new CodexError('Authentication failed.', 'CODEX_AUTH_LOGIN_FAILED', {
      cause,
      safeDetails: { phase: 'login' },
    })
    let consoleOutput = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        consoleOutput += String(chunk)
        callback()
      },
    })
    new Console({ stdout: output, stderr: output }).error(error)
    const printable = [
      String(error),
      error.stack ?? '',
      JSON.stringify(error),
      inspect(error),
      format(error),
      consoleOutput,
    ].join('\n')

    expect(Object.hasOwn(error, 'cause')).toBe(false)
    expect(error.cause).toBeUndefined()
    expect(getCodexErrorCause(error)).toBe(cause)
    expect(printable).not.toContain(sentinel)
  })

  it('defines exactly the documented error taxonomy', () => {
    expect(CODEX_ERROR_CODES).toEqual([
      'CODEX_AUTH_REQUIRED',
      'CODEX_REAUTH_REQUIRED',
      'CODEX_AUTH_REFRESH_FAILED',
      'CODEX_AUTH_STORAGE_INVALID',
      'CODEX_AUTH_STORAGE_INSECURE',
      'CODEX_AUTH_LOGIN_FAILED',
      'CODEX_PROVIDER_CONFLICT',
      'CODEX_INCOMPATIBLE_RUNTIME',
      'CODEX_UPSTREAM_PROTOCOL',
    ])
  })
})
