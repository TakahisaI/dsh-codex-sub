import { zstdDecompressSync, deflateSync } from 'node:zlib'
import { rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  OFFLOADED_IMAGE_TEXT,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PROVIDER_ID = 'openai-codex'
const PROVIDER_DISPLAY_NAME = 'OpenAI Codex (ChatGPT)'
const RESULT_VARIABLE = 'DSH_CODEX_SUB_PROBE_RESULT'
const PHASE_VARIABLE = 'DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE'
const SESSION_VARIABLE = 'DSH_CODEX_SUB_REQUEST_SESSION_ID'
const networkCounter = '__DSH_CODEX_SUB_NETWORK_ATTEMPTS__'
const nativeRecordKey = 'llm-pi-ai/openai-codex'

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses'
const SEED_MARKER = 'PACKED_REPLAY_SEED_RC1'
const CONTINUE_MARKER = 'PACKED_REPLAY_CONTINUE_RC1'
const RETRY_MARKER = 'PACKED_RETRY_TOOL_RC1'
const CANCEL_PRE_MARKER = 'PACKED_CANCEL_PRE_RC1'
const CANCEL_MID_MARKER = 'PACKED_CANCEL_MID_RC1'
const CANCEL_MID_ARGUMENT_DELTA = '{"partial":"cancel-mid"}'
const ATTACH_MARKER = 'PACKED_IMAGE_BUDGET_RC1'
const SEED_TEXT = 'packed replay seed response'
const CONTINUE_TEXT = 'packed replay continuation response'
const RETRY_TEXT = 'packed retry final response'
const DERIVED_RETRY_CALL_ID = 'call_retry_once|fc_retry_once'
const ATTACH_TEXT = 'packed image budget response'
const TITLE_PIN = 'packed rc1 user title pin'
const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const transport = {
  providerAttempts: 0,
  fetchRequests: [],
  wsUrls: [],
  wsDials: [],
  wsSendCount: 0,
  loopbackUrls: [],
  externalHosts: new Set(),
  stickyError: undefined,
  retryAttempts: [],
  replayContinuationObserved: false,
  retryAcceptedFunctionCall: false,
  retryAcceptedFunctionOutput: false,
  retryFailureFramesComplete: false,
  retryFailureCompletedSeen: false,
  retryFinalResponseId: undefined,
  expectedImages: undefined,
  imageWire: undefined,
  cancellationStreams: 0,
}

function ownErrorCode(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined
}

async function waitForProvider(ctx) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matches = ctx.llm.listProviders().filter(({ id }) => id === PROVIDER_ID)
    if (matches.length > 0) return matches
    await delay(25)
  }
  throw new Error('The packed Codex provider route did not become available.')
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

function decodeRequestBody(init) {
  const headers = new Headers(init?.headers)
  const raw = init?.body instanceof Uint8Array
    ? init.body
    : Buffer.from(String(init?.body ?? ''), 'utf8')
  const text = headers.get('content-encoding') === 'zstd'
    ? zstdDecompressSync(raw).toString('utf8')
    : Buffer.from(raw).toString('utf8')
  return JSON.parse(text)
}

function inputItems(body) {
  return Array.isArray(body?.input) ? body.input : []
}

function userMarker(body, marker) {
  return inputItems(body).some((item) => item?.role === 'user'
    && Array.isArray(item.content)
    && item.content.some((part) => part?.type === 'input_text'
      && typeof part.text === 'string' && part.text.includes(marker)))
}

function exactAssistantReplay(body) {
  const item = inputItems(body).find((entry) => entry?.role === 'assistant')
  const expected = {
    type: 'message',
    role: 'assistant',
    id: 'msg_pi_1',
    status: 'completed',
    content: [{ type: 'output_text', text: SEED_TEXT, annotations: [] }],
  }
  if (item === undefined) return false
  return isDeepStrictEqual(item, expected)
}

function functionCallItems(body) {
  return inputItems(body).filter((entry) => entry?.type === 'function_call')
}

function functionOutputItems(body) {
  return inputItems(body).filter((entry) => entry?.type === 'function_call_output')
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, bytes) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, bytes])), 0)
  return Buffer.concat([length, typeBytes, bytes, checksum])
}

