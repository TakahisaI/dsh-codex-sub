import type { OAuthCredential } from '@earendil-works/pi-ai'

import {
  CREDENTIAL_SCHEMA_VERSION,
  MAX_CREDENTIAL_DOCUMENT_BYTES,
  MAX_CREDENTIAL_TOKEN_LENGTH,
  MAX_PROVIDER_DATA_ARRAY_LENGTH,
  MAX_PROVIDER_DATA_DEPTH,
  MAX_PROVIDER_DATA_KEYS,
  decodeCredentialDocumentValue,
} from '../core/credential-document.js'
import type { CodexCredentialDocument } from '../core/credential-document.js'
import { PROVIDER_ID } from '../core/constants.js'
import { CodexError } from '../core/errors.js'
import { validateJsonObject } from '../core/json.js'
import type { JsonObject } from '../core/json.js'

const CANONICAL_PIAI_FIELDS = new Set(['type', 'access', 'refresh', 'expires'])

function unsupportedCredential(reason: string, cause?: unknown): never {
  throw new CodexError('The pi-ai OAuth credential is incompatible.', 'CODEX_UPSTREAM_PROTOCOL', {
    cause,
    safeDetails: { reason },
  })
}

function normalizePiAiCredential(value: unknown): JsonObject {
  try {
    return validateJsonObject(value, {
      maxArrayLength: MAX_PROVIDER_DATA_ARRAY_LENGTH,
      maxBytes: MAX_CREDENTIAL_DOCUMENT_BYTES,
      maxDepth: MAX_PROVIDER_DATA_DEPTH + 1,
      maxKeys: MAX_PROVIDER_DATA_KEYS + CANONICAL_PIAI_FIELDS.size,
      maxStringLength: MAX_CREDENTIAL_TOKEN_LENGTH,
    })
  } catch (error) {
    unsupportedCredential('credential_json', error)
  }
}

export function toPiAiOAuthCredential(value: unknown): OAuthCredential {
  const document = decodeCredentialDocumentValue(value)
  return {
    ...document.credential.providerData,
    type: 'oauth',
    access: document.credential.accessToken,
    refresh: document.credential.refreshToken,
    expires: document.credential.expiresAt,
  }
}

export function fromPiAiOAuthCredential(value: unknown): CodexCredentialDocument {
  const credential = normalizePiAiCredential(value)
  if (credential['type'] !== 'oauth') {
    unsupportedCredential('credential_type')
  }

  const providerData = Object.create(null) as JsonObject
  for (const [key, fieldValue] of Object.entries(credential)) {
    if (!CANONICAL_PIAI_FIELDS.has(key)) {
      providerData[key] = fieldValue
    }
  }

  try {
    return decodeCredentialDocumentValue({
      schemaVersion: CREDENTIAL_SCHEMA_VERSION,
      provider: PROVIDER_ID,
      credential: {
        accessToken: credential['access'],
        refreshToken: credential['refresh'],
        expiresAt: credential['expires'],
        providerData,
      },
    })
  } catch (error) {
    unsupportedCredential('credential_shape', error)
  }
}
