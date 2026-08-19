import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  default as LlmRuntime,
  createUserMessage,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import {
  SessionId,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  interruptedTurnClosers,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
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
import { CodexDshAdapter } from '../src/dsh/adapter.js'

const MODEL_ID = 'retry-safety-fixture-model'
const ACCESS_SENTINEL = 'ACCESS_SENTINEL_retry_safety'

class AuthServiceProbe implements CodexAuthService {
  calls = 0

  async login(): Promise<void> {}

  async status(): Promise<CodexAuthStatus> {
    return { state: 'signed-out' }
  }

  async resolveRequestAuth(): Promise<CodexRequestAuth> {
    this.calls += 1
    return Object.freeze({ bearerToken: ACCESS_SENTINEL })
  }

  async logout(): Promise<void> {}
}

function profile(
  provider: Provider,
  options: { readonly retryDelayMs?: number; readonly streamIdleTimeoutMs?: number } = {},
): ResolvedPiAiProviderProfile {
  const retryDelayMs = options.retryDelayMs ?? 1
  return Object.freeze({
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 50,
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      backoff: {
        initialDelayMs: retryDelayMs,
        maxDelayMs: retryDelayMs,
        jitterRatio: 0,
      },
    }, 'test.openai-codex.retryPolicy'),
    piProvider: provider,
    configuredMaxTokens: new Map<string, number>(),
  })
}

