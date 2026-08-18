import { PROVIDER_ID } from './constants.js'
import { CodexError, isCodexError } from './errors.js'
import {
  utf8ByteLength,
  validateJsonObject,
  validateJsonValue,
} from './json.js'
import type { JsonObject, JsonValue } from './json.js'

export const CREDENTIAL_SCHEMA_VERSION = 1 as const
export const MAX_CREDENTIAL_DOCUMENT_BYTES = 65_536
export const MAX_CREDENTIAL_TOKEN_LENGTH = 16_384
export const MAX_PROVIDER_DATA_BYTES = 32_768
export const MAX_PROVIDER_DATA_DEPTH = 8
export const MAX_PROVIDER_DATA_KEYS = 256
export const MAX_PROVIDER_DATA_ARRAY_LENGTH = 256
export const MAX_PROVIDER_DATA_STRING_LENGTH = 8_192

const DOCUMENT_KEYS = ['schemaVersion', 'provider', 'credential'] as const
const CREDENTIAL_KEYS = ['accessToken', 'refreshToken', 'expiresAt', 'providerData'] as const
const SHADOWED_PROVIDER_DATA_KEYS = new Set(['type', 'access', 'refresh', 'expires'])

export interface CodexCredentialDocumentV1 {
  readonly schemaVersion: typeof CREDENTIAL_SCHEMA_VERSION
  readonly provider: typeof PROVIDER_ID
  readonly credential: {
    readonly accessToken: string
    readonly refreshToken: string
    readonly expiresAt: number
    readonly providerData: JsonObject
  }
}

export type CodexCredentialDocument = CodexCredentialDocumentV1

export type CredentialDocumentFailureReason =
  | 'credential_fields'
  | 'document_json'
  | 'document_fields'
  | 'empty_token'
  | 'expires_at'
  | 'invalid_json'
  | 'max_bytes'
  | 'provider'
  | 'provider_data'
  | 'provider_data_shadow'
  | 'schema_version'
  | 'token_type'
  | 'token_too_long'

function invalidDocument(
  reason: CredentialDocumentFailureReason,
  cause?: unknown,
  jsonReason?: string,
): never {
  const safeDetails: Record<string, JsonValue> = { reason }
  if (jsonReason !== undefined) {
    safeDetails['jsonReason'] = jsonReason
  }
  throw new CodexError('Credential document is invalid.', 'CODEX_AUTH_STORAGE_INVALID', {
    cause,
    safeDetails,
  })
}

function jsonFailureReason(error: unknown): string | undefined {
  if (!isCodexError(error)) {
    return undefined
  }
  const reason = error.safeDetails?.['reason']
  return typeof reason === 'string' ? reason : undefined
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function assertValidToken(value: JsonValue | undefined): asserts value is string {
  if (typeof value !== 'string') {
    invalidDocument('token_type')
  }
  if (value.length === 0) {
    invalidDocument('empty_token')
  }
  if (value.length > MAX_CREDENTIAL_TOKEN_LENGTH) {
    invalidDocument('token_too_long')
  }
}

function normalizeProviderData(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isJsonObject(value)) {
    invalidDocument('provider_data')
  }

  for (const key of SHADOWED_PROVIDER_DATA_KEYS) {
    if (Object.hasOwn(value, key)) {
      invalidDocument('provider_data_shadow')
    }
  }

  try {
    return validateJsonObject(value, {
      maxArrayLength: MAX_PROVIDER_DATA_ARRAY_LENGTH,
      maxBytes: MAX_PROVIDER_DATA_BYTES,
      maxDepth: MAX_PROVIDER_DATA_DEPTH,
      maxKeys: MAX_PROVIDER_DATA_KEYS,
      maxStringLength: MAX_PROVIDER_DATA_STRING_LENGTH,
    })
  } catch (error) {
    invalidDocument('provider_data', error, jsonFailureReason(error))
  }
}

export function decodeCredentialDocumentValue(value: unknown): CodexCredentialDocument {
  let validated: JsonValue
  try {
    validated = validateJsonValue(value, {
      maxArrayLength: MAX_CREDENTIAL_DOCUMENT_BYTES,
      maxBytes: MAX_CREDENTIAL_DOCUMENT_BYTES,
      maxDepth: MAX_PROVIDER_DATA_DEPTH + 16,
      maxKeys: MAX_CREDENTIAL_DOCUMENT_BYTES,
      maxStringLength: MAX_CREDENTIAL_DOCUMENT_BYTES,
    })
  } catch (error) {
    const reason = jsonFailureReason(error)
    if (reason === 'max_bytes' || reason === 'string_too_long') {
      invalidDocument('max_bytes', error)
    }
    invalidDocument('document_json', error, reason)
  }

  if (!isJsonObject(validated) || !hasExactKeys(validated, DOCUMENT_KEYS)) {
    invalidDocument('document_fields')
  }
  if (validated['schemaVersion'] !== CREDENTIAL_SCHEMA_VERSION) {
    invalidDocument('schema_version')
  }
  if (validated['provider'] !== PROVIDER_ID) {
    invalidDocument('provider')
  }

  const credential = validated['credential']
  if (!isJsonObject(credential) || !hasExactKeys(credential, CREDENTIAL_KEYS)) {
    invalidDocument('credential_fields')
  }

  const accessToken = credential['accessToken']
  const refreshToken = credential['refreshToken']
  assertValidToken(accessToken)
  assertValidToken(refreshToken)

  const expiresAt = credential['expiresAt']
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    invalidDocument('expires_at')
  }

  const document: CodexCredentialDocument = {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    provider: PROVIDER_ID,
    credential: Object.freeze({
      accessToken,
      refreshToken,
      expiresAt,
      providerData: normalizeProviderData(credential['providerData']),
    }),
  }
  return Object.freeze(document)
}

export function decodeCredentialDocument(serialized: string): CodexCredentialDocument {
  if (
    serialized.length > MAX_CREDENTIAL_DOCUMENT_BYTES
    || utf8ByteLength(serialized) > MAX_CREDENTIAL_DOCUMENT_BYTES
  ) {
    invalidDocument('max_bytes')
  }

  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (error) {
    invalidDocument('invalid_json', error)
  }
  return decodeCredentialDocumentValue(value)
}

export function encodeCredentialDocument(value: unknown): string {
  const document = decodeCredentialDocumentValue(value)
  const encoded = JSON.stringify({
    schemaVersion: document.schemaVersion,
    provider: document.provider,
    credential: {
      accessToken: document.credential.accessToken,
      refreshToken: document.credential.refreshToken,
      expiresAt: document.credential.expiresAt,
      providerData: document.credential.providerData,
    },
  })

  if (utf8ByteLength(encoded) > MAX_CREDENTIAL_DOCUMENT_BYTES) {
    invalidDocument('max_bytes')
  }
  return encoded
}
