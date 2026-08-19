import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

import {
  PLUGIN_NAME,
  PROVIDER_ID,
} from '../core/constants.js'
import { CodexError } from '../core/errors.js'
import { PiAiCodexAuthService } from '../piai/auth-service.js'
import { FileCredentialVault } from '../storage/file-credential-vault.js'
import { CodexDshAdapter } from './adapter.js'
import {
  assertHostLlmRuntime,
  assertRuntimeCompatible,
} from './compatibility.js'

export const name = PLUGIN_NAME
export const inject = ['llm']

function providerConflict(cause: unknown): CodexError {
  return new CodexError('Another adapter already owns the openai-codex provider route.', 'CODEX_PROVIDER_CONFLICT', {
    cause,
    safeDetails: { provider: PROVIDER_ID },
  })
}

function isDuplicateAdapterFailure(error: unknown): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return false
  }
  const code = Object.getOwnPropertyDescriptor(error, 'code')
  return code?.enumerable === true
    && 'value' in code
    && code.value === 'DUPLICATE_ADAPTER'
}

export function apply(ctx: Context): void {
  assertRuntimeCompatible()
  assertHostLlmRuntime(ctx.llm)

  const vault = new FileCredentialVault()
  const authService = new PiAiCodexAuthService({ vault })
  const adapter = new CodexDshAdapter({
    authService,
    resolveAttachments: (): AttachmentStore | undefined => ctx.get('attachments'),
  })

  try {
    ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  } catch (error) {
    // A host error can cross loader boundaries even after the service identity
    // is verified. Trust only the public own data property, not Error identity.
    if (isDuplicateAdapterFailure(error)) {
      throw providerConflict(error)
    }
    throw error
  }
}
