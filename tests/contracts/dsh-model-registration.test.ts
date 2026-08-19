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
import { describe, expect, it, onTestFinished } from 'vitest'

import {
  PACKAGE_NAME,
  PLUGIN_ROW_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from '../../src/core/constants.js'

const FIXTURE_MODEL_ID = 'contract-fixture-model'
const FIXTURE_MODEL_NAME = 'Contract Fixture Model'
const CONFLICT_PROBE_PROVIDER = 'contract-conflict-probe'

type Cleanup = () => void | Promise<void>

function cleanupAfterTest(...cleanups: Cleanup[]): void {
  onTestFinished(async () => {
    const failures: unknown[] = []
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'DSH registration contract cleanup failed.')
    }
  })
}

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

  // This catalog fixture describes the single openai-codex route exercised by the successful mount.
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Object.freeze([this.#model])
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Object.freeze({
      provider,
      id: model,
      name: FIXTURE_MODEL_NAME,
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
  it('exposes one live provider and fake catalog through the public LLM registry', async () => {
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    let topologyUpdates = 0
    const disposeListener = ctx.on('llm/adapters-updated', () => {
      topologyUpdates += 1
    })
    const adapterFiber = ctx.plugin(registrationPlugin([PROVIDER_ID]))
    cleanupAfterTest(
      () => adapterFiber.dispose(),
      () => {
        disposeListener()
      },
      () => runtimeFiber.dispose(),
    )

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
      ctx.llm.discoverModels(PACKAGE_NAME, { provider: PROVIDER_ID }),
    ).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    expect(topologyUpdates).toBe(1)

    await adapterFiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    await expect(ctx.llm.listModels(PROVIDER_ID)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(topologyUpdates).toBe(2)

    disposeListener()
    await runtimeFiber.dispose()
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
    cleanupAfterTest(
      () => conflictingFiber.dispose(),
      () => servingFiber.dispose(),
      () => {
        disposeListener()
      },
      () => runtimeFiber.dispose(),
    )

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

    await conflictingFiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([
      { id: PROVIDER_ID, name: PROVIDER_DISPLAY_NAME },
    ])
    await expect(ctx.llm.listModels(CONFLICT_PROBE_PROVIDER)).rejects.toMatchObject({
      code: 'NO_ADAPTER',
    })
    expect(topologyUpdates).toBe(1)

    await servingFiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    await expect(ctx.llm.listModels(PROVIDER_ID)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(topologyUpdates).toBe(2)

    disposeListener()
    await runtimeFiber.dispose()
    expect(ctx.get('llm')).toBeUndefined()
  })

  it('keeps one bundle insert row addressed to the built package root export', async () => {
    const packageMetadata = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly name?: unknown
      readonly main?: unknown
      readonly exports?: Readonly<Record<string, unknown>>
      readonly dsh?: { readonly bundle?: { readonly patch?: unknown } }
    }
    const patch = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

    expect(packageMetadata.name).toBe(PACKAGE_NAME)
    expect(packageMetadata.main).toBe('lib/index.mjs')
    expect(packageMetadata.exports?.['.']).toEqual({
      types: './lib/index.d.mts',
      default: './lib/index.mjs',
    })
    expect(packageMetadata.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    // Canonical equality rejects extra operations, rows, or keys without adding a YAML test dependency.
    expect(patch).toBe([
      '- insert:',
      `    - id: ${PLUGIN_ROW_ID}`,
      `      name: ${PACKAGE_NAME}`,
      '',
    ].join('\n'))
  })
})
