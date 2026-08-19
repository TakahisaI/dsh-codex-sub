import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

import { PROVIDER_ID } from '../core/constants.js'
import { CodexError } from '../core/errors.js'

export function codexCatalogModelCount(): number {
  const provider = openaiCodexProvider()
  if (provider.id !== PROVIDER_ID) {
    throw new CodexError(
      'The pi-ai Codex provider contract is incompatible.',
      'CODEX_UPSTREAM_PROTOCOL',
      { safeDetails: { reason: 'catalog_provider' } },
    )
  }
  const count = provider.getModels().length
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new CodexError(
      'The pi-ai Codex provider contract is incompatible.',
      'CODEX_UPSTREAM_PROTOCOL',
      { safeDetails: { reason: 'catalog_count' } },
    )
  }
  return count
}