function rgbPng(size, seed) {
  const rowSize = 1 + size * 3
  const raw = Buffer.alloc(rowSize * size)
  for (let y = 0; y < size; y += 1) {
    const row = y * rowSize
    raw[row] = 0
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 3
      raw[offset] = (seed + x + y) & 0xff
      raw[offset + 1] = (seed * 3 + y) & 0xff
      raw[offset + 2] = (seed * 7 + x) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function responseTextFrames(responseId, itemId, text) {
  return [
    sseFrame({ type: 'response.created', response: { id: responseId } }),
    sseFrame({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: itemId, status: 'in_progress', content: [] },
    }),
    sseFrame({
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    sseFrame({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: itemId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }),
    sseFrame({
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        output: [{
          type: 'message',
          id: itemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }],
      },
    }),
  ]
}

function responseFunctionCallFrames(completed) {
  const item = {
    type: 'function_call',
    id: 'fc_retry_once',
    call_id: 'call_retry_once',
    name: 'record_side_effect',
    arguments: '{"value":"once"}',
  }
  const frames = [
    sseFrame({ type: 'response.created', response: { id: 'resp_packed_retry_once' } }),
    sseFrame({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }),
    sseFrame({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{"value":"once"}' }),
    sseFrame({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments }),
    sseFrame({ type: 'response.output_item.done', output_index: 0, item }),
  ]
  if (completed) {
    frames.push(sseFrame({
      type: 'response.completed',
      response: {
        id: 'resp_packed_retry_once',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        output: [item],
      },
    }))
  }
  return frames
}

function responseCancellationToolFrames() {
  const item = {
    type: 'function_call',
    id: 'fc_cancel_partial',
    call_id: 'call_cancel_partial',
    name: 'record_side_effect',
    arguments: '',
  }
  return [
    sseFrame({ type: 'response.created', response: { id: 'resp_packed_cancel_partial' } }),
    sseFrame({ type: 'response.output_item.added', output_index: 0, item }),
    sseFrame({
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: CANCEL_MID_ARGUMENT_DELTA,
    }),
  ]
}

function genericTransportError() {
  return new Error('Packed probe transport rejected request.')
}

function violation(message) {
  if (transport.stickyError === undefined) transport.stickyError = message
  throw genericTransportError()
}

function assertExactProvider(urlText, init) {
  if (urlText !== CODEX_URL || String(init?.method ?? 'GET') !== 'POST') return violation('provider endpoint or method mismatch')
  let parsed
  try { parsed = new URL(urlText) } catch { return violation('provider URL parse failure') }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || parsed.pathname !== '/backend-api/codex/responses' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return violation('provider URL shape mismatch')
}

function loopback(urlText) {
  let parsed
  try { parsed = new URL(urlText) } catch { return false }
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1') && /^\d+$/u.test(parsed.port)
}

function requestImages(body) {
  return inputItems(body).filter((entry) => entry?.role === 'user' && Array.isArray(entry.content)).flatMap((entry) => entry.content).filter((part) => part?.type === 'input_image').map((part) => part.image_url)
}

function scriptedBody(body, init, urlText = CODEX_URL) {
  assertExactProvider(urlText, init)
  if (transport.stickyError !== undefined) throw genericTransportError()
  transport.providerAttempts += 1
  const retryCalls = functionCallItems(body)
  const retryOutputs = functionOutputItems(body)
  if (userMarker(body, CONTINUE_MARKER)) {
    if (!exactAssistantReplay(body)) violation('replay assistant envelope mismatch')
    transport.replayContinuationObserved = true
    return { kind: 'text', responseId: 'resp_packed_replay_continue', itemId: 'msg_pi_3', text: CONTINUE_TEXT }
  }
  if (userMarker(body, SEED_MARKER)) return { kind: 'text', responseId: 'resp_packed_replay_seed', itemId: 'msg_pi_1', text: SEED_TEXT }
  if (userMarker(body, RETRY_MARKER)) {
    const attempt = transport.retryAttempts.length + 1
    transport.retryAttempts.push({ attempt, calls: retryCalls, outputs: retryOutputs })
    if (attempt === 1) {
      if (retryCalls.length !== 0 || retryOutputs.length !== 0) violation('failed retry call was adopted')
      return { kind: 'retry-failure' }
    }
    if (attempt === 2) {
      if (retryCalls.length !== 0 || retryOutputs.length !== 0) violation('retry attempt two adopted failed call')
      return { kind: 'function-call' }
    }
    if (attempt === 3) {
      const accepted = retryCalls.filter((item) => item.id === 'fc_retry_once' && item.call_id === 'call_retry_once' && item.name === 'record_side_effect' && item.arguments === '{"value":"once"}')
      const expectedOutput = { type: 'function_call_output', call_id: 'call_retry_once', output: 'once' }
      const outputs = retryOutputs.filter((item) => isDeepStrictEqual(item, expectedOutput))
      if (accepted.length !== 1 || outputs.length !== 1 || retryCalls.length !== 1 || retryOutputs.length !== 1) violation('accepted function call/output envelope mismatch')
      transport.retryAcceptedFunctionCall = true
      transport.retryAcceptedFunctionOutput = true
      transport.retryFinalResponseId = 'resp_packed_retry_final'
      return { kind: 'text', responseId: 'resp_packed_retry_final', itemId: 'msg_retry_final', text: RETRY_TEXT }
    }
    return violation('unexpected retry fetch after provider attempt three')
  }
  if (userMarker(body, CANCEL_PRE_MARKER)) return { kind: 'cancel-pre' }
  if (userMarker(body, CANCEL_MID_MARKER)) return { kind: 'cancel-mid' }
  if (userMarker(body, ATTACH_MARKER)) {
    const images = requestImages(body)
    const expected = transport.expectedImages
    if (expected === undefined) violation('attachment expectations were not installed')
    const offloaded = inputItems(body).flatMap((entry) => Array.isArray(entry?.content) ? entry.content : []).filter((part) => part?.type === 'input_text' && part.text === OFFLOADED_IMAGE_TEXT)
    const expectedSurvivors = expected.large.slice(1).map((data) => `data:image/png;base64,${data}`)
    if (offloaded.length !== 2 || images.length !== 4 || JSON.stringify(images) !== JSON.stringify(expectedSurvivors)) violation('image budget wire envelope mismatch')
    transport.imageWire = { survivors: images, offloaded: offloaded.length }
    return { kind: 'text', responseId: 'resp_packed_image_budget', itemId: 'msg_image_budget', text: ATTACH_TEXT }
  }
  return violation('unknown provider request marker')
}

function requestResponse(body, init, urlText = CODEX_URL) {
  const scripted = scriptedBody(body, init, urlText)
  const frames = scripted.kind === 'retry-failure'
    ? responseFunctionCallFrames(false)
    : scripted.kind === 'function-call'
      ? responseFunctionCallFrames(true)
      : scripted.kind === 'cancel-mid'
        ? responseCancellationToolFrames()
        : scripted.kind === 'cancel-pre'
          ? []
          : responseTextFrames(scripted.responseId, scripted.itemId, scripted.text)
  let frameIndex = 0
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      if (scripted.kind === 'retry-failure') {
        transport.retryFailureFramesComplete = false
        transport.retryFailureCompletedSeen = false
      }
      if (scripted.kind === 'cancel-mid') {
        transport.cancellationStreams += 1
        const abort = () => { try { controller.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* settled */ } }
        if (init.signal?.aborted === true) abort()
        else init.signal?.addEventListener('abort', abort, { once: true })
      }
      if (scripted.kind === 'cancel-pre') {
        transport.cancellationStreams += 1
        controller.close()
      }
    },
    pull(controller) {
      if (frameIndex < frames.length) {
        const frame = frames[frameIndex]
        frameIndex += 1
        if (scripted.kind === 'retry-failure' && frame.includes('response.completed')) transport.retryFailureCompletedSeen = true
        controller.enqueue(encoder.encode(frame))
        return
      }
      if (scripted.kind === 'retry-failure') {
        transport.retryFailureFramesComplete = true
        controller.error(new TypeError('fetch failed: ECONNRESET'))
        return
      }
      if (scripted.kind !== 'cancel-mid' && scripted.kind !== 'cancel-pre') controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

class GuardWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = String(url)
    this.readyState = GuardWebSocket.CONNECTING
    this.protocol = ''
    this.extensions = ''
    this.binaryType = 'blob'
    this.listeners = new Map()
    transport.wsUrls.push(this.url)
    this.dial = {
      url: this.url,
      listeners: {
        open: { add: 0, remove: 0 },
        error: { add: 0, remove: 0 },
        close: { add: 0, remove: 0 },
      },
    }
    transport.wsDials.push(this.dial)
    if (this.url !== CODEX_WS_URL) {
      let parsed
      try { parsed = new URL(this.url) } catch { return violation('websocket URL parse failure') }
      if (parsed.protocol !== 'wss:' || parsed.hostname !== 'chatgpt.com' || parsed.pathname !== '/backend-api/codex/responses' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return violation('websocket URL shape mismatch')
      return violation('unexpected websocket URL')
    }
    queueMicrotask(() => {
      this.readyState = GuardWebSocket.CLOSED
      this.dispatch('error', new Event('error'))
      this.dispatch('close', Object.assign(new Event('close'), { code: 1006, reason: 'packed probe closed', wasClean: false }))
    })
  }

  addEventListener(type, listener) {
    if (this.dial.listeners[type] !== undefined) this.dial.listeners[type].add += 1
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type, listener) {
    if (this.dial.listeners[type] !== undefined) this.dial.listeners[type].remove += 1
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener.call(this, event)
    const handler = this[`on${type}`]
    if (typeof handler === 'function') handler.call(this, event)
  }

  send() {
    transport.wsSendCount += 1
    throw genericTransportError()
  }

  close() {
    this.readyState = GuardWebSocket.CLOSED
  }
}

function installRequestTransport() {
  globalThis.fetch = async function packedProbeFetch(url, init = {}) {
    const urlText = String(url)
    const method = String(init?.method ?? 'GET')
    transport.fetchRequests.push({ url: urlText, method })
    if (transport.stickyError !== undefined) throw genericTransportError()
    if (urlText !== CODEX_URL || method !== 'POST') {
      if (loopback(urlText)) {
        transport.loopbackUrls.push(urlText)
        return violation('unexpected loopback endpoint')
      }
      let host = urlText
      try { host = new URL(urlText).hostname } catch { /* opaque text only */ }
      transport.externalHosts.add(host)
      return violation('unexpected external host')
    }
    let body
    try { body = decodeRequestBody(init) } catch { return violation('request body decode failure') }
    return requestResponse(body, init, urlText)
  }
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: globalThis.fetch })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: GuardWebSocket })
}

