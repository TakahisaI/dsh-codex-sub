import type { JsonValue } from './json.js'

export const CODEX_ERROR_CODES = [
  'CODEX_AUTH_REQUIRED',
  'CODEX_REAUTH_REQUIRED',
  'CODEX_AUTH_STORAGE_INVALID',
  'CODEX_AUTH_STORAGE_INSECURE',
  'CODEX_AUTH_LOGIN_FAILED',
  'CODEX_PROVIDER_CONFLICT',
  'CODEX_INCOMPATIBLE_RUNTIME',
  'CODEX_UPSTREAM_PROTOCOL',
] as const

export type CodexErrorCode = (typeof CODEX_ERROR_CODES)[number]

export interface CodexErrorOptions {
  readonly cause?: unknown
  readonly safeDetails?: Readonly<Record<string, JsonValue>>
}

export class CodexError extends Error {
  readonly code: CodexErrorCode
  readonly safeDetails?: Readonly<Record<string, JsonValue>>

  constructor(message: string, code: CodexErrorCode, options?: CodexErrorOptions) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
    this.name = 'CodexError'
    this.code = code

    if (options?.safeDetails !== undefined) {
      this.safeDetails = Object.freeze({ ...options.safeDetails })
    }
  }
}

export function isCodexError(value: unknown): value is CodexError {
  return value instanceof CodexError
}
