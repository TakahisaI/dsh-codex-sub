import { randomUUID } from 'node:crypto'

import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PiAiCodexAuthService } from '../src/piai/auth-service.js'
import { fromPiAiOAuthCredential } from '../src/piai/credential-conversion.js'
import {
  withCodexErrorCapture,
  withExplicitRequestToken,
} from '../src/piai/request-auth-provider.js'
import { MemoryCredentialVault } from './helpers/memory-credential-vault.js'

const ORIGINAL_OPENAI_API_KEY = process.env['OPENAI_API_KEY']

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env['OPENAI_API_KEY']
  } else {
    process.env['OPENAI_API_KEY'] = ORIGINAL_OPENAI_API_KEY
  }
})

describe('pinned openai-codex provider public contract', () => {
  it('publishes the expected OAuth-only provider and a non-empty catalog', () => {
    const provider = openaiCodexProvider()

    expect(provider.id).toBe('openai-codex')
    expect(provider.getModels().length).toBeGreaterThan(0)
    expect(provider.auth.apiKey).toBeUndefined()
    expect(provider.auth.oauth).toMatchObject({
      login: expect.any(Function),
      refresh: expect.any(Function),
      toAuth: expect.any(Function),
    })
  })

  it('pins the real provider login marker for the Enter-default selector contract', async () => {
    const provider = openaiCodexProvider()
    const oauth = provider.auth.oauth
    if (oauth === undefined) {
      throw new Error('Pinned provider unexpectedly has no OAuth auth.')
    }
    let promptCount = 0

    await expect(oauth.login({
      async prompt(prompt) {
        promptCount += 1
        expect(prompt.type).toBe('select')
        if (prompt.type !== 'select') {
          return 'invalid'
        }
        expect(prompt.options).toEqual([
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device_code', label: 'Device code login (headless)' },
        ])
        // The terminal interaction maps an empty answer to this exact marker;
        // stop the real provider before it starts OAuth network work.
        return 'contract-marker'
      },
      notify: vi.fn(),
    })).rejects.toThrow('Unknown OpenAI Codex login method: contract-marker')
    expect(promptCount).toBe(1)
  })

  it('keeps every public own provider key across request wrappers', () => {
    const upstream = openaiCodexProvider()
    const explicit = withExplicitRequestToken(upstream)
    const captured = withCodexErrorCapture(explicit, () => undefined)
    const publicOwnKeys = (value: object): string[] => Reflect.ownKeys(value)
      .map((key) => typeof key === 'symbol' ? key.toString() : key)
      .sort()

    expect(publicOwnKeys(explicit)).toEqual(publicOwnKeys(upstream))
    expect(publicOwnKeys(captured)).toEqual(publicOwnKeys(explicit))
  })

  it('derives request auth offline from only the package credential', async () => {
    const now = 1_800_000_000_000
    const access = `ACCESS_SENTINEL_${randomUUID()}`
    const ambient = `AMBIENT_SENTINEL_${randomUUID()}`
    process.env['OPENAI_API_KEY'] = ambient
    const credential = {
      type: 'oauth' as const,
      access,
      refresh: `REFRESH_SENTINEL_${randomUUID()}`,
      expires: now + 60_000,
      accountId: `ACCOUNT_SENTINEL_${randomUUID()}`,
    }
    const service = new PiAiCodexAuthService({
      now: () => now,
      vault: new MemoryCredentialVault(fromPiAiOAuthCredential(credential)),
    })

    const auth = await service.resolveRequestAuth()

    expect(auth).toEqual({ bearerToken: access })
    expect(auth.bearerToken).not.toBe(ambient)
  })

  it('cancels a stalled real-provider refresh at the service boundary', async () => {
    const now = 1_800_000_000_000
    const credential = {
      type: 'oauth' as const,
      access: `ACCESS_SENTINEL_${randomUUID()}`,
      refresh: `REFRESH_SENTINEL_${randomUUID()}`,
      expires: now - 1,
      accountId: `ACCOUNT_SENTINEL_${randomUUID()}`,
    }
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetchMock)
    const vault = new MemoryCredentialVault(fromPiAiOAuthCredential(credential))
    const service = new PiAiCodexAuthService({
      now: () => now,
      refreshTimeoutMs: 1_000,
      vault,
    })
    const controller = new AbortController()

    const resolving = service.resolveRequestAuth(controller.signal)
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce()
    })
    controller.abort()

    await expect(resolving).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.',
    })
    await expect(service.logout()).resolves.toBeUndefined()
    expect(vault.peek()).toBeUndefined()
  })

  it('pins the provider refresh cancellation gap without network traffic', async () => {
    const provider = openaiCodexProvider()
    const oauth = provider.auth.oauth
    if (oauth === undefined) {
      throw new Error('Pinned provider unexpectedly has no OAuth auth.')
    }
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const refresh = oauth.refresh({
      type: 'oauth',
      access: `ACCESS_SENTINEL_${randomUUID()}`,
      refresh: `REFRESH_SENTINEL_${randomUUID()}`,
      expires: 1,
    }, controller.signal)
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce()
    })
    controller.abort()

    const outcome = await Promise.race([
      refresh.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 20)
      }),
    ])

    expect(outcome).toBe('pending')
  })
})
