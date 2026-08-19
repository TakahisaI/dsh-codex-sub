import { PROVIDER_ID } from './constants.js'
import { CodexError, isCodexError } from './errors.js'
import {
  utf8ByteLength,
  validateJsonObject,
} from './json.js'
import type { JsonObject, JsonPrimitive } from './json.js'

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
  const safeDetails: Record<string, JsonPrimitive> = { reason }
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

function readExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  fieldsReason: 'document_fields' | 'credential_fields',
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') {
    invalidDocument(fieldsReason)
  }

  try {
    if (Array.isArray(value)) {
      invalidDocument(fieldsReason)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalidDocument('document_json', undefined, 'invalid_prototype')
    }

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      invalidDocument('document_json', undefined, 'symbol_property')
    }
    const stringKeys = ownKeys as string[]
    if (
      stringKeys.length !== expectedKeys.length
      || !expectedKeys.every((key) => stringKeys.includes(key))
    ) {
      invalidDocument(fieldsReason)
    }

    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) {
        invalidDocument(fieldsReason)
      }
      if (!descriptor.enumerable) {
        invalidDocument('document_json', undefined, 'non_enumerable_property')
      }
      if (!('value' in descriptor)) {
        invalidDocument('document_json', undefined, 'accessor_property')
      }
      fields[key] = descriptor.value
    }
    return Object.freeze(fields)
  } catch (error) {
    if (isCodexError(error)) {
      throw error
    }
    invalidDocument('document_json', error, 'object_inspection')
  }
}

function assertValidToken(value: unknown): asserts value is string {
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

function normalizeProviderData(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object') {
    invalidDocument('provider_data')
  }

  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch (error) {
    invalidDocument('provider_data', error, 'object_inspection')
  }
  if (isArray) {
    invalidDocument('provider_data')
  }

  let normalized: JsonObject
  try {
    normalized = validateJsonObject(value, {
      maxArrayLength: MAX_PROVIDER_DATA_ARRAY_LENGTH,
      maxBytes: MAX_PROVIDER_DATA_BYTES,
      maxDepth: MAX_PROVIDER_DATA_DEPTH,
      maxKeys: MAX_PROVIDER_DATA_KEYS,
      maxStringLength: MAX_PROVIDER_DATA_STRING_LENGTH,
    })
  } catch (error) {
    invalidDocument('provider_data', error, jsonFailureReason(error))
  }

  for (const key of SHADOWED_PROVIDER_DATA_KEYS) {
    if (Object.hasOwn(normalized, key)) {
      invalidDocument('provider_data_shadow')
    }
  }
  return normalized
}

function encodeNormalizedDocument(document: CodexCredentialDocument): string {
  let encoded: string
  try {
    encoded = JSON.stringify({
      schemaVersion: document.schemaVersion,
      provider: document.provider,
      credential: {
        accessToken: document.credential.accessToken,
        refreshToken: document.credential.refreshToken,
        expiresAt: document.credential.expiresAt,
        providerData: document.credential.providerData,
      },
    })
  } catch (error) {
    invalidDocument('document_json', error, 'serialization')
  }

  if (utf8ByteLength(encoded) > MAX_CREDENTIAL_DOCUMENT_BYTES) {
    invalidDocument('max_bytes')
  }
  return encoded
}

export function decodeCredentialDocumentValue(value: unknown): CodexCredentialDocument {
  const documentFields = readExactObject(value, DOCUMENT_KEYS, 'document_fields')
  if (documentFields['schemaVersion'] !== CREDENTIAL_SCHEMA_VERSION) {
    invalidDocument('schema_version')
  }
  if (documentFields['provider'] !== PROVIDER_ID) {
    invalidDocument('provider')
  }

  const credentialFields = readExactObject(
    documentFields['credential'],
    CREDENTIAL_KEYS,
    'credential_fields',
  )
  const accessToken = credentialFields['accessToken']
  const refreshToken = credentialFields['refreshToken']
  assertValidToken(accessToken)
  assertValidToken(refreshToken)

  const expiresAt = credentialFields['expiresAt']
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
      providerData: normalizeProviderData(credentialFields['providerData']),
    }),
  }
  const normalized = Object.freeze(document)
  encodeNormalizedDocument(normalized)
  return normalized
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
  return encodeNormalizedDocument(decodeCredentialDocumentValue(value))
}
