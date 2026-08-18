import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { REDACTED_VALUE, redactHeaders, redactJsonValue, redactText } from '../src/core/redaction.js'

describe('redaction helpers', () => {
  it('redacts bearer tokens, OAuth parameters, assignments, JWTs, and account identifiers', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const refresh = `REFRESH_SENTINEL_${randomUUID()}`
    const account = `ACCOUNT_SENTINEL_${randomUUID()}`
    const code = `CODE_SENTINEL_${randomUUID()}`
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhY2NvdW50In0.signature12345678'
    const input = [
      `Authorization: Bearer ${access}`,
      `https://example.test/callback?code=${code}&account_id=${account}`,
      `refreshToken=${refresh}`,
      jwt,
    ].join('\n')
    const redacted = redactText(input)

    for (const sentinel of [access, refresh, account, code, jwt]) {
      expect(redacted).not.toContain(sentinel)
    }
    expect(redacted.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(5)
  })

  it('redacts sensitive structured keys recursively without changing error codes', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const refresh = `REFRESH_SENTINEL_${randomUUID()}`
    const input = {
      code: 'CODEX_AUTH_REQUIRED',
      nested: {
        accessToken: access,
        refresh_token: refresh,
      },
    }
    const redacted = redactJsonValue(input)

    expect(redacted).toEqual({
      code: 'CODEX_AUTH_REQUIRED',
      nested: {
        accessToken: REDACTED_VALUE,
        refresh_token: REDACTED_VALUE,
      },
    })
    expect(input.nested.accessToken).toBe(access)
  })

  it('redacts serialized credential documents and PKCE material', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const refresh = `REFRESH_SENTINEL_${randomUUID()}`
    const verifier = `VERIFIER_SENTINEL_${randomUUID()}`
    const challenge = `CHALLENGE_SENTINEL_${randomUUID()}`
    const serialized = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-codex',
      credential: {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: 1_900_000_000_000,
        providerData: {
          code_verifier: verifier,
          codeChallenge: challenge,
        },
      },
    })
    const redacted = redactText(serialized)

    for (const sentinel of [access, refresh, verifier, challenge]) {
      expect(redacted).not.toContain(sentinel)
    }
    expect(JSON.parse(redacted)).toEqual({
      schemaVersion: 1,
      provider: 'openai-codex',
      credential: {
        accessToken: REDACTED_VALUE,
        refreshToken: REDACTED_VALUE,
        expiresAt: 1_900_000_000_000,
        providerData: {
          code_verifier: REDACTED_VALUE,
          codeChallenge: REDACTED_VALUE,
        },
      },
    })
    expect(redactJsonValue({
      code_verifier: verifier,
      pkceChallenge: challenge,
    })).toEqual({
      code_verifier: REDACTED_VALUE,
      pkceChallenge: REDACTED_VALUE,
    })
  })

  it('redacts secret-bearing headers and token-like values in other headers', () => {
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const code = `CODE_SENTINEL_${randomUUID()}`
    const redacted = redactHeaders({
      Authorization: `Bearer ${access}`,
      'X-Callback': `https://example.test/?code=${code}`,
      Accept: 'application/json',
    })

    expect(redacted).toEqual({
      Authorization: REDACTED_VALUE,
      'X-Callback': `https://example.test/?code=${REDACTED_VALUE}`,
      Accept: 'application/json',
    })
    expect(JSON.stringify(redacted)).not.toContain(access)
    expect(JSON.stringify(redacted)).not.toContain(code)
  })
})
