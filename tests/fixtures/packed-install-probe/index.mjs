import { zstdDecompressSync } from 'node:zlib'
import { rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

const PROVIDER_ID = 'openai-codex'
const PROVIDER_DISPLAY_NAME = 'OpenAI Codex (ChatGPT)'
const RESULT_VARIABLE = 'DSH_CODEX_SUB_PROBE_RESULT'
const PHASE_VARIABLE = 'DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE'
const networkCounter = '__DSH_CODEX_SUB_NETWORK_ATTEMPTS__'
const nativeRecordKey = 'llm-pi-ai/openai-codex'

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

// ---------------------------------------------------------------------------
// Requests-phase transport stub (#51).
//
// The requests boot signs the packed route in and streams through the real
// pi-ai Codex API client, so this boot cannot share the loader-order network
// blocker: the stub replaces globalThis.fetch at plugin-module load (before
// any probe traffic) and keeps every door closed except two — the pinned
// Codex responses endpoint, which is answered by a scripted in-memory SSE
// transport, and the Host's own loopback HTTP endpoints, which delegate to
// the real fetch captured at load time. Every other destination fails closed
// and is recorded as an attempted external host. WebSockets are answered by
// a constructor that refuses every dial, exercising pi-ai's documented
// fall-back to the SSE transport without transmitting anything.
// ---------------------------------------------------------------------------

const CODEX_SSE_URL = 'https://chatgpt.com/backend-api/codex/responses'
const REQUEST_TEXT = 'packed rc.1 request contracts'
const RETRY_MARKER = 'RETRY_ONCE_PACKED_RC1'
const CANCEL_MARKER = 'CANCEL_STREAM_PACKED_RC1'
const RESPONSE_ID = 'resp_packed_rc1_probe'
// Base64 of the 1x1 PNG below; the wire assertion matches the data URL the
// adapter builds from the store-resolved bytes.
const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const requestTransport = {
  providerAttempts: 0,
  wsDialRejects: 0,
  scriptedTransportFailuresRemaining: 0,
  sawReplayContinuation: false,
  sawExpectedImage: false,
  expectImageRef: undefined,
  externalHosts: new Set(),
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

function decodeRequestBody(init) {
  const headers = new Headers(init.headers)
  const rawBody = init.body instanceof Uint8Array ? init.body : Buffer.from(String(init.body ?? ''), 'utf8')
  const bodyText = headers.get('content-encoding') === 'zstd'
    ? zstdDecompressSync(rawBody).toString('utf8')
    : Buffer.from(rawBody).toString('utf8')
  return JSON.parse(bodyText)
}

function inputItems(body) {
  return Array.isArray(body?.input) ? body.input : []
}

function userTextIncludes(body, marker) {
  return inputItems(body).some((entry) => (
    entry?.role === 'user'
    && Array.isArray(entry.content)
    && entry.content.some((piece) => piece.type === 'input_text'
      && typeof piece.text === 'string'
      && piece.text.includes(marker))
  ))
}

function marksReplayContinuation(body) {
  // Replay metadata survives only if the durable assistant history carried a
  // usable envelope: the continuation request then contains the native
  // assistant message item restored from that envelope.
  return inputItems(body).some((entry) => (
    entry?.role === 'assistant'
    && typeof entry.id === 'string'
    && entry.id.startsWith(RESPONSE_ID)
  ))
}

function carriesExpectedImage(body) {
  // The adapter resolves the attachment through the store and puts the
  // decoded bytes on the wire as a data URL, so match the admitted PNG's
  // base64 rather than the durable reference id.
  if (requestTransport.expectImageRef === undefined) return false
  return inputItems(body).some((entry) => (
    entry?.role === 'user'
    && Array.isArray(entry.content)
    && entry.content.some((piece) => piece.type === 'input_image'
      && typeof piece.image_url === 'string'
      && piece.image_url.startsWith(`data:image/png;base64,${ONE_PX_PNG_BASE64}`))
  ))
}

function scriptedSuccessStream(controller) {
  const encoder = new TextEncoder()
  const messageId = `${RESPONSE_ID}-m0`
  const frames = [
    sseFrame({ type: 'response.created', response: { id: RESPONSE_ID } }),
    sseFrame({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: messageId, status: 'in_progress', content: [] },
    }),
    sseFrame({
      type: 'response.output_text.delta',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: REQUEST_TEXT,
    }),
    sseFrame({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: messageId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: REQUEST_TEXT, annotations: [] }],
      },
    }),
    sseFrame({
      type: 'response.completed',
      response: {
        id: RESPONSE_ID,
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        output: [{
          type: 'message',
          id: messageId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: REQUEST_TEXT, annotations: [] }],
        }],
      },
    }),
  ]
  for (const frame of frames) controller.enqueue(encoder.encode(frame))
  controller.close()
}