async function collectFailures(provider: Provider) {
  const auth = new AuthServiceProbe()
  const adapter = new CodexDshAdapter({ authService: auth, profile: profile(provider) })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin({
    name: 'retry-safety-direct-adapter',
    inject: ['llm'],
    apply(pluginContext: Context) {
      pluginContext.llm.registerAdapter([PROVIDER_ID], adapter)
    },
  })

  try {
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER_ID,
      model: MODEL_ID,
      messages: [],
    })) {
      chunks.push(chunk)
    }
    return { chunks, auth }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function createAgentHarness(
  provider: Provider,
  options: {
    readonly retryDelayMs?: number
    readonly persistenceRoot?: string
    readonly resume?: boolean
    readonly sessionId?: ReturnType<typeof SessionId>
    readonly streamIdleTimeoutMs?: number
    readonly setup?: (ctx: Context) => void
  } = {},
) {
  const ctx = new Context()
  const auth = new AuthServiceProbe()
  const adapter = new CodexDshAdapter({
    authService: auth,
    profile: profile(provider, options),
  })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  if (options.persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, {
      root: options.persistenceRoot,
      compression: 'none',
      packChunks: false,
      writeBatchMaxDelayMs: 1,
    })
  }
  options.setup?.(ctx)
  await ctx.plugin({
    name: 'retry-safety-codex-adapter',
    inject: ['llm'],
    apply(pluginContext: Context) {
      pluginContext.llm.registerAdapter([PROVIDER_ID], adapter)
    },
  })
  await ctx.plugin(LlmRetry, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  const sessionId = options.sessionId ?? SessionId(`retry-safety-${crypto.randomUUID()}`)
  const agentOptions = {
    provider: PROVIDER_ID,
    model: MODEL_ID,
  }
  const handle = options.resume === true
    ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
    : await ctx.agents.create({ sessionId, agentOptions })

  return { ctx, auth, handle }
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  })
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the retry-safety fixture.')
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('DSH retry safety contracts', () => {
  it.each([
    ['429 Too Many Requests', 'RATE_LIMIT'],
    ['500 Internal Server Error', 'SERVER'],
    ['503 Service Unavailable', 'SERVER'],
    ['fetch failed: ECONNRESET', 'TRANSPORT'],
    ['provider overloaded; try again later', 'PI_AI_ERROR'],
  ] as const)('classifies %s as %s at the DSH boundary', async (message, code) => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: message }),
    ])

    const { chunks, auth } = await collectFailures(faux.provider)

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code } },
    })
    expect(auth.calls).toBe(1)
    expect(JSON.stringify(chunks)).not.toContain(ACCESS_SENTINEL)
  })

  it('retries transient failures without admitting failed output to history', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '429 Too Many Requests',
      }),
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '503 Service Unavailable',
      }),
      fauxAssistantMessage('accepted response'),
    ])
    const { ctx, auth, handle } = await createAgentHarness(faux.provider)

    try {
      handle.agent.followup(userMessage('retry this safely'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const retryEvents = events.filter((event) => event.type === 'llm/retry')
      const retryStartedEvents = events.filter((event) => event.type === 'llm/retry-started')
      const turnStarts = events.filter((event) => event.type === 'turn/start')
      const stepStarts = events.filter((event) => event.type === 'step/start')
      const messages = handle.agent.session.deriveMessages()

      expect(faux.state.callCount).toBe(3)
      expect(auth.calls).toBe(3)
      expect(retryEvents).toHaveLength(2)
      expect(retryStartedEvents).toHaveLength(2)
      expect(turnStarts).toHaveLength(1)
      expect(stepStarts).toHaveLength(1)
      expect(retryEvents.map((event) => event.data.failure.code)).toEqual([
        'RATE_LIMIT',
        'SERVER',
      ])
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ role: 'user' })
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'accepted response' }],
      })
      expect(JSON.stringify(events)).not.toContain(ACCESS_SENTINEL)
      expect(JSON.stringify(messages)).not.toContain(ACCESS_SENTINEL)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['500 Internal Server Error', 'SERVER'],
    ['fetch failed: ECONNRESET', 'TRANSPORT'],
  ] as const)('retries a pre-output %s failure once', async (errorMessage, code) => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage }),
      fauxAssistantMessage('accepted after retry'),
    ])
    const { ctx, handle } = await createAgentHarness(faux.provider)

    try {
      handle.agent.followup(userMessage('retry one transient failure'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const retry = events.find((event) => event.type === 'llm/retry')
      expect(faux.state.callCount).toBe(2)
      expect(retry).toMatchObject({
        type: 'llm/retry',
        data: { retry: 1, failure: { code } },
      })
      expect(JSON.stringify(handle.agent.session.deriveMessages())).toContain('accepted after retry')
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('bounds an unclassified overload without retrying it', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'provider overloaded; try again later',
      }),
      fauxAssistantMessage('must remain unused'),
    ])
    const { ctx, auth, handle } = await createAgentHarness(faux.provider)

    try {
      handle.agent.followup(userMessage('do not retry an unknown failure'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const turnEnd = events.findLast((event) => event.type === 'turn/end')
      expect(faux.state.callCount).toBe(1)
      expect(auth.calls).toBe(1)
      expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(0)
      expect(turnEnd).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR' } } },
      })
      expect(JSON.stringify(events)).not.toContain(ACCESS_SENTINEL)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('stops after the configured transient retry budget is exhausted', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: '429 Too Many Requests',
    })))
    const { ctx, auth, handle } = await createAgentHarness(faux.provider)

    try {
      handle.agent.followup(userMessage('exhaust the bounded retries'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const turnEnd = events.findLast((event) => event.type === 'turn/end')
      expect(faux.state.callCount).toBe(3)
      expect(auth.calls).toBe(3)
      expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(2)
      expect(events.filter((event) => event.type === 'llm/retry-started')).toHaveLength(2)
      expect(turnEnd).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } },
      })
      expect(handle.agent.session.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(events)).not.toContain(ACCESS_SENTINEL)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('cancels a scheduled backoff before another provider attempt starts', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '503 Service Unavailable',
      }),
      fauxAssistantMessage('must remain unused'),
    ])
    const { ctx, handle } = await createAgentHarness(faux.provider, {
      retryDelayMs: 1_000,
    })

    try {
      handle.agent.followup(userMessage('cancel during retry backoff'))
      await waitFor(() => handle.agent.session.events.some((event) => event.type === 'llm/retry'))
      handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const turnEnd = events.findLast((event) => event.type === 'turn/end')
      expect(faux.state.callCount).toBe(1)
      expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'llm/retry-started')).toHaveLength(0)
      expect(turnEnd).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retries a stalled stream only to the timeout budget', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const source = faux.provider
    let streamCalls = 0
    const stalledStream = (signal?: AbortSignal) => {
      streamCalls += 1
      const events = createAssistantMessageEventStream()
      const abort = (): void => {
        events.push({
          type: 'error',
          reason: 'aborted',
          error: fauxAssistantMessage('', {
            stopReason: 'aborted',
            errorMessage: 'provider request aborted',
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
    const provider: Provider = {
      id: source.id,
      name: source.name,
      auth: source.auth,
      getModels: source.getModels.bind(source),
      stream: (_model, _context, options) => stalledStream(options?.signal),
      streamSimple: (_model, _context, options) => stalledStream(options?.signal),
    }
    const { ctx, handle } = await createAgentHarness(provider, {
      streamIdleTimeoutMs: 5,
    })

    try {
      handle.agent.followup(userMessage('bound stalled requests'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const turnEnd = events.findLast((event) => event.type === 'turn/end')
      expect(streamCalls).toBe(3)
      expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(2)
      expect(turnEnd).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'TIMEOUT' } } },
      })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('treats user cancellation during a provider stream as terminal and non-retryable', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const source = faux.provider
    let streamCalls = 0
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const cancellableStream = (signal?: AbortSignal) => {
      streamCalls += 1
      const events = createAssistantMessageEventStream()
      markEntered?.()
      const abort = (): void => {
        events.push({
          type: 'error',
          reason: 'aborted',
          error: fauxAssistantMessage('', {
            stopReason: 'aborted',
            errorMessage: 'provider request aborted',
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
    const provider: Provider = {
      id: source.id,
      name: source.name,
      auth: source.auth,
      getModels: source.getModels.bind(source),
      stream: (_model, _context, options) => cancellableStream(options?.signal),
      streamSimple: (_model, _context, options) => cancellableStream(options?.signal),
    }
    const { ctx, handle } = await createAgentHarness(provider, {
      streamIdleTimeoutMs: 1_000,
    })

    try {
      handle.agent.followup(userMessage('cancel the active stream'))
      await entered
      handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const turnEnd = events.findLast((event) => event.type === 'turn/end')
      expect(streamCalls).toBe(1)
      expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(0)
      expect(turnEnd).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('executes a tool exactly once when a failed attempt emitted the same complete call', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const toolCall = {
      type: 'toolCall' as const,
      id: 'retry-safe-tool-call',
      name: 'record_side_effect',
      arguments: { value: 'once' },
    }
    faux.setResponses([
      fauxAssistantMessage(toolCall, {
        stopReason: 'error',
        errorMessage: '503 Service Unavailable',
      }),
      fauxAssistantMessage(toolCall, { stopReason: 'toolUse' }),
      fauxAssistantMessage('tool result accepted'),
    ])
    let executions = 0
    const { ctx, handle } = await createAgentHarness(faux.provider, {
      setup(pluginContext) {
        pluginContext.tools.register(defineTool({
          name: 'record_side_effect',
          description: 'Record one deterministic test-side effect.',
          parameters: {
            value: { type: 'string', required: true },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args) {
            executions += 1
            return args.value
          },
        }))
      },
    })

    try {
      handle.agent.followup(userMessage('execute the accepted tool call once'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      expect(faux.state.callCount).toBe(3)
      expect(executions).toBe(1)
      expect(events.filter((event) => event.type === 'tool/call')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'tool/result')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'assistant/message')).toHaveLength(2)
      expect(JSON.stringify(handle.agent.session.deriveMessages())).not.toContain(ACCESS_SENTINEL)

      const toolCallIndex = events.findIndex((event) => event.type === 'tool/call')
      expect(toolCallIndex).toBeGreaterThan(0)
      const beforeToolStart = interruptedTurnClosers(events.slice(0, toolCallIndex))
      const afterToolStart = interruptedTurnClosers(events.slice(0, toolCallIndex + 1))
      expect(beforeToolStart).toContainEqual(expect.objectContaining({
        type: 'tool/result',
        data: expect.objectContaining({
          error: expect.objectContaining({ code: TOOL_NOT_STARTED }),
        }),
      }))
      expect(afterToolStart).toContainEqual(expect.objectContaining({
        type: 'tool/result',
        data: expect.objectContaining({
          error: expect.objectContaining({ code: TOOL_OUTCOME_UNKNOWN }),
        }),
      }))
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('resumes durable history after restart without re-executing an accepted tool call', async () => {
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-retry-resume-'))
    const sessionId = SessionId(`retry-safety-resume-${crypto.randomUUID()}`)
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const acceptedToolCall = fauxToolCall('record_side_effect', { value: 'once' }, {
      id: 'durable-tool-call',
    })
    faux.setResponses([
      fauxAssistantMessage(acceptedToolCall, { stopReason: 'toolUse' }),
      fauxAssistantMessage('first turn complete'),
    ])
    let executions = 0
    let replayedToolResults = 0
    const registerTool = (pluginContext: Context): void => {
      pluginContext.tools.register(defineTool({
        name: 'record_side_effect',
        description: 'Record one deterministic test-side effect.',
        parameters: {
          value: { type: 'string', required: true },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          executions += 1
          return args.value
        },
      }))
    }

    try {
      const first = await createAgentHarness(faux.provider, {
        persistenceRoot,
        sessionId,
        setup: registerTool,
      })
      try {
        first.handle.agent.followup(userMessage('execute and persist the tool call'))
        await first.handle.agent.whenIdle()
        await first.ctx.sessions.flush(first.handle.agent.session)
        const raw = await first.ctx.sessionPersistence.readRaw(sessionId)
        expect(executions).toBe(1)
        expect(first.handle.agent.session.events.filter(
          (event) => event.type === 'tool/result',
        )).toHaveLength(1)
        expect(raw?.content).not.toContain(ACCESS_SENTINEL)
      } finally {
        await first.handle.dispose()
        await first.ctx.fiber.dispose()
      }

      faux.appendResponses([
        (context) => {
          replayedToolResults = context.messages.filter(
            (message) => message.role === 'toolResult',
          ).length
          return fauxAssistantMessage('resumed turn complete')
        },
      ])
      const resumed = await createAgentHarness(faux.provider, {
        persistenceRoot,
        resume: true,
        sessionId,
        setup: registerTool,
      })
      try {
        resumed.handle.agent.followup(userMessage('continue after restart'))
        await resumed.handle.agent.whenIdle()
        await resumed.ctx.sessions.flush(resumed.handle.agent.session)

        const events = resumed.handle.agent.session.events
        const raw = await resumed.ctx.sessionPersistence.readRaw(sessionId)
        expect(faux.state.callCount).toBe(3)
        expect(executions).toBe(1)
        expect(replayedToolResults).toBe(1)
        expect(events.filter((event) => event.type === 'tool/call')).toHaveLength(1)
        expect(events.filter((event) => event.type === 'tool/result')).toHaveLength(1)
        expect(JSON.stringify(events)).not.toContain(ACCESS_SENTINEL)
        expect(raw?.content).not.toContain(ACCESS_SENTINEL)
      } finally {
        await resumed.handle.dispose()
        await resumed.ctx.fiber.dispose()
      }
    } finally {
      await rm(persistenceRoot, { recursive: true, force: true })
    }
  })

  it('does not admit partial reasoning, text, or tool output from a failed stream', async () => {
    const faux = fauxProvider({ provider: PROVIDER_ID, models: [{ id: MODEL_ID }] })
    const source = faux.provider
    let streamCalls = 0
    const stream: Provider['stream'] = (model, context, options) => {
      streamCalls += 1
      if (streamCalls > 1) {
        return source.stream(model, context, options)
      }
      const events = createAssistantMessageEventStream()
      const partial = fauxAssistantMessage([
        fauxThinking('partial reasoning'),
        fauxText('partial text'),
        fauxToolCall('record_side_effect', { value: 'partial tool' }, {
          id: 'partial-tool-call',
        }),
      ], {
        stopReason: 'error',
        errorMessage: 'fetch failed: ECONNRESET',
      })
      queueMicrotask(() => {
        events.push({ type: 'start', partial })
        events.push({ type: 'thinking_start', contentIndex: 0, partial })
        events.push({
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'discarded reasoning',
          partial,
        })
        events.push({ type: 'text_start', contentIndex: 1, partial })
        events.push({
          type: 'text_delta',
          contentIndex: 1,
          delta: 'discarded text',
          partial,
        })
        events.push({ type: 'toolcall_start', contentIndex: 2, partial })
        events.push({
          type: 'toolcall_delta',
          contentIndex: 2,
          delta: '{"value":"discarded tool',
          partial,
        })
        events.push({
          type: 'error',
          reason: 'error',
          error: partial,
        })
      })
      return events
    }
    const provider: Provider = {
      id: source.id,
      name: source.name,
      auth: source.auth,
      getModels: source.getModels.bind(source),
      stream,
      streamSimple: stream,
    }
    faux.setResponses([fauxAssistantMessage('retry accepted')])
    const { ctx, handle } = await createAgentHarness(provider)

    try {
      handle.agent.followup(userMessage('discard partial output'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const derived = handle.agent.session.deriveMessages()
      expect(streamCalls).toBe(2)
      expect(events.some((event) => event.type === 'assistant/chunk')).toBe(true)
      expect(JSON.stringify(events)).toContain('discarded reasoning')
      expect(JSON.stringify(events)).toContain('discarded text')
      expect(JSON.stringify(events)).toContain('discarded tool')
      expect(JSON.stringify(derived)).not.toContain('discarded reasoning')
      expect(JSON.stringify(derived)).not.toContain('discarded text')
      expect(JSON.stringify(derived)).not.toContain('discarded tool')
      expect(JSON.stringify(derived)).toContain('retry accepted')
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })
})
