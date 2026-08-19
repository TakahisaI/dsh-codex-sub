import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { inspect } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

const built = await import(new URL('../lib/index.mjs', import.meta.url))

if (
  typeof built.apply !== 'function'
  || built.name !== built.PLUGIN_NAME
  || built.PROVIDER_ID !== 'openai-codex'
  || !Array.isArray(built.inject)
  || built.inject.length !== 1
  || built.inject[0] !== 'llm'
) {
  throw new Error('Built package root does not expose the expected Cordis plugin contract.')
}

const ctx = new Context()
const runtimeFiber = ctx.plugin(LlmRuntime)
await runtimeFiber
const pluginFiber = ctx.plugin(built)

try {
  await pluginFiber
  const providers = ctx.llm.listProviders()
  if (
    providers.length !== 1
    || providers[0]?.id !== built.PROVIDER_ID
    || providers[0]?.name !== built.PROVIDER_DISPLAY_NAME
  ) {
    throw new Error('Built plugin did not register the expected provider route.')
  }
  const models = await ctx.llm.listModels(built.PROVIDER_ID)
  if (models.length === 0) {
    throw new Error('Built plugin exposed an empty provider catalog.')
  }
} finally {
  await pluginFiber.dispose()
  await runtimeFiber.dispose()
}

if (ctx.get('llm') !== undefined) {
  throw new Error('Built plugin smoke test did not dispose the LLM runtime.')
}

const isolated = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-built-entry-'))
try {
  const isolatedEntry = join(isolated, 'index.mjs')
  await copyFile(new URL('../lib/index.mjs', import.meta.url), isolatedEntry)
  const isolatedRoot = await import(pathToFileURL(isolatedEntry).href)
  let failure
  try {
    await isolatedRoot.apply({})
  } catch (error) {
    failure = error
  }
  if (
    failure === undefined
    || failure.code !== 'CODEX_INCOMPATIBLE_RUNTIME'
    || JSON.stringify(failure).includes(isolated)
    || inspect(failure).includes('Cannot find module')
    || inspect(failure).includes('[cause]')
  ) {
    throw new Error('A missing runtime module did not fail with a safe compatibility error.')
  }
} finally {
  await rm(isolated, { force: true, recursive: true })
}

process.stdout.write('Built package entry registers the route and safely rejects a missing runtime.\n')
