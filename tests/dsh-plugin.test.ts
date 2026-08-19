import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished } from 'vitest'

import * as packageRoot from '../src/index.js'
import {
  PLUGIN_NAME,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from '../src/core/constants.js'
import * as plugin from '../src/dsh/plugin.js'

class ExistingAdapter extends LlmAdapter {
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function cleanup(...disposers: Array<() => void | Promise<void>>): void {
  onTestFinished(async () => {
    for (const dispose of disposers) {
      await dispose()
    }
  })
}

describe('production Cordis plugin', () => {
  it('exports only the plugin contract and stable constants from the package root', () => {
    expect(Object.keys(packageRoot).sort()).toEqual([
      'AUTH_DIRECTORY_NAME',
      'AUTH_FILENAME',
      'PACKAGE_NAME',
      'PLUGIN_NAME',
      'PLUGIN_ROW_ID',
      'PROVIDER_DISPLAY_NAME',
      'PROVIDER_ID',
      'apply',
      'inject',
      'name',
    ])
    expect(packageRoot.name).toBe(PLUGIN_NAME)
    expect(packageRoot.inject).toEqual(['llm'])
  })

  it('registers one real catalog route and disposes it with the plugin fiber', async () => {
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    const pluginFiber = ctx.plugin(plugin)
    cleanup(() => pluginFiber.dispose(), () => runtimeFiber.dispose())

    await pluginFiber

    expect(ctx.llm.listProviders()).toEqual([
      { id: PROVIDER_ID, name: PROVIDER_DISPLAY_NAME },
    ])
    expect((await ctx.llm.listModels(PROVIDER_ID)).length).toBeGreaterThan(0)
    expect(ctx.llm.listConfigurableProviders()).toEqual([])

    await pluginFiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('maps duplicate ownership without disturbing the serving adapter', async () => {
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    const existingFiber = ctx.plugin({
      name: 'existing-codex-owner',
      inject: ['llm'],
      apply(ownerContext: Context) {
        ownerContext.llm.registerAdapter([PROVIDER_ID], new ExistingAdapter())
      },
    })
    await existingFiber
    const pluginFiber = ctx.plugin(plugin)
    cleanup(
      () => pluginFiber.dispose(),
      () => existingFiber.dispose(),
      () => runtimeFiber.dispose(),
    )

    await expect(pluginFiber.await()).rejects.toMatchObject({
      code: 'CODEX_PROVIDER_CONFLICT',
      safeDetails: { provider: PROVIDER_ID },
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: PROVIDER_ID, name: PROVIDER_ID },
    ])
  })
})
