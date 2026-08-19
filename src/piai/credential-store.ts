import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'

import type { CodexCredentialVault } from '../core/contracts.js'
import { PROVIDER_ID } from '../core/constants.js'
import { CodexError } from '../core/errors.js'
import {
  fromPiAiOAuthCredential,
  toPiAiOAuthCredential,
} from './credential-conversion.js'

function unsupportedProvider(): CodexError {
  return new CodexError('The credential store does not own this provider.', 'CODEX_UPSTREAM_PROTOCOL', {
    safeDetails: { reason: 'provider' },
  })
}

export class PiAiCredentialStore implements CredentialStore {
  readonly #vault: CodexCredentialVault

  constructor(vault: CodexCredentialVault) {
    this.#vault = vault
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== PROVIDER_ID) {
      return undefined
    }
    const document = await this.#vault.read()
    return document === undefined ? undefined : toPiAiOAuthCredential(document)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const document = await this.#vault.read()
    if (document === undefined) {
      return Object.freeze([])
    }
    return Object.freeze([
      Object.freeze({ providerId: PROVIDER_ID, type: 'oauth' as const }),
    ])
  }

  async modify(
    providerId: string,
    operation: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== PROVIDER_ID) {
      throw unsupportedProvider()
    }

    const document = await this.#vault.modify(async (current) => {
      const candidate = await operation(
        current === undefined ? undefined : toPiAiOAuthCredential(current),
      )
      return candidate === undefined ? undefined : fromPiAiOAuthCredential(candidate)
    })
    return document === undefined ? undefined : toPiAiOAuthCredential(document)
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === PROVIDER_ID) {
      await this.#vault.delete()
    }
  }
}
