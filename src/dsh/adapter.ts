import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

import type { CodexAuthService } from '../core/contracts.js'
import {
  PACKAGE_NAME,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from '../core/constants.js'
import {
  isCodexError,
  type CodexError,
} from '../core/errors.js'
import {
  createOpenAiCodexRequestProvider,
  withCodexErrorCapture,
} from '../piai/request-auth-provider.js'

export const CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

export interface CodexDshAdapterOptions {
  readonly authService: CodexAuthService
  readonly profile?: ResolvedPiAiProviderProfile
  readonly resolveAttachments?: () => AttachmentStore | undefined
  readonly onReplayDegrade?: (detail: {
    readonly provider: string
    readonly model: string
    readonly reason: string
  }) => void
}

function createProductionProfile(): ResolvedPiAiProviderProfile {
  return Object.freeze({
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    streamIdleTimeoutMs: CODEX_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `${PACKAGE_NAME}.${PROVIDER_ID}.retryPolicy`),
    piProvider: createOpenAiCodexRequestProvider(),
    configuredMaxTokens: new Map<string, number>(),
  })
}

function requireCodexProfile(profile: ResolvedPiAiProviderProfile): ResolvedPiAiProviderProfile {
  if (profile.provider !== PROVIDER_ID || profile.piProvider.id !== PROVIDER_ID) {
    throw new LlmError('The Codex adapter profile is invalid.', 'INVALID_PROVIDER_PROFILE')
  }
  return profile
}

function toDshError(error: unknown): never {
  if (isCodexError(error)) {
    throw new LlmError(error.message, error.code)
  }
  throw error
}

export function withRequestSignal(
  store: AttachmentStore,
  requestSignal: AbortSignal | undefined,
): AttachmentStore {
  if (requestSignal === undefined) {
    return store
  }
  const readImage: AttachmentStore['readImage'] = (reference, signal) => {
    const combinedSignal = signal === undefined || signal === requestSignal
      ? requestSignal
      : AbortSignal.any([requestSignal, signal])
    return store.readImage(reference, combinedSignal)
  }
  return new Proxy(store, {
    get(target, property) {
      if (property === 'readImage') {
        return readImage
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export class CodexDshAdapter extends LlmAdapter {
  readonly #authService: CodexAuthService
  readonly #catalogAdapter: PiAiAdapter
  readonly #onReplayDegrade: CodexDshAdapterOptions['onReplayDegrade']
  readonly #profile: ResolvedPiAiProviderProfile
  readonly #profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  readonly #resolveAttachments: CodexDshAdapterOptions['resolveAttachments']

  constructor(options: CodexDshAdapterOptions) {
    super()
    this.#authService = options.authService
    this.#resolveAttachments = options.resolveAttachments
    this.#onReplayDegrade = options.onReplayDegrade
    const profile = requireCodexProfile(options.profile ?? createProductionProfile())
    this.#profile = profile
    this.#profiles = new Map([[PROVIDER_ID, profile]])
    this.#catalogAdapter = this.#createDelegate(async () => undefined, undefined)
  }

  #createDelegate(
    resolveApiKey: () => Promise<string | undefined>,
    requestSignal: AbortSignal | undefined,
    captureCodexError?: (error: CodexError) => void,
  ): PiAiAdapter {
    const profiles = captureCodexError === undefined
      ? this.#profiles
      : new Map([[PROVIDER_ID, Object.freeze({
          ...this.#profile,
          piProvider: withCodexErrorCapture(this.#profile.piProvider, captureCodexError),
        })]])
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey,
      ...(this.#resolveAttachments === undefined
        ? {}
        : {
            resolveAttachments: () => {
              const store = this.#resolveAttachments?.()
              return store === undefined ? undefined : withRequestSignal(store, requestSignal)
            },
          }),
      ...(this.#onReplayDegrade === undefined
        ? {}
        : { onReplayDegrade: this.#onReplayDegrade }),
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.#catalogAdapter.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.#catalogAdapter.providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.#catalogAdapter.listModels(provider)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.#catalogAdapter.resolveModel(provider, model, signal)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let authPromise: Promise<string> | undefined

    let delegatedCodexError: CodexError | undefined
    const requestAdapter = this.#createDelegate(
      async () => {
        try {
          authPromise ??= this.#authService
            .resolveRequestAuth(options.signal)
            .then(({ bearerToken }) => bearerToken)
          return await authPromise
        } catch (error) {
          toDshError(error)
        }
      },
      options.signal,
      (error) => {
        delegatedCodexError ??= error
      },
    )
    try {
      for await (const chunk of requestAdapter.stream(options)) {
        if (delegatedCodexError !== undefined) {
          toDshError(delegatedCodexError)
        }
        yield chunk
      }
      if (delegatedCodexError !== undefined) {
        toDshError(delegatedCodexError)
      }
    } catch (error) {
      toDshError(error)
    }
  }
}
