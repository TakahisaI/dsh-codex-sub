import { randomUUID } from 'node:crypto'
import { format, inspect } from 'node:util'

import type {
  AuthInteraction,
  ModelAuth,
  OAuthAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { describe, expect, it, vi } from 'vitest'

import type { CodexCredentialVault } from '../src/core/contracts.js'
import { CodexError } from '../src/core/errors.js'
import { PiAiCodexAuthService } from '../src/piai/auth-service.js'
import { fromPiAiOAuthCredential } from '../src/piai/credential-conversion.js'
import { MemoryCredentialVault } from './helpers/memory-credential-vault.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function credential(expires: number, sequence = 1): OAuthCredential {
  return {
    type: 'oauth',
    access: `ACCESS_SENTINEL_${randomUUID()}`,
    refresh: `REFRESH_SENTINEL_${randomUUID()}`,
    expires,
    accountId: `ACCOUNT_SENTINEL_${randomUUID()}`,
    sequence,
  }
}

function providerWithOAuth(oauth: OAuthAuth): Provider {
  const provider = openaiCodexProvider()
  return {
    ...provider,
    auth: Object.freeze({ oauth }),
  }
}

async function waitForGate(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await gate
    return
  }
  if (signal.aborted) {
    throw new DOMException('provider abort detail', 'AbortError')
  }

  let onAbort = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(new DOMException('provider abort detail', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([gate, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

class OAuthProbe implements OAuthAuth {
  readonly name = 'Fake Codex OAuth'
  readonly refreshStarted = deferred<void>()

  loginCalls = 0
  refreshCompletions = 0
  refreshCalls = 0
  honorRefreshSignal = true
  toAuthCalls = 0
  refreshSignal: AbortSignal | undefined
  loginError: unknown
  refreshError: unknown
  refreshGate: Promise<void> | undefined
  toAuthError: unknown
  toAuthFactory: ((credential: OAuthCredential) => ModelAuth) | undefined

  constructor(
    readonly loginCredential: OAuthCredential,
    readonly refreshedCredential: OAuthCredential,
  ) {}

  async login(interaction: AuthInteraction): Promise<OAuthCredential> {
    this.loginCalls += 1
    interaction.notify({ type: 'progress', message: 'fake progress' })
    await interaction.prompt({ type: 'text', message: 'fake prompt' })
    if (this.loginError !== undefined) {
      throw this.loginError
    }
    return this.loginCredential
  }

  async refresh(
    _credential: OAuthCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    this.refreshCalls += 1
    this.refreshSignal = signal
    this.refreshStarted.resolve()
    if (this.refreshGate !== undefined) {
      await waitForGate(this.refreshGate, this.honorRefreshSignal ? signal : undefined)
    }
    if (this.refreshError !== undefined) {
      throw this.refreshError
    }
    this.refreshCompletions += 1
    return this.refreshedCredential
  }

  async toAuth(value: OAuthCredential): Promise<ModelAuth> {
    this.toAuthCalls += 1
    if (this.toAuthError !== undefined) {
      throw this.toAuthError
    }
    return this.toAuthFactory?.(value) ?? { apiKey: value.access }
  }
}

function interaction() {
  return {
    notify: vi.fn(),
    prompt: vi.fn(async () => 'approved'),
  }
}

function printable(error: unknown): string {
  return [String(error), error instanceof Error ? error.stack ?? '' : '', JSON.stringify(error), inspect(error), format(error)].join('\n')
}

describe('PiAiCodexAuthService', () => {
  it('persists provider login through CredentialStore.modify without returning secrets', async () => {
    const now = 1_800_000_000_000
    const loginCredential = credential(now + 60_000)
    const probe = new OAuthProbe(loginCredential, credential(now + 120_000, 2))
    const vault = new MemoryCredentialVault()
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })
    const callbacks = interaction()

    const result = await service.login(callbacks)

    expect(result).toBeUndefined()
    expect(probe.loginCalls).toBe(1)
    expect(callbacks.notify).toHaveBeenCalledOnce()
    expect(callbacks.prompt).toHaveBeenCalledOnce()
    expect(vault.modifyCalls).toBe(1)
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(loginCredential))
    const status = await service.status()
    expect(status).toEqual({ state: 'signed-in', refreshExpected: false })
    expect(JSON.stringify(status)).not.toContain(loginCredential.access)
    expect(JSON.stringify(status)).not.toContain(loginCredential.refresh)
  })

  it.each([
    'CODEX_AUTH_STORAGE_INVALID' as const,
    'CODEX_AUTH_STORAGE_INSECURE' as const,
  ])('preserves %s when Models.login wraps the store failure', async (code) => {
    const now = 1_800_000_000_000
    const probe = new OAuthProbe(credential(now + 60_000), credential(now + 120_000))
    const vault = new MemoryCredentialVault()
    const storageError = new CodexError('Safe storage failure.', code)
    vault.modifyError = storageError
    const service = new PiAiCodexAuthService({
      provider: providerWithOAuth(probe),
      vault,
    })

    await expect(service.login(interaction())).rejects.toBe(storageError)
  })

  it('preserves a wrapped credential protocol failure from provider login', async () => {
    const now = 1_800_000_000_000
    const incompatibleCredential = {
      type: 'oauth',
      access: '',
      refresh: '',
      expires: now + 60_000,
    } as OAuthCredential
    const probe = new OAuthProbe(incompatibleCredential, credential(now + 120_000))
    const vault = new MemoryCredentialVault()
    const service = new PiAiCodexAuthService({
      provider: providerWithOAuth(probe),
      vault,
    })

    await expect(service.login(interaction())).rejects.toMatchObject({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      message: 'The pi-ai OAuth credential is incompatible.',
    })
    expect(vault.peek()).toBeUndefined()
  })

  it('rejects a non-loopback OAuth callback host before provider login', async () => {
    const now = 1_800_000_000_000
    const sentinel = `PATH_SENTINEL_${randomUUID()}`
    const original = process.env['PI_OAUTH_CALLBACK_HOST']
    process.env['PI_OAUTH_CALLBACK_HOST'] = sentinel
    try {
      const probe = new OAuthProbe(credential(now + 60_000), credential(now + 120_000))
      const service = new PiAiCodexAuthService({
        provider: providerWithOAuth(probe),
        vault: new MemoryCredentialVault(),
      })

      let failure: unknown
      try {
        await service.login(interaction())
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        code: 'CODEX_AUTH_LOGIN_FAILED',
        safeDetails: { reason: 'callback_host' },
      })
      expect(printable(failure)).not.toContain(sentinel)
      expect(probe.loginCalls).toBe(0)
    } finally {
      if (original === undefined) {
        delete process.env['PI_OAUTH_CALLBACK_HOST']
      } else {
        process.env['PI_OAUTH_CALLBACK_HOST'] = original
      }
    }
  })

  it.each(['127.0.0.1', '::1'])('allows the explicit loopback callback host %s', async (host) => {
    const now = 1_800_000_000_000
    const original = process.env['PI_OAUTH_CALLBACK_HOST']
    process.env['PI_OAUTH_CALLBACK_HOST'] = host
    try {
      const probe = new OAuthProbe(credential(now + 60_000), credential(now + 120_000))
      const service = new PiAiCodexAuthService({
        provider: providerWithOAuth(probe),
        vault: new MemoryCredentialVault(),
      })

      await expect(service.login(interaction())).resolves.toBeUndefined()
      expect(probe.loginCalls).toBe(1)
    } finally {
      if (original === undefined) {
        delete process.env['PI_OAUTH_CALLBACK_HOST']
      } else {
        process.env['PI_OAUTH_CALLBACK_HOST'] = original
      }
    }
  })

  it('rejects an already-aborted interaction before starting provider login', async () => {
    const now = 1_800_000_000_000
    const probe = new OAuthProbe(credential(now + 60_000), credential(now + 120_000))
    const vault = new MemoryCredentialVault()
    const service = new PiAiCodexAuthService({
      provider: providerWithOAuth(probe),
      vault,
    })
    const controller = new AbortController()
    controller.abort(new Error(`CODE_SENTINEL_${randomUUID()}`))

    await expect(service.login({
      ...interaction(),
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.',
    })
    expect(probe.loginCalls).toBe(0)
    expect(vault.modifyCalls).toBe(0)
  })

  it('reports login success when cancellation arrives after the credential commit', async () => {
    const now = 1_800_000_000_000
    const loginCredential = credential(now + 60_000)
    const probe = new OAuthProbe(loginCredential, credential(now + 120_000))
    const vault = new MemoryCredentialVault()
    const controller = new AbortController()
    vault.afterModify = () => {
      controller.abort()
    }
    const service = new PiAiCodexAuthService({
      provider: providerWithOAuth(probe),
      vault,
    })

    await expect(service.login({
      ...interaction(),
      signal: controller.signal,
    })).resolves.toBeUndefined()
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(loginCredential))
  })

  it('reports signed-out, refresh-expected, invalid, and insecure storage offline', async () => {
    const now = 1_800_000_000_000
    const signedOut = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(new OAuthProbe(credential(now + 1), credential(now + 2))),
      vault: new MemoryCredentialVault(),
    })
    const expired = credential(now - 1)
    const signedIn = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(new OAuthProbe(expired, credential(now + 1))),
      vault: new MemoryCredentialVault(fromPiAiOAuthCredential(expired)),
    })
    const failingVault = (code: 'CODEX_AUTH_STORAGE_INVALID' | 'CODEX_AUTH_STORAGE_INSECURE') => ({
      async read(): Promise<never> {
        throw new CodexError('Safe storage failure.', code)
      },
      async modify(): Promise<never> {
        throw new Error('not called')
      },
      async delete(): Promise<void> {
        throw new Error('not called')
      },
      async inspect() {
        return { state: 'unreadable' as const, permissions: 'unknown' as const }
      },
    }) satisfies CodexCredentialVault

    await expect(signedOut.status()).resolves.toEqual({ state: 'signed-out' })
    await expect(signedIn.status()).resolves.toEqual({
      state: 'signed-in',
      refreshExpected: true,
    })
    await expect(new PiAiCodexAuthService({
      provider: providerWithOAuth(new OAuthProbe(expired, expired)),
      vault: failingVault('CODEX_AUTH_STORAGE_INVALID'),
    }).status()).resolves.toEqual({
      state: 'invalid-storage',
      code: 'CODEX_AUTH_STORAGE_INVALID',
    })
    await expect(new PiAiCodexAuthService({
      provider: providerWithOAuth(new OAuthProbe(expired, expired)),
      vault: failingVault('CODEX_AUTH_STORAGE_INSECURE'),
    }).status()).resolves.toEqual({
      state: 'insecure-storage',
      code: 'CODEX_AUTH_STORAGE_INSECURE',
    })

    const programmingError = new TypeError('programming failure')
    const brokenVault = new MemoryCredentialVault()
    brokenVault.readError = programmingError
    await expect(new PiAiCodexAuthService({
      provider: providerWithOAuth(new OAuthProbe(expired, expired)),
      vault: brokenVault,
    }).status()).rejects.toBe(programmingError)
  })

  it('reports refresh expected throughout the bounded pre-expiry skew window', async () => {
    const now = 1_800_000_000_000
    const withinSkew = credential(now + 30_000)
    const outsideSkew = credential(now + 30_001)

    await expect(new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(new OAuthProbe(withinSkew, credential(now + 60_000))),
      vault: new MemoryCredentialVault(fromPiAiOAuthCredential(withinSkew)),
    }).status()).resolves.toEqual({
      state: 'signed-in',
      refreshExpected: true,
    })
    await expect(new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(new OAuthProbe(outsideSkew, credential(now + 60_000))),
      vault: new MemoryCredentialVault(fromPiAiOAuthCredential(outsideSkew)),
    }).status()).resolves.toEqual({
      state: 'signed-in',
      refreshExpected: false,
    })
  })

  it('fails missing auth before refresh or request-auth derivation and ignores ambient keys', async () => {
    const ambient = `ACCESS_SENTINEL_${randomUUID()}`
    const original = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = ambient
    try {
      const probe = new OAuthProbe(credential(2), credential(3))
      const service = new PiAiCodexAuthService({
        provider: providerWithOAuth(probe),
        vault: new MemoryCredentialVault(),
      })

      await expect(service.resolveRequestAuth()).rejects.toMatchObject({
        code: 'CODEX_AUTH_REQUIRED',
      })
      expect(probe.refreshCalls).toBe(0)
      expect(probe.toAuthCalls).toBe(0)
    } finally {
      if (original === undefined) {
        delete process.env['OPENAI_API_KEY']
      } else {
        process.env['OPENAI_API_KEY'] = original
      }
    }
  })

  it('derives fresh request auth exactly once and freezes it for the request', async () => {
    const now = 1_800_000_000_000
    const current = credential(now + 60_000)
    const probe = new OAuthProbe(current, credential(now + 120_000, 2))
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(current))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })

    const auth = await service.resolveRequestAuth()
    await vault.modify(async () => fromPiAiOAuthCredential(credential(now + 120_000, 3)))

    expect(auth).toEqual({ bearerToken: current.access })
    expect(Object.isFrozen(auth)).toBe(true)
    expect(auth.bearerToken).toBe(current.access)
    expect(probe.refreshCalls).toBe(0)
    expect(probe.toAuthCalls).toBe(1)
  })

  it('refreshes inside the pre-expiry skew window', async () => {
    const now = 1_800_000_000_000
    const expiring = credential(now + 30_000)
    const refreshed = credential(now + 60_000, 2)
    const probe = new OAuthProbe(expiring, refreshed)
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expiring))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })

    await expect(service.resolveRequestAuth()).resolves.toEqual({
      bearerToken: refreshed.access,
    })
    expect(probe.refreshCalls).toBe(1)
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(refreshed))
  })

  it.each([
    ['baseUrl', (access: string): ModelAuth => ({ apiKey: access, baseUrl: 'https://example.test' })],
    ['headers', (access: string): ModelAuth => ({ apiKey: access, headers: { 'x-auth': 'value' } })],
  ])('rejects an unsupported request-auth %s field instead of discarding it', async (_field, auth) => {
    const now = 1_800_000_000_000
    const current = credential(now + 60_000)
    const probe = new OAuthProbe(current, credential(now + 120_000))
    probe.toAuthFactory = (value) => auth(value.access)
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault: new MemoryCredentialVault(fromPiAiOAuthCredential(current)),
    })

    await expect(service.resolveRequestAuth()).rejects.toMatchObject({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'request_auth_fields' },
    })
  })

  it('refreshes concurrent expired requests once inside the vault writer', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1)
    const refreshed = credential(now + 60_000, 2)
    const probe = new OAuthProbe(expired, refreshed)
    const gate = deferred<void>()
    probe.refreshGate = gate.promise
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expired))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })

    const first = service.resolveRequestAuth()
    await probe.refreshStarted.promise
    const second = service.resolveRequestAuth()
    await Promise.resolve()
    gate.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { bearerToken: refreshed.access },
      { bearerToken: refreshed.access },
    ])
    expect(probe.refreshCalls).toBe(1)
    expect(probe.toAuthCalls).toBe(2)
    expect(vault.maxActiveWriters).toBe(1)
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(refreshed))
  })

  it('serializes logout after an in-progress refresh', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1)
    const refreshed = credential(now + 60_000, 2)
    const probe = new OAuthProbe(expired, refreshed)
    const gate = deferred<void>()
    probe.refreshGate = gate.promise
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expired))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })

    const resolving = service.resolveRequestAuth()
    await probe.refreshStarted.promise
    let logoutSettled = false
    const loggingOut = service.logout().then(() => {
      logoutSettled = true
    })
    await Promise.resolve()
    expect(logoutSettled).toBe(false)
    gate.resolve()

    await expect(resolving).resolves.toEqual({ bearerToken: refreshed.access })
    await loggingOut
    expect(vault.maxActiveWriters).toBe(1)
    expect(vault.peek()).toBeUndefined()
  })

  it('maps an unclassified provider refresh failure safely without claiming reauthentication', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1)
    const sentinel = `REFRESH_SENTINEL_${randomUUID()}`
    const probe = new OAuthProbe(expired, credential(now + 60_000))
    probe.refreshError = new Error(`invalid_grant ${sentinel}`)
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expired))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })

    let failure: unknown
    try {
      await service.resolveRequestAuth()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(CodexError)
    expect(failure).toMatchObject({
      code: 'CODEX_AUTH_REFRESH_FAILED',
      safeDetails: { reason: 'provider_unclassified' },
    })
    expect(printable(failure)).not.toContain(sentinel)
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(expired))
  })

  it('bounds safe lock-contention retries while the stored credential remains stale', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1)
    const sentinel = `PATH_SENTINEL_${randomUUID()}`
    const probe = new OAuthProbe(expired, credential(now + 60_000))
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expired))
    vault.modifyError = new CodexError(
      'Credential storage is invalid.',
      'CODEX_AUTH_STORAGE_INVALID',
      {
        cause: new Error(sentinel),
        safeDetails: { reason: 'lock_failed' },
      },
    )
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })

    let failure: unknown
    try {
      await service.resolveRequestAuth()
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'CODEX_AUTH_REFRESH_FAILED',
      safeDetails: { reason: 'lock_contention' },
    })
    expect(printable(failure)).not.toContain(sentinel)
    expect(vault.modifyCalls).toBe(3)
    expect(probe.refreshCalls).toBe(0)
  })

  it('releases the vault writer after the bounded refresh deadline', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1)
    const probe = new OAuthProbe(expired, credential(now + 60_000))
    const gate = deferred<void>()
    probe.refreshGate = gate.promise
    probe.honorRefreshSignal = false
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expired))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      refreshTimeoutMs: 10,
      vault,
    })

    await expect(service.resolveRequestAuth()).rejects.toMatchObject({
      code: 'CODEX_AUTH_REFRESH_FAILED',
      safeDetails: { reason: 'deadline' },
    })
    expect(vault.activeWriters).toBe(0)
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(expired))
    gate.resolve()
    await vi.waitFor(() => {
      expect(probe.refreshCompletions).toBe(1)
    })
    expect(vault.peek()).toEqual(fromPiAiOAuthCredential(expired))
    await expect(service.logout()).resolves.toBeUndefined()
    expect(vault.peek()).toBeUndefined()
  })

  it('cancels one waiter without cancelling or duplicating its shared refresh', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1)
    const probe = new OAuthProbe(expired, credential(now + 60_000))
    const gate = deferred<void>()
    probe.refreshGate = gate.promise
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(expired))
    vault.wrapOperationErrors = true
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(probe),
      vault,
    })
    const controller = new AbortController()

    const cancelledWaiter = service.resolveRequestAuth(controller.signal)
    await probe.refreshStarted.promise
    const survivingWaiter = service.resolveRequestAuth()
    controller.abort(new Error(`ACCESS_SENTINEL_${randomUUID()}`))

    await expect(cancelledWaiter).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.',
    })
    expect(probe.refreshSignal).not.toBe(controller.signal)
    expect(probe.refreshSignal?.aborted).toBe(false)
    gate.resolve()
    await expect(survivingWaiter).resolves.toEqual({
      bearerToken: probe.refreshedCredential.access,
    })
    expect(probe.refreshCalls).toBe(1)
  })

  it('preserves safe storage errors from logout without a ModelsError wrapper', async () => {
    const now = 1_800_000_000_000
    const sentinel = `PATH_SENTINEL_${randomUUID()}`
    const error = new CodexError('Credential storage is insecure.', 'CODEX_AUTH_STORAGE_INSECURE', {
      cause: new Error(sentinel),
      safeDetails: { reason: 'directory_symlink' },
    })
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(credential(now + 60_000)))
    vault.deleteError = error
    const service = new PiAiCodexAuthService({
      provider: providerWithOAuth(new OAuthProbe(credential(now + 1), credential(now + 2))),
      vault,
    })

    await expect(service.logout()).rejects.toBe(error)
    expect(printable(error)).not.toContain(sentinel)
  })

  it('maps login failures safely and preserves cancellation separately', async () => {
    const now = 1_800_000_000_000
    const failureSentinel = `CODE_SENTINEL_${randomUUID()}`
    const failedProbe = new OAuthProbe(credential(now + 1), credential(now + 2))
    failedProbe.loginError = new Error(failureSentinel)
    const failedService = new PiAiCodexAuthService({
      provider: providerWithOAuth(failedProbe),
      vault: new MemoryCredentialVault(),
    })

    await expect(failedService.login(interaction())).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      message: 'ChatGPT authentication failed.',
    })
    try {
      await failedService.login(interaction())
    } catch (error) {
      expect(printable(error)).not.toContain(failureSentinel)
    }

    const cancelledProbe = new OAuthProbe(credential(now + 1), credential(now + 2))
    cancelledProbe.loginError = new DOMException(failureSentinel, 'AbortError')
    const cancelledService = new PiAiCodexAuthService({
      provider: providerWithOAuth(cancelledProbe),
      vault: new MemoryCredentialVault(),
    })
    await expect(cancelledService.login(interaction())).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.',
    })
  })

  it('rejects unsafe interaction accessors without invoking them', async () => {
    const now = 1_800_000_000_000
    const probe = new OAuthProbe(credential(now + 1), credential(now + 2))
    const service = new PiAiCodexAuthService({
      provider: providerWithOAuth(probe),
      vault: new MemoryCredentialVault(),
    })
    let invoked = false
    const unsafe = Object.defineProperty({ notify: (): void => undefined }, 'prompt', {
      enumerable: true,
      get() {
        invoked = true
        return async (): Promise<string> => 'unsafe'
      },
    })

    await expect(service.login(unsafe)).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'interaction_shape' },
    })
    expect(invoked).toBe(false)
    expect(probe.loginCalls).toBe(0)
  })

  it('rejects providers that could consult ambient API-key auth', () => {
    const provider = openaiCodexProvider()
    const oauth = provider.auth.oauth
    if (oauth === undefined) {
      throw new Error('Pinned provider unexpectedly has no OAuth auth.')
    }
    const unsafeProvider: Provider = {
      ...provider,
      auth: {
        apiKey: {
          name: 'unsafe ambient key',
          async resolve() {
            return undefined
          },
        },
        oauth,
      },
    }

    expect(() => new PiAiCodexAuthService({
      provider: unsafeProvider,
      vault: new MemoryCredentialVault(),
    })).toThrowError(expect.objectContaining({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'provider_auth' },
    }))
  })

  it('rejects a non-positive refresh deadline', () => {
    const now = 1_800_000_000_000
    expect(() => new PiAiCodexAuthService({
      provider: providerWithOAuth(new OAuthProbe(credential(now + 1), credential(now + 2))),
      refreshTimeoutMs: 0,
      vault: new MemoryCredentialVault(),
    })).toThrowError(expect.objectContaining({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'refresh_timeout' },
    }))
  })

  it('rejects a negative refresh skew', () => {
    const now = 1_800_000_000_000
    expect(() => new PiAiCodexAuthService({
      provider: providerWithOAuth(new OAuthProbe(credential(now + 1), credential(now + 2))),
      refreshSkewMs: -1,
      vault: new MemoryCredentialVault(),
    })).toThrowError(expect.objectContaining({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'refresh_skew' },
    }))
  })
})