class RejectingWebSocket {
  constructor(url) {
    this.url = String(url)
    queueMicrotask(() => {
      if (!/^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/] |$)/u.test(this.url)) {
        requestTransport.wsDialRejects += 1
      }
      const closeEvent = typeof CloseEvent === 'function'
        ? new CloseEvent('close', { code: 1006, reason: 'packed probe rejected the dial', wasClean: false })
        : Object.assign(new Event('close'), { code: 1006, reason: 'packed probe rejected the dial', wasClean: false })
      const errorEvent = new Event('error')
      // pi-ai's connect path listens for open/error/close; the error event
      // alone is enough to reject the dial promise.
      this.onerror?.(errorEvent)
      this.onclose?.(closeEvent)
    })
  }

  addEventListener() {}

  removeEventListener() {}

  close() {}

  send() {
    throw new Error('Packed probe WebSocket transport must not transmit.')
  }
}

function installRequestTransport(realFetch) {
  globalThis.fetch = async function packedProbeFetch(url, init) {
    const urlText = String(url)
    if (urlText === CODEX_SSE_URL) {
      requestTransport.providerAttempts += 1
      let body
      try {
        body = decodeRequestBody(init)
      } catch {
        throw new Error('Packed probe could not decode its own request body.')
      }
      if (marksReplayContinuation(body)) {
        requestTransport.sawReplayContinuation = true
      }
      if (carriesExpectedImage(body)) {
        requestTransport.sawExpectedImage = true
      }
      if (userTextIncludes(body, RETRY_MARKER) && requestTransport.scriptedTransportFailuresRemaining > 0) {
        requestTransport.scriptedTransportFailuresRemaining -= 1
        // Pre-response transport failure. pi-ai's own client performs zero
        // internal retries (maxRetries defaults to 0), so the failure reaches
        // the DSH boundary unmodified and any retry decision is DSH-owned.
        throw new TypeError('stubbed fetch failed: ECONNRESET')
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          if (userTextIncludes(body, CANCEL_MARKER)) {
            // Hold the headers open until the caller aborts; the abort path
            // must surface before any output byte exists.
            init.signal?.addEventListener('abort', () => {
              try {
                controller.enqueue(encoder.encode(sseFrame({ type: 'response.created', response: { id: RESPONSE_ID } })))
                controller.error(new Error('Request was aborted'))
              } catch {
                // The consumer may already be gone; nothing to release.
              }
            }, { once: true })
            return
          }
          scriptedSuccessStream(controller)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//u.test(`${urlText}${urlText.endsWith('/') ? '' : '/'}`) || /^http:\/\/localhost(:\d+)?$/u.test(urlText)) {
      // The Host's own loopback surface (health checks, local RPC).
      return realFetch(url, init)
    }
    const host = new URL(urlText).host
    requestTransport.externalHosts.add(host)
    throw new Error('Network access is disabled during the packed-install probe.')
  }
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: globalThis.fetch,
  })
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: RejectingWebSocket,
  })
}

if (process.env[PHASE_VARIABLE] === 'requests') {
  // The scripted transport owns this boot's fetch. Keep the blocker's
  // counter contract: attempts recorded by the stub count toward the same
  // public tally the lane asserts on for every other phase.
  installRequestTransport(globalThis.fetch.bind(globalThis))
  globalThis[networkCounter] = requestTransport.providerAttempts
}

export const name = 'dsh-codex-sub-packed-install-probe'
export const inject = ['llm', 'credentials', 'attachments']

