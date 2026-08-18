import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  MAX_CREDENTIAL_DOCUMENT_BYTES,
  MAX_CREDENTIAL_TOKEN_LENGTH,
  MAX_PROVIDER_DATA_ARRAY_LENGTH,
  MAX_PROVIDER_DATA_DEPTH,
  MAX_PROVIDER_DATA_KEYS,
  MAX_PROVIDER_DATA_STRING_LENGTH,
  decodeCredentialDocument,
  decodeCredentialDocumentValue,
  encodeCredentialDocument,
} from '../src/core/credential-document.js'
import type { CodexCredentialDocument } from '../src/core/credential-document.js'
import { CodexError } from '../src/core/errors.js'
import type { JsonObject } from '../src/core/json.js'

function makeDocument(providerData: JsonObject = {}): CodexCredentialDocument {
  return {
    schemaVersion: 1,
    provider: 'openai-codex',
    credential: {
      accessToken: `ACCESS_SENTINEL_${randomUUID()}`,
      refreshToken: `REFRESH_SENTINEL_${randomUUID()}`,
      expiresAt: 1_900_000_000_000,
      providerData,
    },
  }
}

function printableError(error: CodexError): string {
  return [String(error), error.stack ?? '', JSON.stringify(error)].join('\n')
}

function expectInvalid(operation: () => unknown, sentinels: readonly string[] = []): CodexError {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(CodexError)
    const codexError = error as CodexError
    expect(codexError.code).toBe('CODEX_AUTH_STORAGE_INVALID')
    for (const sentinel of sentinels) {
      expect(printableError(codexError)).not.toContain(sentinel)
    }
    return codexError
  }
  throw new Error('Expected credential validation to fail.')
}

