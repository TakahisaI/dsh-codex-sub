import type {
  Api,
  ApiKeyAuth,
  Provider,
  StreamOptions,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

import { PROVIDER_ID } from '../core/constants.js'
import { CodexError } from '../core/errors.js'

const REQUEST_TOKEN_REQUIRED_MARKER = 'dsh-codex-sub-request-token-required'

const EXPLICIT_REQUEST_TOKEN_AUTH: ApiKeyAuth = Object.freeze({
  name: 'Request-scoped ChatGPT OAuth token',
  async resolve() {
    // Models requires an auth method to report configured before applying the
    // per-request apiKey override. The provider wrapper rejects this marker at
    // its wire boundary, so it can never become a bearer credential.
    return Object.freeze({
      auth: Object.freeze({ apiKey: REQUEST_TOKEN_REQUIRED_MARKER }),
      source: 'Request-scoped ChatGPT OAuth token',
    })
  },
})

function incompatibleProvider(reason: string): CodexError {
  return new CodexError('The pi-ai Codex provider contract is incompatible.', 'CODEX_UPSTREAM_PROTOCOL', {
    safeDetails: { reason },
  })
}

function assertExplicitRequestToken(options: StreamOptions | undefined): void {
  if (
    options?.apiKey === undefined
    || options.apiKey.length === 0
    || options.apiKey === REQUEST_TOKEN_REQUIRED_MARKER
  ) {
    throw new CodexError('ChatGPT authentication is required.', 'CODEX_AUTH_REQUIRED')
  }
}

export function withExplicitRequestToken<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  if (
    provider.id !== PROVIDER_ID
    || provider.auth.oauth === undefined
    || provider.auth.apiKey !== undefined
  ) {
    throw incompatibleProvider('request_provider_auth')
  }

  const wrapped: Provider<TApi> = {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    auth: Object.freeze({
      apiKey: EXPLICIT_REQUEST_TOKEN_AUTH,
      oauth: provider.auth.oauth,
    }),
    getModels: provider.getModels.bind(provider),
    ...(provider.refreshModels === undefined
      ? {}
      : { refreshModels: provider.refreshModels.bind(provider) }),
    ...(provider.filterModels === undefined
      ? {}
      : { filterModels: provider.filterModels.bind(provider) }),
    stream(model, context, options) {
      assertExplicitRequestToken(options)
      return provider.stream(model, context, options)
    },
    streamSimple(model, context, options) {
      assertExplicitRequestToken(options)
      return provider.streamSimple(model, context, options)
    },
  }

  return Object.freeze(wrapped)
}

export function createOpenAiCodexRequestProvider(): Provider<'openai-codex-responses'> {
  return withExplicitRequestToken(openaiCodexProvider())
}
