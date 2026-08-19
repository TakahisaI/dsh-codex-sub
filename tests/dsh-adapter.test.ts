import {
  AttachmentId,
} from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ReasoningEffortId,
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { describe, expect, it } from 'vitest'

import type {
  CodexAuthService,
  CodexAuthStatus,
  CodexRequestAuth,
} from '../src/core/contracts.js'
import {
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from '../src/core/constants.js'
import { CodexError } from '../src/core/errors.js'
import { CodexDshAdapter } from '../src/dsh/adapter.js'

const MODEL_ID = 'dsh-adapter-fixture-model'
const ACCESS_SENTINEL = 'ACCESS_SENTINEL_dsh_adapter'

class AuthServiceProbe implements CodexAuthService {
  calls = 0
  error: unknown
  signal: AbortSignal | undefined

  async login(): Promise<void> {}

  async status(): Promise<CodexAuthStatus> {
    return { state: 'signed-out' }
  }

  async resolveRequestAuth(signal?: AbortSignal): Promise<CodexRequestAuth> {
    this.calls += 1
    this.signal = signal
    if (this.error !== undefined) {
      throw this.error
    }
    return Object.freeze({ bearerToken: ACCESS_SENTINEL })
  }

  async logout(): Promise<void> {}
}

function profile(provider: Provider, streamIdleTimeoutMs = 1_000): ResolvedPiAiProviderProfile {
  return Object.freeze({
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(undefined, 'test.openai-codex.retryPolicy'),
    piProvider: provider,
    configuredMaxTokens: new Map<string, number>(),
  })
}

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: PROVIDER_ID,
    model: MODEL_ID,
    messages: [],
    ...(signal === undefined ? {} : { signal }),
  }
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }
  return chunks
}