const phase = process.env[PHASE_VARIABLE]
if (phase === 'requests-seed' || phase === 'requests-resume') installRequestTransport()

export const name = 'dsh-codex-sub-packed-install-probe'
export const inject = ['llm', 'credentials', 'attachments', 'agents', 'sessions', 'sessionPersistence', 'tools', 'sessionTitle']

function textRequest(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function imageRequest(text, refs) {
  return createUserMessage({ content: [{ type: 'text', text }, ...refs.map((attachment) => ({ type: 'image', attachment: Object.freeze({ ...attachment }) }))], source: { kind: 'user' } })
}

function lastFinish(chunks) {
  return chunks.findLast((chunk) => chunk.type === 'finish')
}

function eventTypes(session, type) {
  return session.events.filter((event) => event.type === type)
}

function jsonHasAssistantText(messages, text) {
  return messages.some((message) => message?.role === 'assistant' && Array.isArray(message.content) && message.content.some((part) => part?.type === 'text' && part.text === text))
}

async function flushAndInspect(ctx, session) {
  await ctx.sessions.flush(session)
  const raw = await ctx.sessionPersistence.readRaw(session.id)
  const inspected = await ctx.sessionPersistence.inspect(session.id)
  if (raw === undefined || inspected === undefined) throw new Error('Packed probe persistence artifact was absent.')
  return { raw, inspected }
}

function persistedEvents(raw) {
  return raw.content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .filter((event) => typeof event?.type === 'string')
}

function orderedEvents(events) {
  return [...events].sort((left, right) => {
    const seqDelta = Number(left.seq ?? 0) - Number(right.seq ?? 0)
    return seqDelta !== 0 ? seqDelta : Number(left.time ?? 0) - Number(right.time ?? 0)
  })
}

function messageText(message) {
  return message?.content?.find((part) => part?.type === 'text')?.text
}

function publicAttachmentRef(ref) {
  const normalized = {
    attachmentId: ref?.attachmentId,
    mediaType: ref?.mediaType,
    bytes: ref?.bytes,
    width: ref?.width,
    height: ref?.height,
  }
  if (ref?.name !== undefined) normalized.name = ref.name
  return normalized
}

function exactUserText(message, text) {
  return message?.role === 'user'
    && message?.source?.kind === 'user'
    && Array.isArray(message.content)
    && message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0]?.text === text
}

function exactRetryAssistantCall(message) {
  const block = message?.content?.[0]
  return message?.role === 'assistant'
    && message?.source?.kind === 'model'
    && Array.isArray(message.content)
    && message.content.length === 1
    && block?.type === 'tool-call'
    && block.id === DERIVED_RETRY_CALL_ID
    && block.name === 'record_side_effect'
    && block.arguments === '{"value":"once"}'
}

function exactRetryToolResult(message) {
  const block = message?.content?.[0]
  return message?.role === 'user'
    && message?.source?.kind === 'tool'
    && message.source.callId === DERIVED_RETRY_CALL_ID
    && Array.isArray(message.content)
    && message.content.length === 1
    && block?.type === 'tool-result'
    && block.toolCallId === DERIVED_RETRY_CALL_ID
    && block.isError !== true
    && Array.isArray(block.content)
    && block.content.length === 1
    && block.content[0]?.type === 'text'
    && block.content[0]?.text === 'once'
}

function exactRetryFinalAssistant(message) {
  return message?.role === 'assistant'
    && message?.source?.kind === 'model'
    && Array.isArray(message.content)
    && message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0]?.text === RETRY_TEXT
}

function assertPinnedTitle(ctx, session) {
  const title = ctx.sessionTitle.get(session)
  if (title?.title !== TITLE_PIN || title.source.kind !== 'user') throw new Error('Packed probe user title was not pinned.')
  return title
}