function textRequest(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function collectModelStream(ctx, modelId, options) {
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER_ID,
    model: modelId,
    ...options,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

function assembledText(chunks) {
  let text = ''
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

async function runRequestsPhase(ctx, modelId) {
  // Attachment proof: use the deployment's real LocalAttachmentStore end to
  // end. A genuine 1x1 PNG is admitted through saveImages (validation,
  // content-addressed storage, durable reference), then referenced by the
  // request so the packed adapter resolves it through readImage at request
  // time. The fake transport asserts the decoded image bytes arrived on the
  // wire inside the provider payload. The image request targets an
  // image-capable catalog route resolved by the caller.
  const onePxPng = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
    0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
    120, 218, 99, 100, 96, 248, 95, 15, 0, 2, 135, 1, 128, 235, 71, 186, 146,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ])
  const [attachmentRef] = await ctx.attachments.saveImages([{
    data: onePxPng,
    mediaType: 'image/png',
    name: 'packed-probe.png',
  }])
  const attachmentId = attachmentRef.attachmentId

  // 1. Success stream carrying one attachment reference: proves attachment
  //    resolution, the image-budget decision, provider streaming, usage, and
  //    the replay envelope on the packed install.
  const totalsBeforeSuccess = requestTransport.providerAttempts
  requestTransport.expectImageRef = attachmentId
  const successChunks = await collectModelStream(ctx, modelId, {
    messages: [createUserMessage({
      content: [{
        type: 'image',
        attachment: Object.freeze({ ...attachmentRef }),
      }],
      source: { kind: 'user' },
    })],
  })
  requestTransport.expectImageRef = undefined
  const successFinish = successChunks.at(-1)
  const successReplay = successFinish?.reason?.kind === 'stop' ? successFinish.replayState : undefined
  const success = {
    finishKind: successFinish?.reason?.kind ?? null,
    replayPresent: successReplay !== undefined && successReplay !== null,
    responseId: successReplay?.response?.responseId ?? null,
    textAssembled: assembledText(successChunks) === REQUEST_TEXT,
    imageOnWire: requestTransport.sawExpectedImage,
    providerAttempts: requestTransport.providerAttempts - totalsBeforeSuccess,
  }

  // 2. Replay survival: feed the assembled assistant message back as durable
  //    history and observe the native continuation on the wire.
  const totalsBeforeReplay = requestTransport.providerAttempts
  const replayChunks = await collectModelStream(ctx, modelId, {
    messages: [createAssistantMessage({
      content: [{ type: 'text', text: REQUEST_TEXT }],
      source: {
        provider: PROVIDER_ID,
        model: successReplay?.response?.model ?? 'unknown-model',
        replayState: successReplay,
      },
    })],
  })
  const replayFinish = replayChunks.at(-1)
  const replay = {
    finishKind: replayFinish?.reason?.kind ?? null,
    responseIdMatchesFirst: success.responseId === RESPONSE_ID
      && replayFinish?.replayState?.response?.responseId === RESPONSE_ID,
    continuationObserved: requestTransport.sawReplayContinuation,
    providerAttempts: requestTransport.providerAttempts - totalsBeforeReplay,
  }

  // 3. Retry boundary: one scripted transport failure. The production profile
  //    owns the retry policy; the probe observes that exactly one further
  //    provider attempt follows and that the failure classification stays
  //    stable at the public boundary.
  requestTransport.scriptedTransportFailuresRemaining = 1
  const totalsBeforeRetry = requestTransport.providerAttempts
  const retryChunks = await collectModelStream(ctx, modelId, {
    messages: [textRequest(`please ${RETRY_MARKER}`)],
  })
  const retryFinish = retryChunks.at(-1)
  const retry = {
    finishKind: retryFinish?.reason?.kind ?? null,
    failureCode: retryFinish?.reason?.kind === 'error' ? retryFinish.reason.failure?.code ?? null : null,
    providerAttempts: requestTransport.providerAttempts - totalsBeforeRetry,
  }

  // 4. Cancellation: abort mid-stream and require a terminal aborted outcome
  //    with zero further provider attempts and no admitted output delta.
  const totalsBeforeCancel = requestTransport.providerAttempts
  const controller = new AbortController()
  const cancellationChunks = []
  let cancellationThrewAbort = false
  const cancellationCompletion = (async () => {
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER_ID,
      model: modelId,
      messages: [textRequest(`please ${CANCEL_MARKER}`)],
      signal: controller.signal,
    })) {
      cancellationChunks.push(chunk)
    }
  })().catch((error) => {
    if (error?.name === 'AbortError') {
      cancellationThrewAbort = true
      return
    }
    throw error
  })
  await delay(150)
  controller.abort(new DOMException('The operation was aborted.', 'AbortError'))
  await cancellationCompletion
  const cancellationFinish = cancellationChunks.at(-1)
  const cancellation = {
    finishKind: cancellationFinish?.reason?.kind ?? null,
    threwAbort: cancellationThrewAbort,
    providerAttempts: requestTransport.providerAttempts - totalsBeforeCancel,
    partialOutputEmitted: cancellationChunks.some((chunk) => (
      chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
    )),
  }

  return {
    success,
    replay,
    retry,
    cancellation,
    totals: {
      providerAttempts: requestTransport.providerAttempts,
      wsDialRejects: requestTransport.wsDialRejects,
      externalHosts: [...requestTransport.externalHosts].sort(),
    },
  }
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

  const phase = process.env[PHASE_VARIABLE]
  let directoryConflictCode
  let nativeCredential
  let nativeCredentialMatches = false
  let nativeCredentialMatchesForeignValues = false
  let nativeCredentialDeleted = false
  let requests
  if (phase !== undefined) {
    const directoryEntry = {
      provider: PROVIDER_ID,
      displayName: PROVIDER_DISPLAY_NAME,
      settingsNs: 'llm-codex-sub-packed-candidate',
      settingsPath: [],
    }
    try {
      ctx.llm.registerConfigurableProviders([directoryEntry])
      ctx.llm.registerConfigurableProviders([directoryEntry])
    } catch (error) {
      directoryConflictCode = ownErrorCode(error)
    }

    if (phase === 'save') {
      await ctx.credentials.modifyRecord(nativeRecordKey, async () => ({
        kind: 'grant',
        payload: {
          type: 'oauth',
          access: process.env.CANDIDATE_ACCESS_SENTINEL,
          refresh: process.env.CANDIDATE_REFRESH_SENTINEL,
          expires: Date.now() + 3_600_000,
          accountId: process.env.CANDIDATE_ACCOUNT_SENTINEL,
        },
      }))
      nativeCredential = await ctx.credentials.readRecord(nativeRecordKey)
      nativeCredentialMatches = nativeCredential?.payload?.access === process.env.CANDIDATE_ACCESS_SENTINEL
        && nativeCredential?.payload?.refresh === process.env.CANDIDATE_REFRESH_SENTINEL
        && nativeCredential?.payload?.accountId === process.env.CANDIDATE_ACCOUNT_SENTINEL
      nativeCredentialMatchesForeignValues = nativeCredential?.payload?.access === process.env.CANDIDATE_PACKAGE_ACCESS_SENTINEL
        || nativeCredential?.payload?.refresh === process.env.CANDIDATE_PACKAGE_REFRESH_SENTINEL
        || nativeCredential?.payload?.accountId === process.env.CANDIDATE_PACKAGE_ACCOUNT_SENTINEL
    } else if (phase === 'requests') {
      // The image-capable model proves the attachment path; the first catalog
      // entry may be text-only, so resolve the route explicitly.
      const models = await ctx.llm.listModels(PROVIDER_ID)
      const imageModel = models.find((model) => model.inputModalities?.includes('image'))
      requests = await runRequestsPhase(ctx, imageModel?.id ?? firstModel.id)
    } else {
      nativeCredential = await ctx.credentials.readRecord(nativeRecordKey)
      nativeCredentialMatches = nativeCredential?.payload?.access === process.env.CANDIDATE_ACCESS_SENTINEL
        && nativeCredential?.payload?.refresh === process.env.CANDIDATE_REFRESH_SENTINEL
        && nativeCredential?.payload?.accountId === process.env.CANDIDATE_ACCOUNT_SENTINEL
      nativeCredentialMatchesForeignValues = nativeCredential?.payload?.access === process.env.CANDIDATE_PACKAGE_ACCESS_SENTINEL
        || nativeCredential?.payload?.refresh === process.env.CANDIDATE_PACKAGE_REFRESH_SENTINEL
        || nativeCredential?.payload?.accountId === process.env.CANDIDATE_PACKAGE_ACCOUNT_SENTINEL
      if (phase === 'post-logout') {
        await ctx.credentials.deleteRecord(nativeRecordKey)
        nativeCredentialDeleted = await ctx.credentials.readRecord(nativeRecordKey) === undefined
      }
      if (phase === 'confirm-deleted') {
        nativeCredentialDeleted = nativeCredential === undefined
      }
    }
  }

  const routeAfterConflict = ctx.llm.listProviders().filter(({ id }) => id === PROVIDER_ID)
  const encodedResult = `${JSON.stringify({
    authFailureCode,
    catalogIdsAreUnique: new Set(modelIds).size === modelIds.length,
    directoryConflictCode,
    duplicateCode,
    modelCount: models.length,
    nativeCredentialKind: nativeCredential?.kind,
    nativeCredentialType: nativeCredential?.payload?.type,
    networkAttempts: phase === 'requests'
      ? requestTransport.providerAttempts
      : globalThis[networkCounter] ?? -1,
    nativeCredentialMatches,
    nativeCredentialMatchesForeignValues,
    nativeCredentialDeleted,
    ...(phase === undefined ? {} : { phase }),
    ...(requests === undefined ? {} : { requests }),
    providerDisplayMatches: matchingProviders[0]?.name === PROVIDER_DISPLAY_NAME,
    providerOccurrences: matchingProviders.length,
    resolvedMatches: resolved.provider === PROVIDER_ID && resolved.id === firstModel.id,
    routeOccurrencesAfterConflict: routeAfterConflict.length,
  })}\n`
  const temporaryResultPath = `${resultPath}.${process.pid}.tmp`

  try {
    await writeFile(temporaryResultPath, encodedResult, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryResultPath, resultPath)
  } catch (error) {
    await rm(temporaryResultPath, { force: true })
    throw error
  }
}
