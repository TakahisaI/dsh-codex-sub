import type { JsonObject, JsonValue } from './json.js'

export const REDACTED_VALUE = '[REDACTED]' as const

const BEARER_PATTERN = /(\bBearer\s+)[^\s,;]+/giu
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu
const SENSITIVE_TEXT_KEY_PATTERN = '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|authorization[_-]?code|oauth[_-]?code|account[_-]?(?:id|identifier)|chatgpt[_-]?account[_-]?id|code[_-]?(?:verifier|challenge)|pkce[_-]?(?:verifier|challenge))'
const QUERY_SECRET_PATTERN = new RegExp(
  `([?&](?:code|${SENSITIVE_TEXT_KEY_PATTERN})=)([^&#\\s]*)`,
  'giu',
)
const ASSIGNMENT_SECRET_PATTERN = new RegExp(
  `((?:"${SENSITIVE_TEXT_KEY_PATTERN}"|'${SENSITIVE_TEXT_KEY_PATTERN}'|${SENSITIVE_TEXT_KEY_PATTERN})\\s*[:=]\\s*)(["']?)([^"'\\s,;&}]+)\\2`,
  'giu',
)

const SENSITIVE_KEYS = new Set([
  'access',
  'accesstoken',
  'accountid',
  'accountidentifier',
  'authorization',
  'authorizationcode',
  'bearertoken',
  'chatgptaccountid',
  'clientsecret',
  'codechallenge',
  'codeverifier',
  'credential',
  'devicecode',
  'idtoken',
  'oauthcode',
  'pkcechallenge',
  'pkceverifier',
  'refresh',
  'refreshtoken',
  'token',
  'usercode',
])

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
])

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizedKey(key))
}

export function redactText(value: string): string {
  return value
    .replace(BEARER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(ASSIGNMENT_SECRET_PATTERN, `$1$2${REDACTED_VALUE}$2`)
    .replace(JWT_PATTERN, REDACTED_VALUE)
}

export function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return redactText(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry))
  }

  const output = Object.create(null) as JsonObject
  for (const [key, entryValue] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactJsonValue(entryValue)
  }
  return output
}
export function redactHeaders(
  headers: Readonly<Record<string, string | null | undefined>>,
): Record<string, string | null | undefined> {
  const output: Record<string, string | null | undefined> = Object.create(null) as Record<
    string,
    string | null | undefined
  >
  for (const [key, value] of Object.entries(headers)) {
    output[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) || isSensitiveKey(key)
      ? REDACTED_VALUE
      : typeof value === 'string'
        ? redactText(value)
        : value
  }
  return output
}
