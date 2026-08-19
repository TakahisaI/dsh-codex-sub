import { readFile } from 'node:fs/promises'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { PROVIDER_DISPLAY_NAME, PROVIDER_ID } from '../../src/core/constants.js'

const FIXTURE_MODEL_ID = 'contract-fixture-model'
const FIXTURE_MODEL_NAME = 'Contract Fixture Model'
const CONFLICT_PROBE_PROVIDER = 'contract-conflict-probe'
const UNOWNED_SETTINGS_NAMESPACE = 'contract-unowned-settings'

class FixtureAdapter extends LlmAdapter {
  readonly #model: Readonly<LlmModelInfo>

  constructor() {
    super()
    this.#model = Object.freeze({
      provider: PROVIDER_ID,
      id: FIXTURE_MODEL_ID,
      name: FIXTURE_MODEL_NAME,
      description: 'Offline model-registration contract fixture.',
      inputModalities: Object.freeze(['text'] as const),
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return Object.freeze({ id: provider, name: PROVIDER_DISPLAY_NAME })
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return provider === PROVIDER_ID ? Object.freeze([this.#model]) : Object.freeze([])
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Object.freeze({
      provider,
      id: model,
      name: model === FIXTURE_MODEL_ID ? FIXTURE_MODEL_NAME : model,
    })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'stop' }) })
  }
}

function registrationPlugin(providers: string[]) {
  return {
    name: 'dsh-codex-sub-registration-contract',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.registerAdapter(providers, new FixtureAdapter())
    },
  }
}

describe('DSH model registration contract', () => {
  it('exposes one live provider and fake catalog through the public selector seams', async () => {
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    let topologyUpdates = 0
    const disposeListener = ctx.on('llm/adapters-updated', () => {
      topologyUpdates += 1
    })
    const adapterFiber = ctx.plugin(registrationPlugin([PROVIDER_ID]))

    try {
      try {
        await adapterFiber

        expect(ctx.llm.listProviders()).toEqual([
          { id: PROVIDER_ID, name: PROVIDER_DISPLAY_NAME },
        ])
        expect(await ctx.llm.listModels(PROVIDER_ID)).toEqual([
          {
            provider: PROVIDER_ID,
            id: FIXTURE_MODEL_ID,
            name: FIXTURE_MODEL_NAME,
            description: 'Offline model-registration contract fixture.',
            inputModalities: ['text'],
          },
        ])
        expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, FIXTURE_MODEL_ID)).toEqual({
          provider: PROVIDER_ID,
          id: FIXTURE_MODEL_ID,
          name: FIXTURE_MODEL_NAME,
        })
        expect(ctx.llm.listConfigurableProviders()).toEqual([])
        await expect(
          ctx.llm.discoverModels(UNOWNED_SETTINGS_NAMESPACE, { provider: PROVIDER_ID }),
        ).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
        expect(topologyUpdates).toBe(1)

        for (const unownedService of ['agent', 'search', 'session', 'settings', 'tool', 'web']) {
          expect(ctx.get(unownedService)).toBeUndefined()
        }
      } finally {
        await adapterFiber.dispose()
      }

      expect(ctx.llm.listProviders()).toEqual([])
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
      await expect(ctx.llm.listModels(PROVIDER_ID)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
      expect(topologyUpdates).toBe(2)
    } finally {
      disposeListener()
      await runtimeFiber.dispose()
    }

    expect(ctx.get('llm')).toBeUndefined()
  })

  it('rejects duplicate ownership atomically and preserves the serving registration', async () => {
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    let topologyUpdates = 0
    const disposeListener = ctx.on('llm/adapters-updated', () => {
      topologyUpdates += 1
    })
    const servingFiber = ctx.plugin(registrationPlugin([PROVIDER_ID]))
    await servingFiber
    const conflictingFiber = ctx.plugin(registrationPlugin([
      CONFLICT_PROBE_PROVIDER,
      PROVIDER_ID,
    ]))

    try {
      await expect(conflictingFiber.await()).rejects.toMatchObject({
        code: 'DUPLICATE_ADAPTER',
      })
      expect(ctx.llm.listProviders()).toEqual([
        { id: PROVIDER_ID, name: PROVIDER_DISPLAY_NAME },
      ])
      await expect(ctx.llm.listModels(CONFLICT_PROBE_PROVIDER)).rejects.toMatchObject({
        code: 'NO_ADAPTER',
      })
      expect(await ctx.llm.listModels(PROVIDER_ID)).toHaveLength(1)
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
      expect(topologyUpdates).toBe(1)
    } finally {
      await conflictingFiber.dispose()
      await servingFiber.dispose()
      disposeListener()
      await runtimeFiber.dispose()
    }
  })

  it('keeps the bundle row addressed to the package root export', async () => {
    const packageMetadata = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly name?: unknown
      readonly main?: unknown
      readonly exports?: Readonly<Record<string, unknown>>
      readonly dsh?: { readonly bundle?: { readonly patch?: unknown } }
    }
    const patch = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

    expect(packageMetadata.name).toBe('dsh-codex-sub')
    expect(packageMetadata.main).toBe('lib/index.mjs')
    expect(packageMetadata.exports).toHaveProperty('.')
    expect(packageMetadata.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patch).toMatch(/^\s*- id: llm-codex-sub\s*$/m)
    expect(patch).toMatch(/^\s*name: dsh-codex-sub\s*$/m)
    expect(patch).not.toMatch(/settings|search|tool|web/i)
  })
})
