import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const PROVIDER_ID = 'openai-codex'
const PROVIDER_DISPLAY_NAME = 'OpenAI Codex (ChatGPT)'
const RESULT_VARIABLE = 'DSH_CODEX_SUB_PROBE_RESULT'
const networkCounter = '__DSH_CODEX_SUB_NETWORK_ATTEMPTS__'

export const name = 'dsh-codex-sub-packed-install-probe'
export const inject = ['llm']

function ownErrorCode(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor?.enumerable === true && 'value' in descriptor
    ? descriptor.value
    : undefined
}

async function waitForProvider(ctx) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matches = ctx.llm.listProviders().filter(({ id }) => id === PROVIDER_ID)
    if (matches.length > 0) {
      return matches
    }
    await delay(25)
  }
  throw new Error('The packed Codex provider route did not become available.')
}

export async function apply(ctx) {
  const resultPath = process.env[RESULT_VARIABLE]
  if (resultPath === undefined || resultPath.length === 0) {
    throw new Error(`${RESULT_VARIABLE} is required.`)
  }

  // Cordis initializes sibling bundle rows concurrently, so observe the public
  // registry until the asynchronously linked package root finishes applying.
  const matchingProviders = await waitForProvider(ctx)
  const models = await ctx.llm.listModels(PROVIDER_ID)
  const modelIds = models.map(({ id }) => id)
  const firstModel = models[0]
  if (firstModel === undefined) {
    throw new Error('The packed Codex catalog is empty.')
  }
  const resolved = await ctx.llm.resolveModelInfo(PROVIDER_ID, firstModel.id)

  let duplicateCode
  try {
    ctx.llm.registerAdapter([PROVIDER_ID], {
      listModels: async () => [],
      providerInfo: () => ({ id: PROVIDER_ID, name: 'probe' }),
      resolveModel: async (_provider, model) => ({ provider: PROVIDER_ID, id: model }),
      stream: async function * () {},
    })
  } catch (error) {
    duplicateCode = ownErrorCode(error)
  }

  let authFailureCode
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER_ID,
    model: firstModel.id,
    messages: [],
  })) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      authFailureCode = chunk.reason.failure.code
    }
  }

  const routeAfterConflict = ctx.llm.listProviders().filter(({ id }) => id === PROVIDER_ID)
  await writeFile(resultPath, `${JSON.stringify({
    authFailureCode,
    catalogIdsAreUnique: new Set(modelIds).size === modelIds.length,
    duplicateCode,
    modelCount: models.length,
    networkAttempts: globalThis[networkCounter] ?? -1,
    providerDisplayMatches: matchingProviders[0]?.name === PROVIDER_DISPLAY_NAME,
    providerOccurrences: matchingProviders.length,
    resolvedMatches: resolved.provider === PROVIDER_ID && resolved.id === firstModel.id,
    routeOccurrencesAfterConflict: routeAfterConflict.length,
  })}\n`, { encoding: 'utf8', flag: 'wx' })
}
