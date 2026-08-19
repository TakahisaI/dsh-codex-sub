import { randomUUID } from 'node:crypto'

import type { Credential } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import type { CodexCredentialDocument } from '../src/core/credential-document.js'
import { CodexError } from '../src/core/errors.js'
import { PiAiCredentialStore } from '../src/piai/credential-store.js'
import { MemoryCredentialVault } from './helpers/memory-credential-vault.js'

function documentFixture(sequence = 1): CodexCredentialDocument {
  return {
    schemaVersion: 1,
    provider: 'openai-codex',
    credential: {
      accessToken: `ACCESS_SENTINEL_${randomUUID()}`,
      refreshToken: `REFRESH_SENTINEL_${randomUUID()}`,
      expiresAt: 1_900_000_000_000,
      providerData: {
        accountId: `ACCOUNT_SENTINEL_${randomUUID()}`,
        sequence,
      },
    },
  }
}

describe('PiAiCredentialStore', () => {
  it('reads detached credentials and lists only non-secret metadata', async () => {
    const document = documentFixture()
    const store = new PiAiCredentialStore(new MemoryCredentialVault(document))

    const first = await store.read('openai-codex')
    const second = await store.read('openai-codex')
    const listed = await store.list()

    expect(first).toEqual({
      type: 'oauth',
      access: document.credential.accessToken,
      refresh: document.credential.refreshToken,
      expires: document.credential.expiresAt,
      ...document.credential.providerData,
    })
    expect(first).not.toBe(second)
    expect(listed).toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
    expect(JSON.stringify(listed)).not.toContain(document.credential.accessToken)
    expect(JSON.stringify(listed)).not.toContain(document.credential.refreshToken)
    expect(JSON.stringify(listed)).not.toContain(document.credential.providerData['accountId'])
  })

  it('delegates modify to the vault and preserves the current value for undefined', async () => {
    const initial = documentFixture(1)
    const vault = new MemoryCredentialVault(initial)
    const store = new PiAiCredentialStore(vault)

    const unchanged = await store.modify('openai-codex', async (current) => {
      expect(vault.activeWriters).toBe(1)
      expect(current?.type).toBe('oauth')
      return undefined
    })
    const changed = await store.modify('openai-codex', async (current) => ({
      ...current,
      type: 'oauth',
      access: `ACCESS_SENTINEL_${randomUUID()}`,
      refresh: `REFRESH_SENTINEL_${randomUUID()}`,
      expires: 1_910_000_000_000,
      sequence: 2,
    }))

    expect(unchanged?.type).toBe('oauth')
    expect(changed).toMatchObject({ type: 'oauth', sequence: 2 })
    expect(vault.modifyCalls).toBe(2)
    expect(vault.peek()?.credential.providerData['sequence']).toBe(2)
  })

  it('owns only openai-codex and rejects unrelated writes clearly', async () => {
    const initial = documentFixture()
    const vault = new MemoryCredentialVault(initial)
    const store = new PiAiCredentialStore(vault)

    await expect(store.read('other-provider')).resolves.toBeUndefined()
    await expect(store.delete('other-provider')).rejects.toMatchObject({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'provider' },
    })
    await expect(store.modify('other-provider', async () => undefined)).rejects.toMatchObject({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'provider' },
    })
    expect(vault.peek()).toEqual(initial)
  })

  it('fails list on invalid storage instead of reporting a silent absence', async () => {
    const vault = new MemoryCredentialVault()
    const error = new CodexError('Credential storage is invalid.', 'CODEX_AUTH_STORAGE_INVALID')
    vault.readError = error
    const store = new PiAiCredentialStore(vault)

    await expect(store.list()).rejects.toBe(error)
  })

  it('rejects a non-OAuth callback result without changing the document', async () => {
    const initial = documentFixture()
    const vault = new MemoryCredentialVault(initial)
    const store = new PiAiCredentialStore(vault)
    const apiKeyCredential: Credential = { type: 'api_key', key: `ACCESS_SENTINEL_${randomUUID()}` }

    await expect(store.modify('openai-codex', async () => apiKeyCredential)).rejects.toBeInstanceOf(
      CodexError,
    )
    expect(vault.peek()).toEqual(initial)
  })

  it('deletes the owned document idempotently through the vault', async () => {
    const vault = new MemoryCredentialVault(documentFixture())
    const store = new PiAiCredentialStore(vault)

    await store.delete('openai-codex')
    await store.delete('openai-codex')

    expect(vault.deleteCalls).toBe(2)
    expect(vault.peek()).toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })
})
