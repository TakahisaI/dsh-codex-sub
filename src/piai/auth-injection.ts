import type {
  AuthContext,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'

import { CodexError } from '../core/errors.js'

function nativeStoreDisabled(): CodexError {
  return new CodexError(
    'The DSH-native credential path is disabled while package-owned OAuth is active.',
    'CODEX_UPSTREAM_PROTOCOL',
    { safeDetails: { reason: 'native_store_disabled' } },
  )
}

/**
 * DSH 0.1.1-rc.1 requires an auth injection even when every request uses the
 * explicit resolveApiKey override. This adapter keeps that unused fallback
 * fail closed: no native login can write into it and no ambient key can leak
 * into the package-owned Codex route.
 */
export function createFailClosedPiAiAuthInjection(): {
  readonly credentials: CredentialStore
  readonly authContext: AuthContext
} {
  const credentials: CredentialStore = {
    async read(_providerId: string): Promise<Credential | undefined> {
      return undefined
    },
    async list(): Promise<readonly CredentialInfo[]> {
      return []
    },
    async modify(): Promise<Credential | undefined> {
      throw nativeStoreDisabled()
    },
    async delete(): Promise<void> {
      throw nativeStoreDisabled()
    },
  }
  const authContext: AuthContext = {
    async env(): Promise<string | undefined> {
      return undefined
    },
    async fileExists(): Promise<boolean> {
      return false
    },
  }
  return Object.freeze({ credentials: Object.freeze(credentials), authContext: Object.freeze(authContext) })
}
