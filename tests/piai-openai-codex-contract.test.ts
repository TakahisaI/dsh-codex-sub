import { randomUUID } from 'node:crypto'

import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { afterEach, describe, expect, it } from 'vitest'

import { PiAiCodexAuthService } from '../src/piai/auth-service.js'
import { fromPiAiOAuthCredential } from '../src/piai/credential-conversion.js'
import { MemoryCredentialVault } from './helpers/memory-credential-vault.js'

const ORIGINAL_OPENAI_API_KEY = process.env['OPENAI_API_KEY']

afterEach(() => {
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
})