async function createFreshAgent(ctx, modelId, idSuffix, setup) {
  const id = SessionId(`packed-rc1-${idSuffix}-${randomUUID()}`)
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions: { provider: PROVIDER_ID, model: modelId }, setup })
  ctx.sessionTitle.rename(handle.agent.session, TITLE_PIN)
  assertPinnedTitle(ctx, handle.agent.session)
  return handle
}

async function replaySeed(ctx, modelId, sessionId) {
  const id = SessionId(sessionId)
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions: { provider: PROVIDER_ID, model: modelId } })
  ctx.sessionTitle.rename(handle.agent.session, TITLE_PIN)
  assertPinnedTitle(ctx, handle.agent.session)
  const beforeHttp = transport.providerAttempts
  const beforeWs = transport.wsUrls.length
  handle.agent.followup(textRequest(SEED_MARKER))
  await handle.agent.whenIdle()
  const messages = handle.agent.session.deriveMessages()
  if (!jsonHasAssistantText(messages, SEED_TEXT)) throw new Error('Seed assistant message was not derived.')
  const persisted = await flushAndInspect(ctx, handle.agent.session)
  const events = handle.agent.session.events
  if (eventTypes(handle.agent.session, 'assistant/message').length !== 1) throw new Error('Seed assistant event count drifted.')
  if (eventTypes(handle.agent.session, 'request/header').length < 1) throw new Error('Seed request header was not durable.')
  await handle.dispose()
  return { sessionId: String(id), firstLiveSeq: handle.agent.session.firstLiveSeq, assistantMessages: 1, requestHeaders: eventTypes(handle.agent.session, 'request/header').length, persistedBytes: persisted.raw.content.length, eventCount: events.length, responseId: 'resp_packed_replay_seed', httpCount: transport.providerAttempts - beforeHttp, wsCount: transport.wsUrls.length - beforeWs }
}

async function replayResume(ctx, modelId, sessionId) {
  const id = SessionId(sessionId)
  const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: PROVIDER_ID, model: modelId } })
  const title = assertPinnedTitle(ctx, handle.agent.session)
  if (handle.agent.session.firstLiveSeq <= 0) throw new Error('Resume did not expose firstLiveSeq > 0.')
  const beforeHttp = transport.providerAttempts
  const beforeWs = transport.wsUrls.length
  const before = handle.agent.session.deriveMessages()
  if (!jsonHasAssistantText(before, SEED_TEXT)) throw new Error('Resume derived history lost seed assistant.')
  handle.agent.followup(textRequest(CONTINUE_MARKER))
  await handle.agent.whenIdle()
  const after = handle.agent.session.deriveMessages()
  if (!jsonHasAssistantText(after, SEED_TEXT) || !jsonHasAssistantText(after, CONTINUE_TEXT)) throw new Error('Resume durable history did not retain both assistant responses.')
  const persisted = await flushAndInspect(ctx, handle.agent.session)
  const requestEvents = eventTypes(handle.agent.session, 'request/header')
  const assistantEvents = eventTypes(handle.agent.session, 'assistant/message')
  await handle.dispose()
  return { sessionId: String(id), firstLiveSeq: handle.agent.session.firstLiveSeq, titleSource: title.source.kind, responseId: 'resp_packed_replay_continue', continuationObserved: transport.replayContinuationObserved, assistantMessages: assistantEvents.length, requestHeaders: requestEvents.length, persistedBytes: persisted.raw.content.length, durableHistoryHasSeed: jsonHasAssistantText(after, SEED_TEXT), durableHistoryHasContinuation: jsonHasAssistantText(after, CONTINUE_TEXT), httpCount: transport.providerAttempts - beforeHttp, wsCount: transport.wsUrls.length - beforeWs }
}

