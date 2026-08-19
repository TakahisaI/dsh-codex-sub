import { randomUUID } from 'node:crypto'
import { format, inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { CodexError } from '../src/core/errors.js'
import {
  fromPiAiOAuthCredential,
  toPiAiOAuthCredential,
} from '../src/piai/credential-conversion.js'

function printable(error: CodexError): string {
  return [String(error), error.stack ?? '', JSON.stringify(error), inspect(error), format(error)].join('\n')
}

function expectUpstreamFailure(operation: () => unknown, sentinels: readonly string[]): CodexError {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(CodexError)
    const codexError = error as CodexError
    expect(codexError.code).toBe('CODEX_UPSTREAM_PROTOCOL')
    for (const sentinel of sentinels) {
      expect(printable(codexError)).not.toContain(sentinel)
    }
    return codexError
  }
  throw new Error('Expected credential conversion to fail.')
}

describe('pi-ai OAuth credential conversion', () => {
  it('round-trips provider fields through the bounded project document', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const refresh = `REFRESH_SENTINEL_${randomUUID()}`
    const account = `ACCOUNT_SENTINEL_${randomUUID()}`
    const credential = {
      type: 'oauth' as const,
      access,
      refresh,
      expires: 1_900_000_000_000,
      accountId: account,
      nested: { workspace: 'fixture', flags: [true, null, 2] },
    }

    const document = fromPiAiOAuthCredential(credential)
    const converted = toPiAiOAuthCredential(document)

    expect(document).toEqual({
      schemaVersion: 1,
      provider: 'openai-codex',
      credential: {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: credential.expires,
        providerData: {
          accountId: account,
          nested: { workspace: 'fixture', flags: [true, null, 2] },
        },
      },
    })
    expect(converted).toEqual(credential)
    expect(converted).not.toBe(credential)
  })

  it('preserves an own __proto__ provider field without prototype pollution', () => {
    const credential = JSON.parse(`{
      "type":"oauth",
      "access":"ACCESS_SENTINEL_${randomUUID()}",
      "refresh":"REFRESH_SENTINEL_${randomUUID()}",
      "expires":1900000000000,
      "__proto__":{"polluted":true}
    }`) as unknown

    const converted = toPiAiOAuthCredential(fromPiAiOAuthCredential(credential))

    expect(Object.hasOwn(converted, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('rejects non-OAuth, malformed, accessor, and oversized credentials safely', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const refresh = `REFRESH_SENTINEL_${randomUUID()}`
    let accessorInvoked = false
    const accessorCredential = Object.defineProperty({
      type: 'oauth',
      refresh,
      expires: 1_900_000_000_000,
    }, 'access', {
      enumerable: true,
      get() {
        accessorInvoked = true
        return access
      },
    })

    expectUpstreamFailure(
      () => fromPiAiOAuthCredential({ type: 'api_key', key: access }),
      [access],
    )
    expectUpstreamFailure(
      () => fromPiAiOAuthCredential({
        type: 'oauth',
        access,
        refresh,
        expires: 0,
      }),
      [access, refresh],
    )
    expectUpstreamFailure(() => fromPiAiOAuthCredential(accessorCredential), [access, refresh])
    expect(accessorInvoked).toBe(false)
    expectUpstreamFailure(
      () => fromPiAiOAuthCredential({
        type: 'oauth',
        access,
        refresh,
        expires: 1_900_000_000_000,
        providerField: 'x'.repeat(16_385),
      }),
      [access, refresh],
    )
  })

  it('revalidates project documents and rejects shadowing provider data', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const refresh = `REFRESH_SENTINEL_${randomUUID()}`
    expect(() => toPiAiOAuthCredential({
      schemaVersion: 1,
      provider: 'openai-codex',
      credential: {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: 1_900_000_000_000,
        providerData: { access: 'shadow' },
      },
    })).toThrow(CodexError)
  })
})
