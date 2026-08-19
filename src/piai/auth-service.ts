import {
  ModelsError,
  createModels,
} from '@earendil-works/pi-ai'
import type {
  AuthContext,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Models,
  OAuthAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

import type {
  CodexAuthService as CodexAuthServiceContract,
  CodexAuthStatus,
  CodexCredentialVault,
  CodexRequestAuth,
} from '../core/contracts.js'
import { PROVIDER_ID } from '../core/constants.js'
import { CodexError, isCodexError } from '../core/errors.js'
import { PiAiCredentialStore } from './credential-store.js'

export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 30_000

const OAUTH_CALLBACK_HOST_ENVIRONMENT_VARIABLE = 'PI_OAUTH_CALLBACK_HOST'
const SAFE_OAUTH_CALLBACK_HOSTS = new Set(['127.0.0.1', '::1'])

const NO_AMBIENT_AUTH_CONTEXT: AuthContext = Object.freeze({
  async env(_name: string): Promise<undefined> {
    return undefined
  },
  async fileExists(_path: string): Promise<false> {
    return false
  },
})

export interface PiAiCodexAuthServiceOptions {
  readonly vault: CodexCredentialVault
  readonly now?: () => number
  readonly refreshTimeoutMs?: number
  /** Published-provider injection seam for offline contract tests. */
  readonly provider?: Provider
}

function authRequired(): CodexError {
  return new CodexError('ChatGPT authentication is required.', 'CODEX_AUTH_REQUIRED')
}

function reauthRequired(cause?: unknown): CodexError {
  return new CodexError('ChatGPT authentication must be renewed.', 'CODEX_REAUTH_REQUIRED', {
    cause,
  })
}

function loginFailed(reason: string, cause?: unknown): CodexError {
  return new CodexError('ChatGPT authentication failed.', 'CODEX_AUTH_LOGIN_FAILED', {
    cause,
    safeDetails: { reason },
  })
}

function upstreamProtocol(reason: string, cause?: unknown): CodexError {
  return new CodexError('The pi-ai OAuth contract is incompatible.', 'CODEX_UPSTREAM_PROTOCOL', {
    cause,
    safeDetails: { reason },
  })
}

class RefreshCancelled extends CodexError {
  constructor() {
    super('OAuth refresh was cancelled.', 'CODEX_UPSTREAM_PROTOCOL', {
      safeDetails: { reason: 'refresh_cancelled' },
    })
  }
}

function abortFailure(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function hasAbortName(error: Error): boolean {
  if (error instanceof DOMException) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')
      return descriptor?.get !== undefined
        && Reflect.apply(descriptor.get, error, []) === 'AbortError'
    } catch {
      return false
    }
  }

  try {
    let current: object | null = error
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name')
      if (descriptor !== undefined) {
        return 'value' in descriptor && descriptor.value === 'AbortError'
      }
      current = Object.getPrototypeOf(current)
    }
  } catch {
    return false
  }
  return false
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) {
    return true
  }
  return error instanceof Error && hasAbortName(error)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw abortFailure()
  }
}

function assertSafeOAuthCallbackHost(): void {
  const configuredHost = process.env[OAUTH_CALLBACK_HOST_ENVIRONMENT_VARIABLE]
  if (configuredHost !== undefined && !SAFE_OAUTH_CALLBACK_HOSTS.has(configuredHost)) {
    throw loginFailed('callback_host')
  }
}

function projectErrorFromModels(error: unknown): CodexError | undefined {
  if (!(error instanceof ModelsError) || error.code !== 'auth') {
    return undefined
  }
  const cause = error.cause
  return isCodexError(cause)
    && (
      cause.code === 'CODEX_AUTH_LOGIN_FAILED'
      || cause.code === 'CODEX_AUTH_STORAGE_INVALID'
      || cause.code === 'CODEX_AUTH_STORAGE_INSECURE'
      || cause.code === 'CODEX_UPSTREAM_PROTOCOL'
    )
    ? cause
    : undefined
}