async function retryScenario(ctx, modelId) {
  let executions = 0
  const handle = await createFreshAgent(ctx, modelId, 'retry', (agentCtx) => {
    agentCtx.tools.register(defineTool({
      name: 'record_side_effect',
      description: 'Record one deterministic test-side effect.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { executions += 1; return args.value },
    }))
  })
  const start = transport.providerAttempts
  const startWs = transport.wsUrls.length
  handle.agent.followup(textRequest(RETRY_MARKER))
  await handle.agent.whenIdle()
  const events = orderedEvents(handle.agent.session.events)
  const retryEvents = events.filter((event) => event.type === 'llm/retry')
  const retryStartedEvents = events.filter((event) => event.type === 'llm/retry-started')
  const toolCalls = events.filter((event) => event.type === 'tool/call')
  const toolResults = events.filter((event) => event.type === 'tool/result')
  const assistantMessages = events.filter((event) => event.type === 'assistant/message')
  const persisted = await flushAndInspect(ctx, handle.agent.session)
  const rawEvents = orderedEvents(persistedEvents(persisted.raw))
  const retryEvent = retryEvents[0]
  if (retryEvent === undefined || retryEvents.length !== 1 || retryStartedEvents.length !== 1) throw new Error('Retry lifecycle event count drifted.')
  const retrySeq = Number(retryEvent.seq)
  const preRetry = events.filter((event) => Number(event.seq) < retrySeq)
  for (const type of ['assistant/message', 'tool/call', 'tool/result']) {
    if (preRetry.filter((event) => event.type === type).length !== 0) throw new Error(`Retry admitted ${type} before llm/retry.`)
  }
  const preRetryRaw = rawEvents.filter((event) => Number(event.seq) < retrySeq)
  for (const type of ['assistant/message', 'tool/call', 'tool/result']) {
    if (preRetryRaw.filter((event) => event.type === type).length !== 0) throw new Error(`Persisted retry admitted ${type} before llm/retry.`)
  }
  const derived = handle.agent.session.deriveMessages()
  const logicalDerived = derived.filter((message) => message?.source?.kind !== 'plugin')
  if (derived.filter((message) => message?.source?.kind === 'plugin').length !== 1
    || logicalDerived.length !== 4
    || !exactUserText(logicalDerived[0], RETRY_MARKER)
    || !exactRetryAssistantCall(logicalDerived[1])
    || !exactRetryToolResult(logicalDerived[2])
    || !exactRetryFinalAssistant(logicalDerived[3])) throw new Error(`Retry derived message sequence drifted: ${JSON.stringify(derived)}`)
  const acceptedAssistantCalls = assistantMessages.filter((event) => exactRetryAssistantCall(event.data?.message))
  const acceptedToolCalls = toolCalls.filter((event) => event.data?.callId === DERIVED_RETRY_CALL_ID && event.data?.name === 'record_side_effect' && event.data?.arguments === '{"value":"once"}')
  const acceptedToolResults = toolResults.filter((event) => event.data?.message?.source?.callId === DERIVED_RETRY_CALL_ID)
  const rawAssistantMessages = rawEvents.filter((event) => event.type === 'assistant/message')
  const rawToolCalls = rawEvents.filter((event) => event.type === 'tool/call')
  const rawToolResults = rawEvents.filter((event) => event.type === 'tool/result')
  const rawAcceptedAssistantCalls = rawAssistantMessages.filter((event) => exactRetryAssistantCall(event.data?.message))
  const rawAcceptedToolCalls = rawToolCalls.filter((event) => event.data?.callId === DERIVED_RETRY_CALL_ID && event.data?.name === 'record_side_effect' && event.data?.arguments === '{"value":"once"}')
  const rawAcceptedToolResults = rawToolResults.filter((event) => event.data?.message?.source?.callId === DERIVED_RETRY_CALL_ID)
  const duplicateFailedCalls = assistantMessages.filter((event) => event.data?.message?.content?.some((part) => part?.type === 'tool-call' && (part.id === 'call_retry_once' || part.id === DERIVED_RETRY_CALL_ID))).length - acceptedAssistantCalls.length
  const failedCallAdopted = preRetry.some((event) => event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
    || preRetryRaw.some((event) => event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
  const finalAssistant = assistantMessages.findLast((event) => exactRetryFinalAssistant(event.data?.message))
  const turnEnd = events.findLast((event) => event.type === 'turn/end')
  const finishKind = turnEnd?.data?.reason?.kind
  const finalAssistantText = messageText(finalAssistant?.data?.message)
  const finalResponseId = transport.retryFinalResponseId
  if (executions !== 1
    || acceptedAssistantCalls.length !== 1
    || acceptedToolCalls.length !== 1
    || acceptedToolResults.length !== 1
    || rawAcceptedAssistantCalls.length !== 1
    || rawAcceptedToolCalls.length !== 1
    || rawAcceptedToolResults.length !== 1
    || rawAssistantMessages.length !== 2
    || rawToolCalls.length !== 1
    || rawToolResults.length !== 1
    || duplicateFailedCalls !== 0
    || failedCallAdopted
    || assistantMessages.length !== 2
    || toolCalls.length !== 1
    || toolResults.length !== 1
    || transport.retryFailureFramesComplete !== true
    || transport.retryFailureCompletedSeen !== false
    || finishKind !== 'completed'
    || finalAssistantText !== RETRY_TEXT
    || finalResponseId !== 'resp_packed_retry_final') throw new Error('Retry/tool exact-once contract failed.')
  await handle.dispose()
  return { finishKind, providerAttempts: transport.providerAttempts - start, httpCount: transport.providerAttempts - start, wsCount: transport.wsUrls.length - startWs, executionCount: executions, retryCount: retryEvents.length, retryStartedCount: retryStartedEvents.length, toolCallCount: toolCalls.length, toolResultCount: toolResults.length, assistantMessageCount: assistantMessages.length, attempts: transport.retryAttempts, failedCallAdopted, failedAttemptCompleteFunctionCall: transport.retryFailureFramesComplete, failedAttemptResponseCompleted: transport.retryFailureCompletedSeen, finalAssistantText, finalResponseId, derivedMessageCount: derived.length, logicalDerivedMessageCount: logicalDerived.length, rawAssistantMessageCount: rawAssistantMessages.length, rawToolCallCount: rawToolCalls.length, rawToolResultCount: rawToolResults.length, durableBytes: persisted.raw.content.length }
}

async function directPreAborted(ctx, modelId) {
  const controller = new AbortController()
  controller.abort(new DOMException('The operation was aborted.', 'AbortError'))
  const before = transport.providerAttempts
  const beforeWs = transport.wsUrls.length
  const chunks = []
  try {
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER_ID, model: modelId, messages: [textRequest(CANCEL_PRE_MARKER)], signal: controller.signal })) chunks.push(chunk)
  } catch (error) { if (error?.name !== 'AbortError') throw error }
  const finishKind = lastFinish(chunks)?.reason?.kind ?? null
  if (finishKind !== 'aborted') throw new Error('Direct pre-aborted stream did not produce an aborted finish.')
  return { fetchCount: transport.providerAttempts - before, wsCount: transport.wsUrls.length - beforeWs, finishKind }
}

async function preDispatchCancel(ctx, modelId) {
  const handle = await createFreshAgent(ctx, modelId, 'cancel-pre')
  const beforeFetch = transport.providerAttempts
  const beforeWs = transport.wsUrls.length
  handle.agent.followup(textRequest(CANCEL_PRE_MARKER))
  handle.agent.cancel({ kind: 'user' })
  await handle.agent.whenIdle()
  const events = handle.agent.session.events
  const turnEnd = events.findLast((event) => event.type === 'turn/end')
  const result = { fetchCount: transport.providerAttempts - beforeFetch, wsCount: transport.wsUrls.length - beforeWs, retryCount: eventTypes(handle.agent.session, 'llm/retry').length, assistantMessageCount: eventTypes(handle.agent.session, 'assistant/message').length, turnEndReason: turnEnd?.data?.reason?.kind ?? null }
  await handle.dispose()
  if (result.fetchCount !== 0 || result.wsCount !== 0) throw new Error('Pre-dispatch cancellation started a provider request.')
  if (result.turnEndReason !== 'aborted' || result.retryCount !== 0 || result.assistantMessageCount !== 0) throw new Error('Pre-dispatch cancellation durable contract failed.')
  return result
}

