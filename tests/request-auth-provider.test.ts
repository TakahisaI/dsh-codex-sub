import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai'
import type {
  AuthContext,
  OAuthAuth,
  Provider,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { describe, expect, it } from 'vitest'

import { PROVIDER_ID } from '../src/core/constants.js'
import {
  createOpenAiCodexRequestProvider,
  withExplicitRequestToken,
} from '../src/piai/request-auth-provider.js'

const ACCESS_SENTINEL = 'ACCESS_SENTINEL_request_provider'

function oauthOnlyFauxProvider(): {
  readonly provider: Provider
  readonly setResponse: (capture: (apiKey: string | undefined) => void) => void
  readonly streamCalls: () => number
} {
  const faux = fauxProvider({
    provider: PROVIDER_ID,
    models: [{ id: 'request-auth-fixture-model', name: 'Request auth fixture' }],
  })
  const oauth: OAuthAuth = {
    name: 'Fixture OAuth',
    async login() {
      throw new Error('login is not part of this contract test')
    },
    async refresh() {
      throw new Error('refresh is not part of this contract test')
    },
    async toAuth() {
      throw new Error('stored OAuth is not part of this contract test')
    },
  }
  const source = faux.provider
  const provider: Provider = {
    id: source.id,
    name: source.name,
    ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth: { oauth },
    getModels: source.getModels.bind(source),
    stream: source.stream.bind(source),
    streamSimple: source.streamSimple.bind(source),
  }
  return {
    provider,
    setResponse(capture) {
      faux.setResponses([
        (_context, options) => {
          capture(options?.apiKey)
          return fauxAssistantMessage('ok')
        },
      ])
    },
    streamCalls: () => faux.state.callCount,
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of iterable) {
    values.push(value)
  }
  return values
}

describe('explicit request-token provider', () => {
  it('preserves the real provider catalog and OAuth capability without mutation', () => {
    const upstream = openaiCodexProvider()
    const requestProvider = withExplicitRequestToken(upstream)

    expect(requestProvider.id).toBe(PROVIDER_ID)
    expect(requestProvider.getModels().length).toBeGreaterThan(0)
    expect(requestProvider.auth.oauth).toBe(upstream.auth.oauth)
    expect(requestProvider.auth.apiKey).toBeDefined()
    expect(upstream.auth.apiKey).toBeUndefined()

    const freshUpstream = createOpenAiCodexRequestProvider()
    expect(freshUpstream.getModels().map((model) => model.id)).toEqual(
      requestProvider.getModels().map((model) => model.id),
    )
  })

  it('offers no ambient credential when the request override is absent', async () => {
    const fixture = oauthOnlyFauxProvider()
    const wrapped = withExplicitRequestToken(fixture.provider)
    let ambientReads = 0
    const context: AuthContext = {
      async env() {
        ambientReads += 1
        return 'AMBIENT_SENTINEL_must_not_resolve'
      },
      async fileExists() {
        ambientReads += 1
        return true
      },
    }

    const resolved = await wrapped.auth.apiKey?.resolve({ ctx: context })
    expect(resolved).toMatchObject({
      source: 'Request-scoped ChatGPT OAuth token',
    })
    expect(resolved?.auth.apiKey).not.toBe('AMBIENT_SENTINEL_must_not_resolve')
    expect(ambientReads).toBe(0)
  })

  it('passes only the explicit request token through the public Models override', async () => {
    const fixture = oauthOnlyFauxProvider()
    const wrapped = withExplicitRequestToken(fixture.provider)
    let capturedApiKey: string | undefined
    fixture.setResponse((value) => {
      capturedApiKey = value
    })
    const models = createModels()
    models.setProvider(wrapped)
    const model = models.getModels(PROVIDER_ID)[0]
    expect(model).toBeDefined()

    const events = await collect(models.streamSimple(model!, { messages: [] }, {
      apiKey: ACCESS_SENTINEL,
    }))

    expect(events.at(-1)?.type).toBe('done')
    expect(capturedApiKey).toBe(ACCESS_SENTINEL)
    expect(fixture.streamCalls()).toBe(1)
  })

  it('fails before provider streaming when no explicit token is supplied', async () => {
    const fixture = oauthOnlyFauxProvider()
    const models = createModels()
    models.setProvider(withExplicitRequestToken(fixture.provider))
    const model = models.getModels(PROVIDER_ID)[0]
    expect(model).toBeDefined()

    const events = await collect(models.streamSimple(model!, { messages: [] }))

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
    })
    expect(fixture.streamCalls()).toBe(0)
  })

  it('rejects its configured marker before provider streaming', async () => {
    const fixture = oauthOnlyFauxProvider()
    const wrapped = withExplicitRequestToken(fixture.provider)
    const model = wrapped.getModels()[0]
    expect(model).toBeDefined()
    const resolved = await wrapped.auth.apiKey?.resolve({
      ctx: {
        async env() {
          return undefined
        },
        async fileExists() {
          return false
        },
      },
    })
    const marker = resolved?.auth.apiKey
    expect(marker).toBeDefined()
    if (marker === undefined) {
      throw new Error('request-token marker was not resolved')
    }

    expect(() => wrapped.streamSimple(model!, { messages: [] }, {
      apiKey: marker,
    })).toThrowError(expect.objectContaining({ code: 'CODEX_AUTH_REQUIRED' }))
    expect(fixture.streamCalls()).toBe(0)
  })
})
