import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'

import {
  PLUGIN_NAME,
  PROVIDER_ID,
} from '../core/constants.js'
import { CodexError } from '../core/errors.js'
import { PiAiCodexAuthService } from '../piai/auth-service.js'
import { FileCredentialVault } from '../storage/file-credential-vault.js'
import { CodexDshAdapter } from './adapter.js'
import { assertRuntimeCompatible } from './compatibility.js'

export const name = PLUGIN_NAME
export const inject = ['llm']

function providerConflict(cause: unknown): CodexError {
  return new CodexError('Another adapter already owns the openai-codex provider route.', 'CODEX_PROVIDER_CONFLICT', {
    cause,
    safeDetails: { provider: PROVIDER_ID },
  })
}

export function apply(ctx: Context): void {
  assertRuntimeCompatible()

  const vault = new FileCredentialVault()
  const authService = new PiAiCodexAuthService({ vault })
  const adapter = new CodexDshAdapter({
    authService,
    resolveAttachments: (): AttachmentStore | undefined => ctx.get('attachments'),
  })

  try {
    ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  } catch (error) {
    if (error instanceof LlmError && error.code === 'DUPLICATE_ADAPTER') {
      throw providerConflict(error)
    }
    throw error
  }
}
