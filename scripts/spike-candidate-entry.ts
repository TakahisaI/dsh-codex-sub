import { randomUUID } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type {
  Context as PiContext,
  OAuthAuth,
  Provider,
} from '@earendil-works/pi-ai'

import type {
  CodexAuthService,
  CodexCredentialVault,
} from '../src/core/contracts.js'
import type { CodexCredentialDocument } from '../src/core/credential-document.js'
import { PROVIDER_ID } from '../src/core/constants.js'
import { CodexDshAdapter } from '../src/dsh/adapter.js'
import { createFailClosedPiAiAuthInjection } from '../src/piai/auth-injection.js'
import { PiAiCodexAuthService } from '../src/piai/auth-service.js'
import { fromPiAiOAuthCredential } from '../src/piai/credential-conversion.js'
import { withExplicitRequestToken } from '../src/piai/request-auth-provider.js'

export interface CandidateProbeResult {
  readonly attachmentReads: number
  readonly authCalls: number
  readonly capturedApiKeyMatches: boolean
  readonly duplicateAdapterCode: string | undefined
  readonly imageReplacementUsed: boolean
  readonly modelCount: number
  readonly nativeDeletes: number
  readonly nativeEnvLookups: number
  readonly nativeFileChecks: number
  readonly nativeReads: number
  readonly nativeWrites: number
  readonly providerCalls: number
}

class MemoryCredentialVault implements CodexCredentialVault {
  #document: CodexCredentialDocument | undefined

  constructor(document: CodexCredentialDocument) {
    this.#document = document
  }

  async read(): Promise<CodexCredentialDocument | undefined> {
    return this.#document === undefined ? undefined : structuredClone(this.#document)
  }

  async modify(
    operation: (current: CodexCredentialDocument | undefined) => Promise<
      CodexCredentialDocument | undefined
    >,
  ): Promise<CodexCredentialDocument | undefined> {
    const candidate = await operation(
      this.#document === undefined ? undefined : structuredClone(this.#document),
    )
    if (candidate !== undefined) {
      this.#document = candidate
    }
    return this.read()
  }

  async delete(): Promise<void> {
    this.#document = undefined
  }

  async inspect() {
    return Object.freeze({
      state: this.#document === undefined ? 'absent' : 'present',
      permissions: 'owner-only',
    }) as const
  }
}

class CountingAuthService implements CodexAuthService {
  calls = 0

  constructor(private readonly service: CodexAuthService) {}

  async login(interaction: unknown, signal?: AbortSignal): Promise<void> {
    await this.service.login(interaction, signal)
  }

  async status() {
    return this.service.status()
  }

  async resolveRequestAuth(signal?: AbortSignal) {
    this.calls += 1
    return this.service.resolveRequestAuth(signal)
  }

