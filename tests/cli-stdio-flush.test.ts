import { randomUUID } from 'node:crypto'
import {
  PassThrough,
  Writable,
} from 'node:stream'

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type {
  CodexAuthService,
  CredentialVaultInspection,
} from '../src/core/contracts.js'
import type { RuntimeCompatibilityReport } from '../src/dsh/compatibility.js'
import {
  CLI_EXIT_SUCCESS,
  CLI_EXIT_USAGE,
  createProcessCliIo,
  runCli,
} from '../src/cli/main.js'
import {
  CLI_STDIO_FLUSH_DEADLINE_MS,
  createCliStdioFlushBoundary,
} from '../src/cli/stdio-flush.js'
import type {
  CliEnvironment,
  PromptReader,
} from '../src/cli/types.js'

type WriteCallback = (error?: Error | null) => void

class ControlledWritable extends Writable {
  readonly chunks: Buffer[] = []
  readonly pendingCallbacks: WriteCallback[] = []
  drainEvents = 0

  constructor() {
    super({ highWaterMark: 1 })
    this.on('drain', () => {
      this.drainEvents += 1
    })
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: WriteCallback,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    this.pendingCallbacks.push(callback)
  }

  completeNext(error?: Error): void {
    const callback = this.pendingCallbacks.shift()
    if (callback === undefined) {
      throw new Error('No controlled write is pending.')
    }
    callback(error)
  }

  completeAll(): void {
    while (this.pendingCallbacks.length > 0) {
      this.completeNext()
    }
  }