async function midStreamCancel(ctx, modelId) {
  const handle = await createFreshAgent(ctx, modelId, 'cancel-mid')
  const seen = []
  let markChunk
  let partialChunkEvent
  const chunkSeen = new Promise((resolve) => { markChunk = resolve })
  ctx.on('session/event', (session, event) => {
    if (session.id !== handle.agent.session.id) return
    seen.push(event)
    if (event.type === 'assistant/chunk'
      && event.data?.chunk?.type === 'tool-call-delta'
      && event.data.chunk.argumentsDelta === CANCEL_MID_ARGUMENT_DELTA) {
      partialChunkEvent = event
      markChunk()
    }
  })
  const beforeFetch = transport.providerAttempts
  const beforeWs = transport.wsUrls.length
  handle.agent.followup(textRequest(CANCEL_MID_MARKER))
  await chunkSeen
  const fetchAtLatch = transport.providerAttempts
  const wsAtLatch = transport.wsUrls.length
  handle.agent.cancel({ kind: 'user' })
  await handle.agent.whenIdle()
  const fetchAfterAbort = transport.providerAttempts
  const wsAfterAbort = transport.wsUrls.length
  const persisted = await flushAndInspect(ctx, handle.agent.session)
  const sessionEvents = orderedEvents(handle.agent.session.events)
  const rawEvents = orderedEvents(persistedEvents(persisted.raw))
  const turnEnd = sessionEvents.findLast((event) => event.type === 'turn/end')
  const derived = handle.agent.session.deriveMessages()
  const logicalDerived = derived.filter((message) => message?.source?.kind !== 'plugin')
  const expectedUser = logicalDerived[0]
  const persistedCounts = Object.fromEntries(['assistant/message', 'tool/call', 'tool/result'].map((type) => [type, rawEvents.filter((event) => event.type === type).length]))
  const rawTurnEnds = rawEvents.filter((event) => event.type === 'turn/end')
  const result = { fetchCountAtLatch: fetchAtLatch - beforeFetch, fetchCountAfterAbort: fetchAfterAbort - beforeFetch, fetchCountAfterAbortDelta: fetchAfterAbort - fetchAtLatch, wsCountAtLatch: wsAtLatch - beforeWs, wsCountAfterAbort: wsAfterAbort - beforeWs, wsCountAfterAbortDelta: wsAfterAbort - wsAtLatch, retryCount: eventTypes(handle.agent.session, 'llm/retry').length, partialChunkCount: eventTypes(handle.agent.session, 'assistant/chunk').length, assistantMessageCount: eventTypes(handle.agent.session, 'assistant/message').length, toolCallCount: eventTypes(handle.agent.session, 'tool/call').length, toolResultCount: eventTypes(handle.agent.session, 'tool/result').length, turnEndReason: turnEnd?.data?.reason?.kind ?? null, persistedTurnEndCount: rawTurnEnds.length, persistedTurnEndReason: rawTurnEnds.at(-1)?.data?.reason?.kind ?? null, derivedMessageCount: derived.length, logicalDerivedMessageCount: logicalDerived.length, derivedUserContentExact: logicalDerived.length === 1 && exactUserText(expectedUser, CANCEL_MID_MARKER), rawContainsPartialChunk: rawEvents.some((event) => event.type === 'assistant/chunk' && event.data?.chunk?.type === 'tool-call-delta' && event.data.chunk.argumentsDelta === CANCEL_MID_ARGUMENT_DELTA), rawPartialArgumentDelta: rawEvents.some((event) => event.type === 'assistant/chunk' && event.data?.chunk?.type === 'tool-call-delta' && event.data.chunk.argumentsDelta === CANCEL_MID_ARGUMENT_DELTA), persistedCounts, seenEventTypes: [...new Set(seen.map((event) => event.type))].sort(), partialChunkEventSeq: partialChunkEvent?.seq ?? null }
  await handle.dispose()
  if (result.fetchCountAtLatch !== 1 || result.fetchCountAfterAbort !== 1 || result.fetchCountAfterAbortDelta !== 0 || result.wsCountAtLatch !== 1 || result.wsCountAfterAbort !== 1 || result.wsCountAfterAbortDelta !== 0 || result.retryCount !== 0 || result.partialChunkCount < 1 || result.assistantMessageCount !== 0 || result.toolCallCount !== 0 || result.toolResultCount !== 0 || result.turnEndReason !== 'aborted' || result.persistedTurnEndCount !== 1 || result.persistedTurnEndReason !== 'aborted' || result.logicalDerivedMessageCount !== 1 || result.derivedUserContentExact !== true || result.rawContainsPartialChunk !== true || result.rawPartialArgumentDelta !== true || result.persistedCounts['assistant/message'] !== 0 || result.persistedCounts['tool/call'] !== 0 || result.persistedCounts['tool/result'] !== 0 || result.partialChunkEventSeq === null) throw new Error('Mid-stream cancellation durable contract failed.')
  return result
}

async function attachmentScenario(ctx, modelId) {
  const small = Uint8Array.from(Buffer.from(ONE_PX_PNG_BASE64, 'base64'))
  const largeBytes = Array.from({ length: 5 }, (_, index) => rgbPng(1070, index + 1))
  const encoded = largeBytes.map((bytes) => bytes.toString('base64'))
  if (!largeBytes.every((bytes) => bytes.byteLength < 3.5 * 1024 * 1024)) throw new Error('Large PNG exceeded per-image limit.')
  if (!(encoded.reduce((sum, value) => sum + value.length, 0) > 20 * 1024 * 1024)) throw new Error('Large PNG set did not exceed image budget.')
  if (!(encoded.slice(1).reduce((sum, value) => sum + value.length, 0) < 20 * 1024 * 1024)) throw new Error('Surviving PNG set still exceeded image budget.')
  const refs = []
  refs.push((await ctx.attachments.saveImages([{ data: small, mediaType: 'image/png', name: 'small.png' }]))[0])
  for (let index = 0; index < largeBytes.length; index += 1) refs.push((await ctx.attachments.saveImages([{ data: largeBytes[index], mediaType: 'image/png', name: `large${index}.png` }]))[0])
  transport.expectedImages = { large: encoded }
  const handle = await createFreshAgent(ctx, modelId, 'images')
  const beforeHttp = transport.providerAttempts
  const beforeWs = transport.wsUrls.length
  handle.agent.followup(imageRequest(ATTACH_MARKER, refs))
  await handle.agent.whenIdle()
  const persisted = await flushAndInspect(ctx, handle.agent.session)
  const userEvents = eventTypes(handle.agent.session, 'user/message')
  const durableMessage = userEvents.findLast((event) => Array.isArray(event.data?.content) && event.data.content.some((part) => part.type === 'image'))?.data?.content
  const durableRefs = Array.isArray(durableMessage)
    ? durableMessage.filter((part) => part.type === 'image').map((part) => publicAttachmentRef(part.attachment))
    : []
  const expectedRefs = refs.map(publicAttachmentRef)
  const durableReferenceOrderUnchanged = durableRefs.length === expectedRefs.length
    && durableRefs.every((ref, index) => ref.attachmentId === expectedRefs[index]?.attachmentId)
  const durableReferenceShapeUnchanged = isDeepStrictEqual(durableRefs, expectedRefs)
  const result = { imageWire: { survivorCount: transport.imageWire?.survivors?.length ?? 0, offloaded: transport.imageWire?.offloaded ?? 0 }, durableReferenceCount: durableRefs.length, durableReferenceOrderUnchanged, durableReferenceShapeUnchanged, offloadedTextCount: transport.imageWire?.offloaded ?? 0, httpCount: transport.providerAttempts - beforeHttp, wsCount: transport.wsUrls.length - beforeWs, rawBytes: persisted.raw.content.length, encodedBytes: encoded.map((value) => value.length) }
  await handle.dispose()
  if (result.durableReferenceCount !== 6 || result.durableReferenceOrderUnchanged !== true || result.durableReferenceShapeUnchanged !== true || result.offloadedTextCount !== 2 || result.imageWire?.survivorCount !== 4 || result.httpCount !== 1 || result.wsCount !== 1) throw new Error('Attachment image-budget contract failed.')
  return result
}