  async logout(): Promise<void> {
    await this.service.logout()
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

function oauthOnlyFauxProvider(): Provider {
  const source = fauxProvider({
    provider: PROVIDER_ID,
    models: [],
  })
  const oauth: OAuthAuth = {
    name: 'Candidate fixture OAuth',
    login: async () => ({
      type: 'oauth',
      access: `ACCESS_SENTINEL_${randomUUID()}`,
      refresh: `REFRESH_SENTINEL_${randomUUID()}`,
      expires: Date.now() + 3_600_000,
    }),
    refresh: async credential => credential,
    toAuth: async credential => ({ apiKey: credential.access }),
  }
  return {
    ...source.provider,
    auth: Object.freeze({ oauth }),
    getModels: source.provider.getModels.bind(source.provider),
    stream: source.provider.stream.bind(source.provider),
    streamSimple: source.provider.streamSimple.bind(source.provider),
  }
}

export function createCandidatePluginProbe(): {
  adapter: () => CodexDshAdapter
  authService: CountingAuthService
  imageRequest: () => GenerateOptions
  result: () => CandidateProbeResult
} {
  let attachmentReads = 0
  let capturedApiKey: string | undefined
  let duplicateAdapterCode: string | undefined
  let nativeDeletes = 0
  let nativeEnvLookups = 0
  let nativeFileChecks = 0
  let nativeReads = 0
  let nativeWrites = 0
  let providerCalls = 0

  const accessSentinel = `ACCESS_SENTINEL_${randomUUID()}`
  const credential = {
    type: 'oauth' as const,
    access: accessSentinel,
    refresh: `REFRESH_SENTINEL_${randomUUID()}`,
    expires: Date.now() + 3_600_000,
    accountId: `ACCOUNT_SENTINEL_${randomUUID()}`,
  }
  const authService = new CountingAuthService(new PiAiCodexAuthService({
    provider: oauthOnlyFauxProvider(),
    vault: new MemoryCredentialVault(fromPiAiOAuthCredential(credential)),
  }))

  const actualInjection = createFailClosedPiAiAuthInjection()
  const countedActualInjection = Object.freeze({
    credentials: Object.freeze({
      async read(providerId: string) {
        nativeReads += 1
        return actualInjection.credentials.read(providerId)
      },
      async list() {
        return actualInjection.credentials.list()
      },
      async modify(...arguments_: Parameters<typeof actualInjection.credentials.modify>) {
        nativeWrites += 1
        return actualInjection.credentials.modify(...arguments_)
      },
      async delete(providerId: string) {
        nativeDeletes += 1
        return actualInjection.credentials.delete(providerId)
      },
    }),
    authContext: Object.freeze({
      async env(name: string) {
        nativeEnvLookups += 1
        return actualInjection.authContext.env(name)
      },
      async fileExists(path: string) {
        nativeFileChecks += 1
        return actualInjection.authContext.fileExists(path)
      },
    }),
  })

  const attachmentRef: {
    readonly attachmentId: ReturnType<typeof AttachmentId>
    readonly mediaType: 'image/png'
    readonly bytes: number
    readonly width: number
    readonly height: number
  } = Object.freeze({
    attachmentId: AttachmentId(`candidate-image-${randomUUID()}`),
    mediaType: 'image/png' as const,
    bytes: 4,
    width: 1,
    height: 1,
  })
  const attachmentStore = {
    async readImage(received: typeof attachmentRef) {
      attachmentReads += 1
      if (received !== attachmentRef) {
        throw new Error('Candidate attachment identity changed.')
      }
      return { ref: attachmentRef, data: new Uint8Array([137, 80, 78, 71]) }
    },
  }

  const sourceFaux = fauxProvider({
    provider: PROVIDER_ID,
    models: [{
      id: 'candidate-plugin-model',
      name: 'Candidate plugin model',
      input: ['text', 'image'],
    }],
  })
  let observedImageContent: 'absent' | 'image' | 'replaced' = 'absent'
  const captureStreamSimple = (
    model: Parameters<Provider['streamSimple']>[0],
    context: Parameters<Provider['streamSimple']>[1],
    options: Parameters<Provider['streamSimple']>[2],
  ) => {
    capturedApiKey = options?.apiKey
    return sourceFaux.provider.streamSimple(model, context, options)
  }
  sourceFaux.setResponses([
    (context: PiContext) => {
      providerCalls += 1
      const message = context.messages.find(entry => entry.role === 'user')
      if (message !== undefined) {
        observedImageContent = Array.isArray(message.content)
          && message.content.some(content => content.type === 'image')
          ? 'image'
          : typeof message.content === 'string'
            || (Array.isArray(message.content)
              && message.content.some(content => content.type === 'text'))
            ? 'replaced'
            : 'absent'
      }
      return fauxAssistantMessage('candidate-ok')
    },
  ])
  const streamingProvider = withExplicitRequestToken({
    ...sourceFaux.provider,
    auth: Object.freeze({
      oauth: {
        name: 'Candidate fixture OAuth',
        login: async () => ({
          type: 'oauth',
          access: `ACCESS_SENTINEL_${randomUUID()}`,
          refresh: `REFRESH_SENTINEL_${randomUUID()}`,
          expires: Date.now() + 3_600_000,
        }),
        refresh: async credential => credential,
        toAuth: async credential => ({ apiKey: credential.access }),
      },
    }),
    getModels: sourceFaux.provider.getModels.bind(sourceFaux.provider),
    stream: sourceFaux.provider.stream.bind(sourceFaux.provider),
    streamSimple: captureStreamSimple,
  } as Provider)

  const adapter = new CodexDshAdapter({
    authService,
    authInjection: countedActualInjection,
    profile: Object.freeze({
      provider: PROVIDER_ID,
      displayName: 'OpenAI Codex (ChatGPT)',
      streamIdleTimeoutMs: 1_000,
      // A one-byte budget forces the candidate conversion path to replace the
      // four-byte fixture image, proving the profile value reaches request use.
      maxRequestImageBytes: 1,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 0,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
      piProvider: streamingProvider as Provider,
      configuredMaxTokens: new Map(),
    }),
    resolveAttachments: () => attachmentStore as never,
  })

  return {
    adapter: () => adapter,
    authService,
    observeDuplicateAdapter: (code: string | undefined) => {
      duplicateAdapterCode = code
    },
    imageRequest: () => ({
      provider: PROVIDER_ID,
      model: 'candidate-plugin-model',
      messages: [
        createUserMessage({
          content: [{ type: 'image', attachment: attachmentRef }],
          source: { kind: 'user' },
        }),
      ],
    }),
    result: () => ({
      attachmentReads,
      authCalls: authService.calls,
      capturedApiKeyMatches: capturedApiKey === accessSentinel,
      duplicateAdapterCode,
      imageReplacementUsed: observedImageContent === 'replaced',
      modelCount: streamingProvider.getModels().length,
      nativeDeletes,
      nativeEnvLookups,
      nativeFileChecks,
      nativeReads,
      nativeWrites,
      providerCalls,
    }),
  }
}

export async function runCandidatePluginProbe(): Promise<CandidateProbeResult> {
  const probe = createCandidatePluginProbe()
  const adapter = probe.adapter()
  let streamChunks: StreamChunk[] = []

  const context = new Context()
  const runtimeFiber = context.plugin(LlmRuntime)
  await runtimeFiber
  const adapterFiber = context.plugin({
    name: 'dsh-codex-sub-candidate-lane',
    inject: ['llm'],
    apply(pluginContext: Context) {
      pluginContext.llm.registerAdapter([PROVIDER_ID], adapter)
    },
  })
  await adapterFiber

  try {
    context.llm.registerAdapter([PROVIDER_ID], adapter)
  } catch (error) {
    probe.observeDuplicateAdapter((error as { code?: string }).code)
  }

  try {
    const chunks = await collect(context.llm.stream(probe.imageRequest()))
    streamChunks = chunks
    const failure = chunks.find(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')
    if (failure !== undefined) {
      throw new Error(`The candidate plugin stream failed: ${JSON.stringify(chunks)}.`)
    }
  } finally {
    await adapterFiber.dispose()
    await runtimeFiber.dispose()
  }

  const result = probe.result()
  if (
    result.attachmentReads !== 0
    || result.authCalls !== 1
    || !result.capturedApiKeyMatches
    || result.duplicateAdapterCode !== 'DUPLICATE_ADAPTER'
    || !result.imageReplacementUsed
    || result.modelCount !== 1
    || result.nativeDeletes !== 0
    || result.nativeEnvLookups !== 0
    || result.nativeFileChecks !== 0
    || result.nativeReads !== 0
    || result.nativeWrites !== 0
    || result.providerCalls !== 1
  ) {
    throw new Error(`The candidate plugin contract probe did not match its expected counts: ${JSON.stringify(result)} chunks=${JSON.stringify(streamChunks)}.`)
  }
  return result
}
