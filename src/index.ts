import type { Context } from '@deepseek-ai/cordis'

import {
  AUTH_DIRECTORY_NAME,
  AUTH_FILENAME,
  PACKAGE_NAME,
  PLUGIN_NAME,
  PLUGIN_ROW_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from './core/constants.js'
import { CodexError } from './core/errors.js'

export {
  AUTH_DIRECTORY_NAME,
  AUTH_FILENAME,
  PACKAGE_NAME,
  PLUGIN_NAME,
  PLUGIN_ROW_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
}

export const name = PLUGIN_NAME
export const inject = ['llm']

interface RuntimeModule {
  readonly applyRuntime: (ctx: Context) => void | Promise<void>
}

function incompatibleRuntime(cause?: unknown): CodexError {
  return new CodexError('The installed runtime is not supported.', 'CODEX_INCOMPATIBLE_RUNTIME', {
    ...(cause === undefined ? {} : { cause }),
    safeDetails: {
      packageName: '@deepseek-ai/dsh-runtime',
      supported: 'compatible published exports',
      installed: 'unavailable',
    },
  })
}

async function loadRuntimeModule(): Promise<RuntimeModule> {
  const runtimeUrl = new URL('./runtime.mjs', import.meta.url)
  let loaded: unknown
  try {
    loaded = await import(runtimeUrl.href)
  } catch (error) {
    // Keep incompatible static DSH exports behind the package root so their
    // linker failures become the same safe compatibility classification.
    throw incompatibleRuntime(error)
  }
  if (
    loaded === null
    || typeof loaded !== 'object'
    || !('applyRuntime' in loaded)
    || typeof loaded.applyRuntime !== 'function'
  ) {
    throw incompatibleRuntime()
  }
  return loaded as RuntimeModule
}

export async function apply(ctx: Context): Promise<void> {
  const runtime = await loadRuntimeModule()
  await runtime.applyRuntime(ctx)
}