async function runRequestsPhase(ctx, modelId) {
  if (phase === 'requests-seed') {
    const sessionId = process.env[SESSION_VARIABLE]
    if (sessionId === undefined || sessionId.length === 0) throw new Error(`${SESSION_VARIABLE} is required for seed.`)
    const replay = await replaySeed(ctx, modelId, sessionId)
    const retry = await retryScenario(ctx, modelId)
    const directCancellation = await directPreAborted(ctx, modelId)
    const preDispatchCancellation = await preDispatchCancel(ctx, modelId)
    const midStreamCancellation = await midStreamCancel(ctx, modelId)
    const images = await attachmentScenario(ctx, modelId)
    if (transport.retryAttempts.length !== 3) throw new Error(`Retry provider HTTP attempts drifted: ${transport.retryAttempts.length}`)
    if (replay.httpCount !== 1 || replay.wsCount !== 1 || retry.httpCount !== 3 || retry.wsCount !== 1 || directCancellation.fetchCount !== 0 || directCancellation.wsCount !== 0 || preDispatchCancellation.fetchCount !== 0 || preDispatchCancellation.wsCount !== 0 || midStreamCancellation.fetchCountAtLatch !== 1 || midStreamCancellation.fetchCountAfterAbort !== 1 || midStreamCancellation.fetchCountAfterAbortDelta !== 0 || midStreamCancellation.wsCountAtLatch !== 1 || midStreamCancellation.wsCountAfterAbort !== 1 || midStreamCancellation.wsCountAfterAbortDelta !== 0 || images.httpCount !== 1 || images.wsCount !== 1) throw new Error('Request scenario transport counts drifted.')
    if (transport.stickyError !== undefined || transport.wsSendCount !== 0 || transport.externalHosts.size !== 0 || transport.loopbackUrls.length !== 0) throw new Error('Request transport sticky state drifted.')
    if (transport.fetchRequests.some((request) => request.url !== CODEX_URL || request.method !== 'POST')) throw new Error('Request fetch endpoint/method drifted.')
    if (transport.wsUrls.some((url) => url !== CODEX_WS_URL)) throw new Error('Request WebSocket endpoint drifted.')
    if (transport.wsDials.some((dial) => dial.listeners.open.add !== 1 || dial.listeners.open.remove !== 1 || dial.listeners.error.add !== 1 || dial.listeners.error.remove !== 1 || dial.listeners.close.add !== 1 || dial.listeners.close.remove !== 1)) throw new Error('WebSocket listener lifecycle drifted.')
    return { handoff: { sessionId, modelId, seedReady: true }, replay, retry, cancellation: { directPreAborted: directCancellation, preDispatch: preDispatchCancellation, midStream: midStreamCancellation }, images, totals: { providerAttempts: transport.providerAttempts, retryScenarioFetchCount: retry.providerAttempts, fetchRequests: transport.fetchRequests, wsUrls: transport.wsUrls, wsDials: transport.wsDials, wsSendCount: transport.wsSendCount, externalHosts: [...transport.externalHosts].sort(), loopbackUrls: transport.loopbackUrls, stickyError: transport.stickyError } }
  }
  const sessionId = process.env[SESSION_VARIABLE]
  if (sessionId === undefined || sessionId.length === 0) throw new Error(`${SESSION_VARIABLE} is required for resume.`)
  const replay = await replayResume(ctx, modelId, sessionId)
  if (transport.providerAttempts !== 1) throw new Error(`Resume provider attempt count drifted: ${transport.providerAttempts}`)
  if (replay.httpCount !== 1 || replay.wsCount !== 1) throw new Error('Resume replay transport counts drifted.')
  if (transport.stickyError !== undefined || transport.wsSendCount !== 0 || transport.externalHosts.size !== 0 || transport.loopbackUrls.length !== 0) throw new Error('Resume transport sticky state drifted.')
  if (transport.fetchRequests.some((request) => request.url !== CODEX_URL || request.method !== 'POST')) throw new Error('Resume fetch endpoint/method drifted.')
  if (transport.wsUrls.some((url) => url !== CODEX_WS_URL)) throw new Error('Resume WebSocket endpoint drifted.')
  if (transport.wsDials.some((dial) => dial.listeners.open.add !== 1 || dial.listeners.open.remove !== 1 || dial.listeners.error.add !== 1 || dial.listeners.error.remove !== 1 || dial.listeners.close.add !== 1 || dial.listeners.close.remove !== 1)) throw new Error('Resume WebSocket listener lifecycle drifted.')
  return { handoff: { sessionId, modelId, seedReady: true }, replay, totals: { providerAttempts: transport.providerAttempts, fetchRequests: transport.fetchRequests, wsUrls: transport.wsUrls, wsDials: transport.wsDials, wsSendCount: transport.wsSendCount, externalHosts: [...transport.externalHosts].sort(), loopbackUrls: transport.loopbackUrls, stickyError: transport.stickyError } }
}