function refreshWithDeadline(
  oauth: OAuthAuth,
  credential: OAuthCredential,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  markCancelled: () => void,
): Promise<OAuthCredential> {
  return new Promise<OAuthCredential>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const resolveOnce = (value: OAuthCredential): void => {
      if (!settled) {
        settled = true
        cleanup()
        resolve(value)
      }
    }
    const rejectOnce = (error: unknown): void => {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
    const cancel = (): void => {
      markCancelled()
      rejectOnce(new RefreshCancelled())
    }
    const onAbort = (): void => {
      cancel()
    }

    if (signal?.aborted === true) {
      cancel()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      rejectOnce(reauthRequired())
    }, timeoutMs)

    const rejectRefresh = (error: unknown): void => {
      if (isAbortFailure(error, signal)) {
        cancel()
      } else {
        rejectOnce(reauthRequired(error))
      }
    }
    try {
      void oauth.refresh(credential, signal).then(resolveOnce, rejectRefresh)
    } catch (error) {
      rejectRefresh(error)
    }
  })
}

function readOwnDataProperty(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch (error) {
    throw loginFailed('interaction_shape', error)
  }
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw loginFailed('interaction_shape')
  }
  return descriptor.value
}

function mergeSignals(
  interactionSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (interactionSignal === undefined) {
    return requestSignal
  }
  if (requestSignal === undefined || interactionSignal === requestSignal) {
    return interactionSignal
  }
  return AbortSignal.any([interactionSignal, requestSignal])
}

function normalizeInteraction(value: unknown, signal?: AbortSignal): AuthInteraction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw loginFailed('interaction_shape')
  }

  const promptCallback = readOwnDataProperty(value, 'prompt')
  const notifyCallback = readOwnDataProperty(value, 'notify')
  if (typeof promptCallback !== 'function' || typeof notifyCallback !== 'function') {
    throw loginFailed('interaction_shape')
  }

  let interactionSignal: AbortSignal | undefined
  const signalDescriptor = Object.getOwnPropertyDescriptor(value, 'signal')
  if (signalDescriptor !== undefined) {
    if (!signalDescriptor.enumerable || !('value' in signalDescriptor)) {
      throw loginFailed('interaction_shape')
    }
    if (signalDescriptor.value !== undefined && !(signalDescriptor.value instanceof AbortSignal)) {
      throw loginFailed('interaction_shape')
    }
    interactionSignal = signalDescriptor.value as AbortSignal | undefined
  }

  const combinedSignal = mergeSignals(interactionSignal, signal)
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      const result: unknown = await Reflect.apply(promptCallback, value, [prompt])
      if (typeof result !== 'string') {
        throw loginFailed('interaction_result')
      }
      return result
    },
    notify(event: AuthEvent): void {
      Reflect.apply(notifyCallback, value, [event])
    },
    ...(combinedSignal === undefined ? {} : { signal: combinedSignal }),
  }
}

function requireOAuthCredential(value: unknown): OAuthCredential {
  if (value === null || typeof value !== 'object' || !('type' in value) || value.type !== 'oauth') {
    throw upstreamProtocol('credential_type')
  }
  return value as OAuthCredential
}

function requestTokenFromAuth(value: unknown, credential: OAuthCredential): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw upstreamProtocol('request_auth_shape')
  }
  let descriptor: PropertyDescriptor | undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw upstreamProtocol('request_auth_shape')
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string' || key !== 'apiKey')) {
      throw upstreamProtocol('request_auth_fields')
    }
    descriptor = Object.getOwnPropertyDescriptor(value, 'apiKey')
  } catch (error) {
    if (isCodexError(error)) {
      throw error
    }
    throw upstreamProtocol('request_auth_shape', error)
  }
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !('value' in descriptor)
    || typeof descriptor.value !== 'string'
    || descriptor.value.length === 0
    || descriptor.value !== credential.access
  ) {
    throw upstreamProtocol('request_auth_shape')
  }
  return descriptor.value
}

function statusFromStorageError(error: unknown): CodexAuthStatus {
  if (!isCodexError(error)) {
    throw error
  }
  if (error.code === 'CODEX_AUTH_STORAGE_INSECURE') {
    return Object.freeze({ state: 'insecure-storage', code: error.code })
  }
  if (error.code === 'CODEX_AUTH_STORAGE_INVALID') {
    return Object.freeze({ state: 'invalid-storage', code: error.code })
  }
  throw error
}