  captured(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function compatibleRuntime(): RuntimeCompatibilityReport {
  const check = (version: string) => Object.freeze({
    supported: version,
    installed: version,
    status: 'compatible' as const,
  })
  return Object.freeze({
    compatible: true,
    platform: Object.freeze({
      supported: Object.freeze(['darwin', 'linux']),
      installed: 'linux',
      status: 'compatible' as const,
    }),
    node: check('^22.19.0 || ^24.0.0 || ^26.0.0'),
    packages: Object.freeze({
      '@deepseek-ai/cordis': check('4.0.1'),
      '@deepseek-ai/dsh-attachment': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-atomic-write': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-home-paths': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-llm': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-llm-pi-ai': check('0.1.1-rc.1'),
      '@earendil-works/pi-ai': check('0.82.1'),
    }),
  })
}

function environment(): CliEnvironment {
  const unusedAuthService = {} as CodexAuthService
  const unusedPromptReader = {} as PromptReader
  const credentialStore: CredentialVaultInspection = Object.freeze({
    state: 'absent',
    permissions: 'owner-only',
  })
  return {
    packageVersion: '1.2.3-test',
    authService: unusedAuthService,
    credentialVault: {
      inspect: async () => credentialStore,
    },
    inspectRuntime: compatibleRuntime,
    catalogModelCount: () => 5,
    promptReader: unusedPromptReader,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CLI stdio flush boundary', () => {
  it('waits for a complete backpressured doctor JSON document', async () => {
    const stdout = new ControlledWritable()
    const stderr = new PassThrough()
    const boundary = createCliStdioFlushBoundary(stdout, stderr)

    const exitCode = await runCli(
      ['doctor', '--json'],
      environment(),
      createProcessCliIo(stdout, stderr),
    )
    const pendingFlush = boundary.flush()
    let settled = false
    void pendingFlush.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(stdout.writableNeedDrain).toBe(true)
    stdout.completeAll()

    await expect(pendingFlush).resolves.toBe(true)
    boundary.dispose()
    expect(exitCode).toBe(CLI_EXIT_SUCCESS)
    expect(stdout.drainEvents).toBe(1)
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stdout.listenerCount('close')).toBe(0)
    expect(stdout.listenerCount('drain')).toBe(1)
    expect(stdout.writableEnded).toBe(false)
    expect(stderr.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('close')).toBe(0)
    expect(stderr.listenerCount('drain')).toBe(0)
    expect(stderr.writableEnded).toBe(false)
    expect(stdout.chunks).toHaveLength(1)
    expect(stdout.captured().endsWith('\n')).toBe(true)
    expect(stdout.captured().trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(stdout.captured())).toMatchObject({
      schemaVersion: 1,
      package: { version: '1.2.3-test' },
      overall: 'compatible',
    })
  })

  it('waits for a complete fixed stderr failure without using stdout', async () => {
    const stdout = new PassThrough()
    const stderr = new ControlledWritable()
    const boundary = createCliStdioFlushBoundary(stdout, stderr)

    const exitCode = await runCli(
      ['not-a-command'],
      environment(),
      createProcessCliIo(stdout, stderr),
    )
    const pendingFlush = boundary.flush()
    stderr.completeAll()

    await expect(pendingFlush).resolves.toBe(true)
    boundary.dispose()
    expect(exitCode).toBe(CLI_EXIT_USAGE)
    expect(stderr.chunks).toHaveLength(1)
    expect(stderr.captured()).toBe('Invalid command-line usage. Run with --help.\n')
    expect(stdout.read()).toBeNull()
  })

  it('waits for both streams under one flush operation', async () => {
    const stdout = new ControlledWritable()
    const stderr = new ControlledWritable()
    const boundary = createCliStdioFlushBoundary(stdout, stderr)
    stdout.write('stdout pending\n')
    stderr.write('stderr pending\n')

    const pendingFlush = boundary.flush()
    let settled = false
    void pendingFlush.then(() => {
      settled = true
    })
    stdout.completeAll()
    await Promise.resolve()
    expect(settled).toBe(false)

    stderr.completeAll()
    await expect(pendingFlush).resolves.toBe(true)
    boundary.dispose()
    expect(stdout.chunks).toHaveLength(1)
    expect(stderr.chunks).toHaveLength(1)
    expect(stdout.captured()).toBe('stdout pending\n')
    expect(stderr.captured()).toBe('stderr pending\n')
  })

  it('fails at the finite shared deadline and removes temporary listeners', async () => {
    vi.useFakeTimers()
    const stdout = new ControlledWritable()
    const stderr = new ControlledWritable()
    const boundary = createCliStdioFlushBoundary(stdout, stderr)
    stdout.write('never completed')
    stderr.write('also never completed')

    const pendingFlush = boundary.flush()
    await vi.advanceTimersByTimeAsync(CLI_STDIO_FLUSH_DEADLINE_MS)

    await expect(pendingFlush).resolves.toBe(false)
    expect(stdout.chunks).toHaveLength(1)
    expect(stderr.chunks).toHaveLength(1)
    expect(stdout.listenerCount('drain')).toBe(1)
    expect(stderr.listenerCount('drain')).toBe(1)
    boundary.dispose()
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stdout.listenerCount('close')).toBe(0)
    expect(stdout.writableEnded).toBe(false)
    expect(stderr.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('close')).toBe(0)
    expect(stderr.writableEnded).toBe(false)
  })

  it('contains native stream errors and exposes no secret or local path', async () => {
    const secret = `ACCESS_SENTINEL_${randomUUID()}`
    const localPath = `/private/tmp/PATH_SENTINEL_${randomUUID()}`
    const stdout = new ControlledWritable()
    const stderr = new PassThrough()
    let capturedStderr = ''
    stderr.on('data', (chunk: Buffer) => {
      capturedStderr += chunk.toString('utf8')
    })
    const boundary = createCliStdioFlushBoundary(stdout, stderr)
    stdout.write('safe prefix')
    const pendingFlush = boundary.flush()

    stdout.completeNext(new Error(`${secret} ${localPath}`))
    await expect(pendingFlush).resolves.toBe(false)
    boundary.dispose()

    expect(stdout.chunks).toHaveLength(1)
    expect(stdout.captured()).toBe('safe prefix')
    expect(capturedStderr).toBe('')
    expect(`${stdout.captured()}\n${capturedStderr}`).not.toContain(secret)
    expect(`${stdout.captured()}\n${capturedStderr}`).not.toContain(localPath)
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stdout.listenerCount('close')).toBe(0)
    expect(stdout.writableEnded).toBe(false)
    expect(stderr.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('close')).toBe(0)
    expect(stderr.writableEnded).toBe(false)
  })
})