export async function apply(ctx) {
  const resultPath = process.env[RESULT_VARIABLE]
  if (resultPath === undefined || resultPath.length === 0) throw new Error(`${RESULT_VARIABLE} is required.`)
  const matchingProviders = await waitForProvider(ctx)
  const models = await ctx.llm.listModels(PROVIDER_ID)
  const modelIds = models.map(({ id }) => id)
  const firstModel = models[0]
  if (firstModel === undefined) throw new Error('The packed Codex catalog is empty.')
  const resolved = await ctx.llm.resolveModelInfo(PROVIDER_ID, firstModel.id)
  let duplicateCode
  try {
    ctx.llm.registerAdapter([PROVIDER_ID], { listModels: async () => [], providerInfo: () => ({ id: PROVIDER_ID, name: 'probe' }), resolveModel: async (_provider, model) => ({ provider: PROVIDER_ID, id: model }), stream: async function * () {} })
  } catch (error) { duplicateCode = ownErrorCode(error) }
  const currentPhase = process.env[PHASE_VARIABLE]
  let authFailureCode
  if (currentPhase !== 'requests-seed' && currentPhase !== 'requests-resume') {
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER_ID, model: firstModel.id, messages: [] })) if (chunk.type === 'finish' && chunk.reason.kind === 'error') authFailureCode = chunk.reason.failure.code
  }
  let directoryConflictCode
  let nativeCredential
  let nativeCredentialMatches = false
  let nativeCredentialMatchesForeignValues = false
  let nativeCredentialDeleted = false
  let requests
  if (currentPhase !== undefined) {
    const directoryEntry = { provider: PROVIDER_ID, displayName: PROVIDER_DISPLAY_NAME, settingsNs: 'llm-codex-sub-packed-candidate', settingsPath: [] }
    try { ctx.llm.registerConfigurableProviders([directoryEntry]); ctx.llm.registerConfigurableProviders([directoryEntry]) } catch (error) { directoryConflictCode = ownErrorCode(error) }
    if (currentPhase === 'save') {
      await ctx.credentials.modifyRecord(nativeRecordKey, async () => ({ kind: 'grant', payload: { type: 'oauth', access: process.env.CANDIDATE_ACCESS_SENTINEL, refresh: process.env.CANDIDATE_REFRESH_SENTINEL, expires: Date.now() + 3_600_000, accountId: process.env.CANDIDATE_ACCOUNT_SENTINEL } }))
      nativeCredential = await ctx.credentials.readRecord(nativeRecordKey)
      nativeCredentialMatches = nativeCredential?.payload?.access === process.env.CANDIDATE_ACCESS_SENTINEL && nativeCredential?.payload?.refresh === process.env.CANDIDATE_REFRESH_SENTINEL && nativeCredential?.payload?.accountId === process.env.CANDIDATE_ACCOUNT_SENTINEL
      nativeCredentialMatchesForeignValues = nativeCredential?.payload?.access === process.env.CANDIDATE_PACKAGE_ACCESS_SENTINEL || nativeCredential?.payload?.refresh === process.env.CANDIDATE_PACKAGE_REFRESH_SENTINEL || nativeCredential?.payload?.accountId === process.env.CANDIDATE_PACKAGE_ACCOUNT_SENTINEL
    } else if (currentPhase === 'requests-seed' || currentPhase === 'requests-resume') {
      const imageModel = models.find((model) => model.inputModalities?.includes('image'))
      if (imageModel === undefined) throw new Error('Packed Codex catalog has no image-capable model for #51.')
      requests = await runRequestsPhase(ctx, imageModel.id)
    } else {
      nativeCredential = await ctx.credentials.readRecord(nativeRecordKey)
      nativeCredentialMatches = nativeCredential?.payload?.access === process.env.CANDIDATE_ACCESS_SENTINEL && nativeCredential?.payload?.refresh === process.env.CANDIDATE_REFRESH_SENTINEL && nativeCredential?.payload?.accountId === process.env.CANDIDATE_ACCOUNT_SENTINEL
      nativeCredentialMatchesForeignValues = nativeCredential?.payload?.access === process.env.CANDIDATE_PACKAGE_ACCESS_SENTINEL || nativeCredential?.payload?.refresh === process.env.CANDIDATE_PACKAGE_REFRESH_SENTINEL || nativeCredential?.payload?.accountId === process.env.CANDIDATE_PACKAGE_ACCOUNT_SENTINEL
      if (currentPhase === 'post-logout') { await ctx.credentials.deleteRecord(nativeRecordKey); nativeCredentialDeleted = await ctx.credentials.readRecord(nativeRecordKey) === undefined }
      if (currentPhase === 'confirm-deleted') nativeCredentialDeleted = nativeCredential === undefined
    }
  }
  const routeAfterConflict = ctx.llm.listProviders().filter(({ id }) => id === PROVIDER_ID)
  const encodedResult = `${JSON.stringify({ authFailureCode, catalogIdsAreUnique: new Set(modelIds).size === modelIds.length, directoryConflictCode, duplicateCode, modelCount: models.length, nativeCredentialKind: nativeCredential?.kind, nativeCredentialType: nativeCredential?.payload?.type, networkAttempts: currentPhase === 'requests-seed' || currentPhase === 'requests-resume' ? transport.providerAttempts : globalThis[networkCounter] ?? -1, nativeCredentialMatches, nativeCredentialMatchesForeignValues, nativeCredentialDeleted, ...(currentPhase === undefined ? {} : { phase: currentPhase }), ...(requests === undefined ? {} : { requests }), providerDisplayMatches: matchingProviders[0]?.name === PROVIDER_DISPLAY_NAME, providerOccurrences: matchingProviders.length, resolvedMatches: resolved.provider === PROVIDER_ID && resolved.id === firstModel.id, routeOccurrencesAfterConflict: routeAfterConflict.length })}\n`
  const temporaryResultPath = `${resultPath}.${process.pid}.tmp`
  try { await writeFile(temporaryResultPath, encodedResult, { encoding: 'utf8', flag: 'wx' }); await rename(temporaryResultPath, resultPath) } catch (error) { await rm(temporaryResultPath, { force: true }); throw error }
}
