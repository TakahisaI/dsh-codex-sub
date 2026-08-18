import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { CODEX_ERROR_CODES, CodexError, isCodexError } from '../src/core/errors.js'

describe('CodexError', () => {
  it('carries a stable code and frozen safe details', () => {
    const error = new CodexError('Authentication is required.', 'CODEX_AUTH_REQUIRED', {
      safeDetails: { operation: 'request' },
    })

    expect(error).toBeInstanceOf(Error)
    expect(isCodexError(error)).toBe(true)
    expect(error.code).toBe('CODEX_AUTH_REQUIRED')
    expect(error.safeDetails).toEqual({ operation: 'request' })
    expect(Object.isFrozen(error.safeDetails)).toBe(true)
  })

  it('does not serialize or print an internal cause', () => {
    const sentinel = `ACCESS_SENTINEL_${randomUUID()}`
    const error = new CodexError('Authentication failed.', 'CODEX_AUTH_LOGIN_FAILED', {
      cause: new Error(sentinel),
      safeDetails: { phase: 'login' },
    })
    const printable = [String(error), error.stack ?? '', JSON.stringify(error)].join('\n')

    expect(error.cause).toBeInstanceOf(Error)
    expect(printable).not.toContain(sentinel)
  })

  it('defines exactly the documented error taxonomy', () => {
    expect(CODEX_ERROR_CODES).toEqual([
      'CODEX_AUTH_REQUIRED',
      'CODEX_REAUTH_REQUIRED',
      'CODEX_AUTH_STORAGE_INVALID',
      'CODEX_AUTH_STORAGE_INSECURE',
      'CODEX_AUTH_LOGIN_FAILED',
      'CODEX_PROVIDER_CONFLICT',
      'CODEX_INCOMPATIBLE_RUNTIME',
      'CODEX_UPSTREAM_PROTOCOL',
    ])
  })
})