export class PiAiCodexAuthService implements CodexAuthServiceContract {
  readonly #models: Models
  readonly #now: () => number
  readonly #oauth: OAuthAuth
  readonly #refreshTimeoutMs: number
  readonly #store: PiAiCredentialStore
  readonly #vault: CodexCredentialVault

  constructor(options: PiAiCodexAuthServiceOptions) {
    const provider = options.provider ?? openaiCodexProvider()
    if (
      provider.id !== PROVIDER_ID
      || provider.auth.oauth === undefined
      || provider.auth.apiKey !== undefined
    ) {
      throw upstreamProtocol('provider_auth')
    }

    this.#vault = options.vault
    this.#store = new PiAiCredentialStore(options.vault)
    this.#oauth = provider.auth.oauth
    this.#now = options.now ?? Date.now
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#refreshTimeoutMs) || this.#refreshTimeoutMs <= 0) {
      throw upstreamProtocol('refresh_timeout')
    }

    const models = createModels({
      authContext: NO_AMBIENT_AUTH_CONTEXT,
      credentials: this.#store,
    })
    models.setProvider(provider)
    this.#models = models
  }

  async login(interaction: unknown, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    assertSafeOAuthCallbackHost()
    let normalizedInteraction: AuthInteraction | undefined
    try {
      normalizedInteraction = normalizeInteraction(interaction, signal)
      throwIfAborted(normalizedInteraction.signal)
      await this.#models.login(PROVIDER_ID, 'oauth', normalizedInteraction)
    } catch (error) {
      if (isAbortFailure(error, normalizedInteraction?.signal ?? signal)) {
        throw abortFailure()
      }
      if (
        isCodexError(error)
        && (
          error.code === 'CODEX_AUTH_LOGIN_FAILED'
          || error.code === 'CODEX_AUTH_STORAGE_INVALID'
          || error.code === 'CODEX_AUTH_STORAGE_INSECURE'
          || error.code === 'CODEX_UPSTREAM_PROTOCOL'
        )
      ) {
        throw error
      }
      const projectError = projectErrorFromModels(error)
      if (projectError !== undefined) {
        throw projectError
      }
      throw loginFailed('oauth', error)
    }
  }

  async status(): Promise<CodexAuthStatus> {
    try {
      const document = await this.#vault.read()
      if (document === undefined) {
        return Object.freeze({ state: 'signed-out' })
      }
      return Object.freeze({
        state: 'signed-in',
        refreshExpected: document.credential.expiresAt <= this.#now(),
      })
    } catch (error) {
      return statusFromStorageError(error)
    }
  }

  async resolveRequestAuth(signal?: AbortSignal): Promise<CodexRequestAuth> {
    throwIfAborted(signal)
    let credential = await this.#store.read(PROVIDER_ID)
    if (credential === undefined) {
      throw authRequired()
    }
    let oauthCredential = requireOAuthCredential(credential)

    if (oauthCredential.expires <= this.#now()) {
      let refreshCancelled = false
      try {
        credential = await this.#store.modify(PROVIDER_ID, async (current) => {
          if (signal?.aborted === true) {
            refreshCancelled = true
            throw new RefreshCancelled()
          }
          if (current === undefined) {
            return undefined
          }
          const currentOAuth = requireOAuthCredential(current)
          if (currentOAuth.expires > this.#now()) {
            return undefined
          }
          return refreshWithDeadline(
            this.#oauth,
            currentOAuth,
            signal,
            this.#refreshTimeoutMs,
            () => {
              refreshCancelled = true
            },
          )
        })
      } catch (error) {
        if (refreshCancelled) {
          throw abortFailure()
        }
        throw error
      }
      if (credential === undefined) {
        throw authRequired()
      }
      oauthCredential = requireOAuthCredential(credential)
      if (oauthCredential.expires <= this.#now()) {
        throw reauthRequired()
      }
    }

    throwIfAborted(signal)
    let auth: unknown
    try {
      auth = await this.#oauth.toAuth(oauthCredential)
    } catch (error) {
      throw upstreamProtocol('request_auth', error)
    }
    throwIfAborted(signal)
    return Object.freeze({
      bearerToken: requestTokenFromAuth(auth, oauthCredential),
    })
  }

  async logout(): Promise<void> {
    await this.#store.delete(PROVIDER_ID)
  }
}
