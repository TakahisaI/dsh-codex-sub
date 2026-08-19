import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AuthInteraction,
  ModelAuth,
  OAuthAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  CodexCredentialVault,
  CredentialVaultInspection,
} from '../src/core/contracts.js'
import type { CodexCredentialDocument } from '../src/core/credential-document.js'
import { isCodexError } from '../src/core/errors.js'
import { PiAiCodexAuthService } from '../src/piai/auth-service.js'
import { fromPiAiOAuthCredential } from '../src/piai/credential-conversion.js'
import { FileCredentialVault } from '../src/storage/file-credential-vault.js'

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

function credential(expires: number, sequence: number): OAuthCredential {
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

class SlowOAuth implements OAuthAuth {
  readonly name = 'Slow fake Codex OAuth'
  readonly started = deferred<void>()
  readonly signals: AbortSignal[] = []
  calls = 0

  constructor(
    readonly refreshed: OAuthCredential,
    readonly gate: Promise<void>,
  ) {}

  async login(_interaction: AuthInteraction): Promise<OAuthCredential> {
    throw new Error('not used')
  }

  async refresh(
    _credential: OAuthCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    this.calls += 1
    if (signal !== undefined) {
      this.signals.push(signal)
    }
    this.started.resolve()
    await this.gate
    return this.refreshed
  }

  async toAuth(value: OAuthCredential): Promise<ModelAuth> {
    return { apiKey: value.access }
  }
}

class ObservedVault implements CodexCredentialVault {
  lockFailures = 0
  afterLockFailure: ((count: number) => Promise<void>) | undefined

  constructor(readonly inner: FileCredentialVault) {}

  read(): Promise<CodexCredentialDocument | undefined> {
    return this.inner.read()
  }

  async modify(
    operation: (
      current: CodexCredentialDocument | undefined,
    ) => Promise<CodexCredentialDocument | undefined>,
  ): Promise<CodexCredentialDocument | undefined> {
    try {
      return await this.inner.modify(operation)
    } catch (error) {
      if (
        isCodexError(error)
        && error.code === 'CODEX_AUTH_STORAGE_INVALID'
        && error.safeDetails?.['reason'] === 'lock_failed'
      ) {
        this.lockFailures += 1
        await this.afterLockFailure?.(this.lockFailures)
      }
      throw error
    }
  }

  delete(): Promise<void> {
    return this.inner.delete()
  }

  inspect(): Promise<CredentialVaultInspection> {
    return this.inner.inspect()
  }
}

const ORIGINAL_DSH_HOME = process.env['DSH_HOME']
let temporaryRoot = ''

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-refresh-'))
  process.env['DSH_HOME'] = join(temporaryRoot, 'dsh-home')
})

afterEach(async () => {
  if (ORIGINAL_DSH_HOME === undefined) {
    delete process.env['DSH_HOME']
  } else {
    process.env['DSH_HOME'] = ORIGINAL_DSH_HOME
  }
  await rm(temporaryRoot, { force: true, recursive: true })
})

describe('OAuth refresh with FileCredentialVault', () => {
  it('keeps one shared refresh alive when one waiter is cancelled', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1, 1)
    const refreshed = credential(now + 60_000, 2)
    const gate = deferred<void>()
    const oauth = new SlowOAuth(refreshed, gate.promise)
    const vault = new FileCredentialVault()
    await vault.modify(async () => fromPiAiOAuthCredential(expired))
    const service = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(oauth),
      vault,
    })
    const controller = new AbortController()

    const cancelled = service.resolveRequestAuth(controller.signal)
    await oauth.started.promise
    const surviving = service.resolveRequestAuth()
    controller.abort(new Error(`ACCESS_SENTINEL_${randomUUID()}`))

    await expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.',
    })
    expect(oauth.signals).toHaveLength(1)
    expect(oauth.signals[0]).not.toBe(controller.signal)
    expect(oauth.signals[0]?.aborted).toBe(false)

    gate.resolve()
    await expect(surviving).resolves.toEqual({ bearerToken: refreshed.access })
    expect(oauth.calls).toBe(1)
    await expect(vault.read()).resolves.toEqual(fromPiAiOAuthCredential(refreshed))
  })

  it('re-reads and reuses another service instance refresh after lock contention', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1, 1)
    const refreshed = credential(now + 60_000, 2)
    const gate = deferred<void>()
    const oauth = new SlowOAuth(refreshed, gate.promise)
    const setupVault = new FileCredentialVault()
    await setupVault.modify(async () => fromPiAiOAuthCredential(expired))
    const firstVault = new ObservedVault(new FileCredentialVault())
    const secondVault = new ObservedVault(new FileCredentialVault())
    const firstService = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(oauth),
      vault: firstVault,
    })
    const secondService = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(oauth),
      vault: secondVault,
    })

    const first = firstService.resolveRequestAuth()
    await oauth.started.promise
    secondVault.afterLockFailure = async (count) => {
      if (count === 3) {
        gate.resolve()
        await first
      }
    }
    const second = secondService.resolveRequestAuth()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { bearerToken: refreshed.access },
      { bearerToken: refreshed.access },
    ])
    expect(secondVault.lockFailures).toBe(3)
    expect(oauth.calls).toBe(1)
    await expect(setupVault.read()).resolves.toEqual(fromPiAiOAuthCredential(refreshed))
  }, 15_000)

  it('serializes logout after a slow refresh without resurrecting credentials', async () => {
    const now = 1_800_000_000_000
    const expired = credential(now - 1, 1)
    const refreshed = credential(now + 60_000, 2)
    const gate = deferred<void>()
    const oauth = new SlowOAuth(refreshed, gate.promise)
    const refreshingVault = new FileCredentialVault()
    const logoutVault = new FileCredentialVault()
    await refreshingVault.modify(async () => fromPiAiOAuthCredential(expired))
    const refreshingService = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(oauth),
      vault: refreshingVault,
    })
    const logoutService = new PiAiCodexAuthService({
      now: () => now,
      provider: providerWithOAuth(oauth),
      vault: logoutVault,
    })

    const resolving = refreshingService.resolveRequestAuth()
    await oauth.started.promise
    const loggingOut = logoutService.logout()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(refreshingVault.read()).resolves.toEqual(fromPiAiOAuthCredential(expired))

    gate.resolve()
    await expect(resolving).resolves.toEqual({ bearerToken: refreshed.access })
    await expect(loggingOut).resolves.toBeUndefined()
    await expect(refreshingVault.read()).resolves.toBeUndefined()
  })
})