describe('credential document codec', () => {
  it('round-trips a version 1 document and detaches provider data', () => {
    const document = makeDocument({
      workspace: 'workspace-fixture',
      nested: { enabled: true, values: [1, null, 'value'] },
    })
    const encoded = encodeCredentialDocument(document)
    const decoded = decodeCredentialDocument(encoded)

    expect(decoded).toEqual(document)
    expect(decoded).not.toBe(document)
    expect(decoded.credential.providerData).not.toBe(document.credential.providerData)
    expect(Object.getPrototypeOf(decoded.credential.providerData)).toBeNull()
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.credential)).toBe(true)
  })

  it('encodes deterministically regardless of provider-data insertion order', () => {
    const document = makeDocument({ zebra: 1, alpha: { z: true, a: false } })
    const reordered: CodexCredentialDocument = {
      ...document,
      credential: {
        ...document.credential,
        providerData: { alpha: { a: false, z: true }, zebra: 1 },
      },
    }

    expect(encodeCredentialDocument(document)).toBe(encodeCredentialDocument(reordered))
    expect(encodeCredentialDocument(document)).toContain(
      '"providerData":{"alpha":{"a":false,"z":true},"zebra":1}',
    )
  })

  it('preserves a __proto__ provider field without polluting prototypes', () => {
    const providerData = JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject
    const decoded = decodeCredentialDocument(encodeCredentialDocument(makeDocument(providerData)))

    expect(Object.hasOwn(decoded.credential.providerData, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('rejects malformed JSON and never includes credential input in errors', () => {
    const sentinel = `ACCESS_SENTINEL_${randomUUID()}`
    expectInvalid(
      () => decodeCredentialDocument(`{"credential":{"accessToken":"${sentinel}"}`),
      [sentinel],
    )
  })

  it('rejects serialized documents above 64 KiB', () => {
    const oversized = ' '.repeat(MAX_CREDENTIAL_DOCUMENT_BYTES + 1)
    const error = expectInvalid(() => decodeCredentialDocument(oversized))
    expect(error.safeDetails).toEqual({ reason: 'max_bytes' })
  })

  it.each([
    [{ schemaVersion: 2 }, 'schema version'],
    [{ provider: 'openai' }, 'provider'],
    [{ extra: true }, 'top-level field'],
  ])('rejects an invalid %s', (replacement, _label) => {
    const document = makeDocument()
    expectInvalid(() => decodeCredentialDocumentValue({ ...document, ...replacement }))
  })

  it('rejects missing and extra credential fields', () => {
    const document = makeDocument()
    const { providerData: _providerData, ...missing } = document.credential

    expectInvalid(() => decodeCredentialDocumentValue({ ...document, credential: missing }))
    expectInvalid(() => decodeCredentialDocumentValue({
      ...document,
      credential: { ...document.credential, extra: true },
    }))
  })

  it('rejects empty, oversized, and non-string tokens without leaking them', () => {
    const document = makeDocument()
    const sentinel = `REFRESH_SENTINEL_${randomUUID()}`

    expectInvalid(() => decodeCredentialDocumentValue({
      ...document,
      credential: { ...document.credential, accessToken: '' },
    }))
    expectInvalid(() => decodeCredentialDocumentValue({
      ...document,
      credential: { ...document.credential, refreshToken: sentinel.repeat(MAX_CREDENTIAL_TOKEN_LENGTH) },
    }), [sentinel])
    expectInvalid(() => decodeCredentialDocumentValue({
      ...document,
      credential: { ...document.credential, accessToken: 42 },
    }))
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expiry %s',
    (expiresAt) => {
      const document = makeDocument()
      expectInvalid(() => decodeCredentialDocumentValue({
        ...document,
        credential: { ...document.credential, expiresAt },
      }))
    },
  )

  it.each(['type', 'access', 'refresh', 'expires'])('rejects provider-data shadow key %s', (key) => {
    expectInvalid(() => decodeCredentialDocumentValue(makeDocument({ [key]: 'shadow' })))
  })

  it('rejects non-object and non-finite provider data', () => {
    const document = makeDocument()
    expectInvalid(() => decodeCredentialDocumentValue({
      ...document,
      credential: { ...document.credential, providerData: [] },
    }))
    expectInvalid(() => decodeCredentialDocumentValue(makeDocument({ value: Number.NaN })))
  })

  it('enforces provider-data depth, key, array, and string bounds', () => {
    let deep: JsonObject = {}
    for (let index = 0; index <= MAX_PROVIDER_DATA_DEPTH; index += 1) {
      deep = { nested: deep }
    }
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MAX_PROVIDER_DATA_KEYS + 1 }, (_, index) => [`key${String(index)}`, index]),
    )

    expectInvalid(() => decodeCredentialDocumentValue(makeDocument(deep)))
    expectInvalid(() => decodeCredentialDocumentValue(makeDocument(tooManyKeys)))
    expectInvalid(() => decodeCredentialDocumentValue(makeDocument({
      values: Array.from({ length: MAX_PROVIDER_DATA_ARRAY_LENGTH + 1 }, () => null),
    })))
    expectInvalid(() => decodeCredentialDocumentValue(makeDocument({
      value: 'x'.repeat(MAX_PROVIDER_DATA_STRING_LENGTH + 1),
    })))
  })

  it('rejects an encoded candidate whose combined fields exceed 64 KiB', () => {
    const document: CodexCredentialDocument = {
      schemaVersion: 1,
      provider: 'openai-codex',
      credential: {
        accessToken: 'a'.repeat(MAX_CREDENTIAL_TOKEN_LENGTH),
        refreshToken: 'r'.repeat(MAX_CREDENTIAL_TOKEN_LENGTH),
        expiresAt: 1_900_000_000_000,
        providerData: {
          a: 'x'.repeat(8_178),
          b: 'x'.repeat(8_178),
          c: 'x'.repeat(8_178),
          d: 'x'.repeat(8_178),
        },
      },
    }

    const error = expectInvalid(() => encodeCredentialDocument(document))
    expect(error.code).toBe('CODEX_AUTH_STORAGE_INVALID')
  })
})
