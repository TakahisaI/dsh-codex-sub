import type { JsonPrimitive } from './json.js'

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
  readonly safeDetails?: Readonly<Record<string, JsonPrimitive>>
}

const internalCauses = new WeakMap<CodexError, unknown>()

function copySafeDetails(
  details: Readonly<Record<string, JsonPrimitive>>,
): Readonly<Record<string, JsonPrimitive>> {
  try {
    const prototype = Object.getPrototypeOf(details)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError()
    }

    const copy = Object.create(null) as Record<string, JsonPrimitive>
    for (const key of Reflect.ownKeys(details)) {
      if (typeof key !== 'string') {
        throw new TypeError()
      }
      const descriptor = Object.getOwnPropertyDescriptor(details, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError()
      }
      const value = descriptor.value as unknown
      if (
        value !== null
        && typeof value !== 'string'
        && typeof value !== 'boolean'
        && (typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw new TypeError()
      }
      copy[key] = value
    }
    return Object.freeze(copy)
  } catch {
    throw new TypeError('CodexError safe details must be a plain record of JSON primitives.')
  }
}

export class CodexError extends Error {
  readonly code: CodexErrorCode
  readonly safeDetails?: Readonly<Record<string, JsonPrimitive>>

  constructor(message: string, code: CodexErrorCode, options?: CodexErrorOptions) {
    // Native Error.cause is rendered by util.inspect and console.error. Keep the
    // original failure out of generic logging while retaining it for internal adapters.
    super(message)
    this.name = 'CodexError'
    this.code = code

    if (options && 'cause' in options) {
      internalCauses.set(this, options.cause)
    }
    if (options?.safeDetails !== undefined) {
      this.safeDetails = copySafeDetails(options.safeDetails)
    }
  }
}

export function isCodexError(value: unknown): value is CodexError {
  return value instanceof CodexError
}

export function getCodexErrorCause(error: CodexError): unknown {
  return internalCauses.get(error)
}