describe('Codex DSH adapter', () => {
  it('exposes provider metadata and the provider-owned catalog', async () => {
    const faux = fauxProvider({
      provider: PROVIDER_ID,
      models: [{ id: MODEL_ID, name: 'DSH adapter fixture', reasoning: true }],
    })
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(faux.provider),
    })

    expect(adapter.providerInfo(PROVIDER_ID)).toEqual({
      id: PROVIDER_ID,
      name: PROVIDER_DISPLAY_NAME,
    })
    expect(await adapter.listModels(PROVIDER_ID)).toEqual([
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: MODEL_ID,
        name: 'DSH adapter fixture',
      }),
    ])
    expect(await adapter.resolveModel(PROVIDER_ID, MODEL_ID)).toMatchObject({
      provider: PROVIDER_ID,
      id: MODEL_ID,
    })
  })

  it('freezes one auth result for reasoning, text, tool, usage, and finish conversion', async () => {
    const faux = fauxProvider({
      provider: PROVIDER_ID,
      models: [{ id: MODEL_ID, name: 'DSH adapter fixture', reasoning: true }],
    })
    let capturedApiKey: string | undefined
    faux.setResponses([
      (_context, options) => {
        capturedApiKey = options?.apiKey
        return fauxAssistantMessage([
          fauxThinking('reasoning'),
          fauxText('answer'),
          fauxToolCall('read_file', { path: 'README.md' }, { id: 'fixture-call' }),
        ], { stopReason: 'toolUse' })
      },
    ])
    const auth = new AuthServiceProbe()
    const controller = new AbortController()
    const adapter = new CodexDshAdapter({
      authService: auth,
      profile: profile(faux.provider),
    })

    const chunks = await collect(adapter.stream(request(controller.signal)))

    expect(auth.calls).toBe(1)
    expect(auth.signal).toBe(controller.signal)
    expect(capturedApiKey).toBe(ACCESS_SENTINEL)
    expect(chunks).toContainEqual({
      type: 'reasoning-delta',
      index: 0,
      text: 'reasoning',
    })
    expect(chunks).toContainEqual({
      type: 'text-delta',
      index: 1,
      text: 'answer',
    })
    expect(
      chunks
        .flatMap((chunk) => chunk.type === 'tool-call-delta' && chunk.index === 2
          ? [chunk.argumentsDelta]
          : [])
        .join(''),
    ).toBe('{"path":"README.md"}')
    const usageIndex = chunks.findIndex((chunk) => chunk.type === 'usage')
    const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
    expect(usageIndex).toBeGreaterThan(-1)
    expect(finishIndex).toBeGreaterThan(usageIndex)
    expect(finishIndex).toBe(chunks.length - 1)
  })

  it.each([
    ['CODEX_AUTH_REQUIRED', 'ChatGPT authentication is required.'],
    ['CODEX_REAUTH_REQUIRED', 'ChatGPT authentication must be renewed.'],
  ] as const)('fails with %s before provider streaming', async (code, message) => {
    const faux = fauxProvider({
      provider: PROVIDER_ID,
      models: [{ id: MODEL_ID }],
    })
    const auth = new AuthServiceProbe()
    auth.error = new CodexError(message, code)
    const adapter = new CodexDshAdapter({
      authService: auth,
      profile: profile(faux.provider),
    })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code })
    expect(auth.calls).toBe(1)
    expect(faux.state.callCount).toBe(0)
  })

  it('preserves auth error codes through the public DSH stream boundary', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const auth = new AuthServiceProbe()
    auth.error = new CodexError('ChatGPT authentication is required.', 'CODEX_AUTH_REQUIRED')
    const adapter = new CodexDshAdapter({
      authService: auth,
      profile: profile(faux.provider),
    })
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    const adapterFiber = ctx.plugin({
      name: 'codex-adapter-auth-error-contract',
      inject: ['llm'],
      apply(pluginContext: Context) {
        pluginContext.llm.registerAdapter([PROVIDER_ID], adapter)
      },
    })
    await adapterFiber

    try {
      const chunks = await collect(ctx.llm.stream(request()))
      expect(chunks).toEqual([
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'ChatGPT authentication is required.',
              code: 'CODEX_AUTH_REQUIRED',
            },
          },
        },
      ])
      expect(faux.state.callCount).toBe(0)
    } finally {
      await adapterFiber.dispose()
      await runtimeFiber.dispose()
    }
  })

  it('preserves request cancellation before provider streaming', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const auth = new AuthServiceProbe()
    auth.error = new DOMException('The operation was aborted.', 'AbortError')
    const adapter = new CodexDshAdapter({
      authService: auth,
      profile: profile(faux.provider),
    })
    const controller = new AbortController()
    controller.abort()

    await expect(collect(adapter.stream(request(controller.signal)))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(faux.state.callCount).toBe(0)
  })

  it('propagates cancellation through the provider stream', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    faux.setResponses([
      async (_context, options) => {
        markEntered?.()
        return new Promise((resolve) => {
          const complete = (): void => {
            resolve(fauxAssistantMessage('', {
              stopReason: 'aborted',
              errorMessage: 'cancelled',
            }))
          }
          if (options?.signal?.aborted === true) {
            complete()
          } else {
            options?.signal?.addEventListener('abort', complete, { once: true })
          }
        })
      },
    ])
    const controller = new AbortController()
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(faux.provider),
    })

    const result = collect(adapter.stream(request(controller.signal)))
    await entered
    controller.abort()
    const chunks = await result

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted' },
    })
  })

  it('enforces the DSH stream-idle timeout around a stalled provider', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const source = faux.provider
    const stalledStream = (signal?: AbortSignal) => {
      const events = createAssistantMessageEventStream()
      const abort = (): void => {
        events.push({
          type: 'error',
          reason: 'aborted',
          error: fauxAssistantMessage('', {
            stopReason: 'aborted',
            errorMessage: 'cancelled',
          }),
        })
      }
      if (signal?.aborted === true) {
        abort()
      } else {
        signal?.addEventListener('abort', abort, { once: true })
      }
      return events
    }
    const stalledProvider: Provider = {
      id: source.id,
      name: source.name,
      ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
      ...(source.headers === undefined ? {} : { headers: source.headers }),
      auth: source.auth,
      getModels: source.getModels.bind(source),
      stream: (_model, _context, options) => stalledStream(options?.signal),
      streamSimple: (_model, _context, options) => stalledStream(options?.signal),
    }
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(stalledProvider, 10),
    })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'pi-ai stream idle timeout after 10ms',
    })
  })

  it('rejects an unsupported reasoning effort before provider streaming', async () => {
    const faux = fauxProvider({
      provider: PROVIDER_ID,
      models: [{ id: MODEL_ID, reasoning: false }],
    })
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(faux.provider),
    })
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    const adapterFiber = ctx.plugin({
      name: 'codex-adapter-reasoning-contract',
      inject: ['llm'],
      apply(pluginContext: Context) {
        pluginContext.llm.registerAdapter([PROVIDER_ID], adapter)
      },
    })
    await adapterFiber

    try {
      await expect(ctx.llm.resolveCallConfig({
        provider: PROVIDER_ID,
        model: MODEL_ID,
        reasoningEffort: ReasoningEffortId('high'),
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
      expect(faux.state.callCount).toBe(0)
    } finally {
      await adapterFiber.dispose()
      await runtimeFiber.dispose()
    }
  })

  it('restores provider replay metadata through the delegated PiAiAdapter', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses([
      fauxAssistantMessage('first', { responseId: 'fixture-response-id' }),
    ])
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(faux.provider),
    })
    const firstChunks = await collect(adapter.stream(request()))
    const finish = firstChunks.find((chunk) => chunk.type === 'finish')
    expect(finish?.type).toBe('finish')
    const replayState = finish?.type === 'finish' ? finish.replayState : undefined
    expect(replayState).toBeDefined()

    let replayedResponseId: string | undefined
    faux.setResponses([
      (context) => {
        const replayed = context.messages[0]
        replayedResponseId = replayed?.role === 'assistant'
          ? replayed.responseId
          : undefined
        return fauxAssistantMessage('second')
      },
    ])
    const history = createAssistantMessage({
      content: [{ type: 'text', text: 'first' }],
      source: {
        provider: PROVIDER_ID,
        model: MODEL_ID,
        replayState,
      },
    })

    await collect(adapter.stream({
      ...request(),
      messages: [history],
    }))

    expect(replayedResponseId).toBe('fixture-response-id')
  })

  it('resolves DSH image attachments at request time for image-capable models', async () => {
    const faux = fauxProvider({
      provider: PROVIDER_ID,
      models: [{ id: MODEL_ID, input: ['text', 'image'] }],
    })
    const ref = Object.freeze({
      attachmentId: AttachmentId('fixture-image'),
      mediaType: 'image/png' as const,
      bytes: 4,
      width: 1,
      height: 1,
    })
    let attachmentReads = 0
    const controller = new AbortController()
    const attachmentStore = {
      async readImage(received: typeof ref, signal?: AbortSignal) {
        attachmentReads += 1
        expect(received).toStrictEqual(ref)
        expect(signal).toBe(controller.signal)
        return { ref, data: new Uint8Array([137, 80, 78, 71]) }
      },
    } as unknown as AttachmentStore
    let imageData: string | undefined
    faux.setResponses([
      (context) => {
        const message = context.messages[0]
        const image = message?.role === 'user' && Array.isArray(message.content)
          ? message.content.find((content) => content.type === 'image')
          : undefined
        imageData = image?.type === 'image' ? image.data : undefined
        return fauxAssistantMessage('image accepted')
      },
    ])
    let attachmentResolutions = 0
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(faux.provider),
      resolveAttachments() {
        attachmentResolutions += 1
        return attachmentStore
      },
    })
    const userMessage = createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'user' },
    })

    await collect(adapter.stream({
      ...request(controller.signal),
      messages: [userMessage],
    }))

    expect(attachmentResolutions).toBe(1)
    expect(attachmentReads).toBe(1)
    expect(imageData).toBe('iVBORw==')
  })

  it('rejects image input before attachment or provider access for text-only models', async () => {
    const faux = fauxProvider({
      provider: PROVIDER_ID,
      models: [{ id: MODEL_ID, input: ['text'] }],
    })
    const ref = Object.freeze({
      attachmentId: AttachmentId('fixture-image'),
      mediaType: 'image/png' as const,
      bytes: 4,
      width: 1,
      height: 1,
    })
    let attachmentReads = 0
    const attachmentStore = {
      async readImage() {
        attachmentReads += 1
        return { ref, data: new Uint8Array([137, 80, 78, 71]) }
      },
    } as unknown as AttachmentStore
    const adapter = new CodexDshAdapter({
      authService: new AuthServiceProbe(),
      profile: profile(faux.provider),
      resolveAttachments: () => attachmentStore,
    })
    const userMessage = createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'user' },
    })

    await expect(collect(adapter.stream({
      ...request(),
      messages: [userMessage],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(attachmentReads).toBe(0)
    expect(faux.state.callCount).toBe(0)
  })
})
