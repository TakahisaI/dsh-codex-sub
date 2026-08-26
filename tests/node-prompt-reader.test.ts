import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { NodePromptReader } from '../src/cli/node-prompt-reader.js'

function streams(): {
  readonly input: PassThrough
  readonly output: PassThrough
  readonly capturedOutput: () => string
} {
  const input = new PassThrough()
  const output = new PassThrough()
  let captured = ''
  output.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8')
  })
  return { input, output, capturedOutput: () => captured }
}

type InstrumentedInput = PassThrough & {
  isTTY: boolean
  isRaw: boolean
  setRawMode: (mode: boolean) => void
  rawModeCalls: boolean[]
  resumeCalls: number
  pauseCalls: number
}

function ttyStreams(): ReturnType<typeof streams> & { readonly input: InstrumentedInput } {
  const terminal = streams()
  const input = terminal.input as InstrumentedInput
  input.isTTY = true
  input.isRaw = false
  input.rawModeCalls = []
  input.resumeCalls = 0
  input.pauseCalls = 0
  input.setRawMode = (mode: boolean): void => {
    input.rawModeCalls.push(mode)
    input.isRaw = mode
  }
  const originalResume = input.resume.bind(input)
  input.resume = (() => {
    input.resumeCalls += 1
    return originalResume()
  }) as InstrumentedInput['resume']
  const originalPause = input.pause.bind(input)
  input.pause = (() => {
    input.pauseCalls += 1
    return originalPause()
  }) as InstrumentedInput['pause']
  return { ...terminal, input }
}

class ThrowingNewlineOutput extends EventEmitter {
  write(chunk: string | Buffer): boolean {
    if (chunk.toString() === '\n') {
      throw new Error('newline output sentinel')
    }
    return true
  }
}

class ThrowingPromptOutput extends EventEmitter {
  write(chunk: string | Buffer): boolean {
    if (chunk.toString() === 'Secret: ') {
      throw new Error('prompt output sentinel')
    }
    return true
  }
}

class DeferredWritable extends Writable {
  readonly callbacks: Array<(error?: Error | null) => void> = []
  readonly chunks: string[] = []

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString('utf8'))
    this.callbacks.push(callback)
  }

  complete(error?: Error): void {
    const callback = this.callbacks.shift()
    if (callback === undefined) {
      throw new Error('no deferred write callback')
    }
    callback(error)
  }

  lifecycleListeners(): { readonly error: number; readonly close: number; readonly finish: number } {
    return {
      error: this.listenerCount('error'),
      close: this.listenerCount('close'),
      finish: this.listenerCount('finish'),
    }
  }
}

class DelayedFailureWritable extends Writable {
  readonly chunks: string[] = []

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString('utf8'))
    setTimeout(() => callback(new Error('delayed output failure sentinel')), 5_001)
  }
}

class SlowDestroyWritable extends DeferredWritable {
  destroyCallback: ((error?: Error | null) => void) | undefined

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void error
    this.destroyCallback = callback
  }
}

async function runOutputErrorFixture(mode: 'prompt' | 'newline'): Promise<{
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}> {
  const fixturePath = join(process.cwd(), 'tests/fixtures/node-prompt-reader-output-parent.mjs')
  const loaderPath = join(process.cwd(), 'tests/fixtures/resolve-ts-js-loader.mjs')
  const child = nodeSpawn(process.execPath, [
    '--experimental-strip-types',
    '--loader',
    loaderPath,
    fixturePath,
    mode,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`output fixture timed out (${mode})`))
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

describe('NodePromptReader', () => {
  it('reads hidden input without writing the answer to the output stream', async () => {
    const sentinel = `CODE_SENTINEL_${randomUUID()}`
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)

    const pending = reader.read('Authorization code: ', { hidden: true })
    terminal.input.end(`${sentinel}\n`)

    await expect(pending).resolves.toBe(sentinel)
    expect(terminal.capturedOutput()).toBe('Authorization code: \n')
    expect(terminal.capturedOutput()).not.toContain(sentinel)
  })

  it('settles a pending hidden prompt when the reader is closed', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)

    const pending = reader.read('Secret: ', { hidden: true })
    reader.close()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminal.capturedOutput()).toBe('Secret: \n')
  })

  it('honors an already-aborted prompt signal without starting input', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const controller = new AbortController()
    controller.abort()

    await expect(reader.read('Secret: ', {
      hidden: true,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminal.capturedOutput()).toBe('')
  })

  it('treats Ctrl-D and stream EOF as input failures', async () => {
    const ctrlD = streams()
    const reader = new NodePromptReader(ctrlD.input, ctrlD.output)
    const ctrlDPending = reader.read('Code: ', { hidden: true })
    ctrlD.input.write('\u0004')
    await expect(ctrlDPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })

    const eof = streams()
    const eofReader = new NodePromptReader(eof.input, eof.output)
    const eofPending = eofReader.read('Code: ', { hidden: true })
    eof.input.end()
    await expect(eofPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
  })

  it('fails a pre-ended hidden input before prompt or terminal side effects', async () => {
    const terminal = ttyStreams()
    terminal.input.on('data', () => undefined)
    terminal.input.end()
    await new Promise<void>((resolve) => terminal.input.once('end', resolve))
    terminal.input.removeAllListeners('data')
    const baseline = {
      raw: [...terminal.input.rawModeCalls],
      resume: terminal.input.resumeCalls,
      pause: terminal.input.pauseCalls,
    }
    const reader = new NodePromptReader(terminal.input, terminal.output)

    await expect(reader.read('Secret: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.capturedOutput()).toBe('')
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
    expect(terminal.input.rawModeCalls).toEqual(baseline.raw)
    expect(terminal.input.resumeCalls).toBe(baseline.resume)
    expect(terminal.input.pauseCalls).toBe(baseline.pause)
  })

  it('maps an EOF arriving immediately after hidden listeners attach', async () => {
    const terminal = ttyStreams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const pending = reader.read('Secret: ', { hidden: true })
    terminal.input.end()

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
    expect(terminal.input.rawModeCalls).toEqual([true, false])
  })

  it('maps a hidden close event to EOF and rolls back terminal side effects', async () => {
    const terminal = ttyStreams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const pending = reader.read('Secret: ', { hidden: true })
    terminal.input.emit('close')

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.capturedOutput()).toBe('Secret: \n')
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
    expect(terminal.input.rawModeCalls).toEqual([true, false])
  })

  it('does not start a hidden prompt after visible input has ended', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const visible = reader.read('Visible: ', { hidden: false })
    terminal.input.end('answer\n')
    await expect(visible).resolves.toBe('answer')
    await new Promise<void>((resolve) => terminal.input.once('end', resolve))

    await expect(reader.read('Hidden: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.capturedOutput()).toBe('Visible: ')
  })

  it('fails the next hidden prompt after an end between prompts', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const first = reader.read('First: ', { hidden: true })
    terminal.input.write('first\n')
    await expect(first).resolves.toBe('first')
    terminal.input.end()
    await new Promise<void>((resolve) => terminal.input.once('end', resolve))

    await expect(reader.read('Second: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.capturedOutput()).toBe('First: \n')
  })

  it('treats destroyed and unreadable hidden inputs as clean EOF', async () => {
    const destroyed = streams()
    destroyed.input.destroy()
    const destroyedReader = new NodePromptReader(destroyed.input, destroyed.output)
    await expect(destroyedReader.read('Secret: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(destroyed.capturedOutput()).toBe('')

    const unreadable = streams()
    Object.defineProperty(unreadable.input, 'readable', { value: false, configurable: true })
    const unreadableReader = new NodePromptReader(unreadable.input, unreadable.output)
    await expect(unreadableReader.read('Secret: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(unreadable.capturedOutput()).toBe('')
    expect(destroyed.input.listenerCount('close')).toBe(0)
    expect(unreadable.input.listenerCount('close')).toBe(0)
  })

  it('fails a visible pre-destroyed or unreadable input before prompt side effects', async () => {
    const destroyed = ttyStreams()
    destroyed.input.destroy()
    const destroyedReader = new NodePromptReader(destroyed.input, destroyed.output)
    await expect(destroyedReader.read('Name: ', { hidden: false })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(destroyed.capturedOutput()).toBe('')
    expect(destroyed.input.rawModeCalls).toEqual([])
    expect(destroyed.input.resumeCalls).toBe(0)
    expect(destroyed.input.listenerCount('close')).toBe(0)

    const unreadable = ttyStreams()
    Object.defineProperty(unreadable.input, 'readable', { value: false, configurable: true })
    const unreadableReader = new NodePromptReader(unreadable.input, unreadable.output)
    await expect(unreadableReader.read('Name: ', { hidden: false })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(unreadable.capturedOutput()).toBe('')
    expect(unreadable.input.rawModeCalls).toEqual([])
    expect(unreadable.input.resumeCalls).toBe(0)
    expect(unreadable.input.listenerCount('close')).toBe(0)
  })

  it('maps a pending visible close to EOF and removes the close listener', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const pending = reader.read('Name: ', { hidden: false })
    terminal.input.emit('close')

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('maps pending visible and hidden destruction to EOF', async () => {
    const visible = streams()
    const visibleReader = new NodePromptReader(visible.input, visible.output)
    const visiblePending = visibleReader.read('Name: ', { hidden: false })
    visible.input.destroy()
    await expect(visiblePending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(visible.input.listenerCount('close')).toBe(0)

    const hidden = streams()
    const hiddenReader = new NodePromptReader(hidden.input, hidden.output)
    const hiddenPending = hiddenReader.read('Secret: ', { hidden: true })
    hidden.input.destroy()
    await expect(hiddenPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(hidden.input.listenerCount('close')).toBe(0)
  })

  it('preserves a complete visible line when close follows its terminator', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const pending = reader.read('Name: ', { hidden: false })
    terminal.input.write('complete\n')
    terminal.input.emit('close')

    await expect(pending).resolves.toBe('complete')
  })

  it('keeps external cancellation and EOF as the first hidden cause', async () => {
    const external = streams()
    const externalController = new AbortController()
    const externalReader = new NodePromptReader(external.input, external.output)
    const externalPending = externalReader.read('Secret: ', {
      hidden: true,
      signal: externalController.signal,
    })
    externalController.abort()
    external.input.end()
    await expect(externalPending).rejects.toMatchObject({ name: 'AbortError' })

    const eof = streams()
    const eofController = new AbortController()
    const eofReader = new NodePromptReader(eof.input, eof.output)
    const eofPending = eofReader.read('Secret: ', {
      hidden: true,
      signal: eofController.signal,
    })
    eof.input.end()
    await expect(eofPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    eofController.abort()
  })

  it('restores only hidden terminal side effects that actually occurred', async () => {
    const terminal = ttyStreams()
    terminal.input.pause()
    const baselinePause = terminal.input.pauseCalls
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const pending = reader.read('Secret: ', { hidden: true })
    terminal.input.end('secret\n')

    await expect(pending).resolves.toBe('secret')
    expect(terminal.input.rawModeCalls).toEqual([true, false])
    expect(terminal.input.resumeCalls).toBe(1)
    expect(terminal.input.pauseCalls).toBe(baselinePause + 1)
    expect(terminal.capturedOutput()).toBe('Secret: \n')
  })

  it('keeps the hidden answer when raw restore or pause cleanup throws', async () => {
    const rawFailure = ttyStreams()
    const originalSetRawMode = rawFailure.input.setRawMode
    rawFailure.input.setRawMode = (mode: boolean): void => {
      if (!mode) {
        rawFailure.input.isRaw = false
        throw new Error('raw restore sentinel')
      }
      originalSetRawMode(mode)
    }
    const rawReader = new NodePromptReader(rawFailure.input, rawFailure.output)
    const rawPending = rawReader.read('Secret: ', { hidden: true })
    rawFailure.input.write('answer\n')
    await expect(rawPending).resolves.toBe('answer')
    expect(rawFailure.input.listenerCount('data')).toBe(0)
    expect(rawFailure.input.listenerCount('end')).toBe(0)
    expect(rawFailure.input.listenerCount('error')).toBe(0)
    expect(rawFailure.input.listenerCount('close')).toBe(0)

    const pauseFailure = ttyStreams()
    pauseFailure.input.pause()
    const originalPauseCalls = pauseFailure.input.pauseCalls
    pauseFailure.input.pause = (() => {
      pauseFailure.input.pauseCalls += 1
      throw new Error('pause cleanup sentinel')
    }) as InstrumentedInput['pause']
    const pauseReader = new NodePromptReader(pauseFailure.input, pauseFailure.output)
    const pausePending = pauseReader.read('Secret: ', { hidden: true })
    pauseFailure.input.write('answer\n')
    await expect(pausePending).resolves.toBe('answer')
    expect(pauseFailure.input.pauseCalls).toBe(originalPauseCalls + 1)
    expect(pauseFailure.input.listenerCount('error')).toBe(0)
    expect(pauseFailure.input.listenerCount('close')).toBe(0)
  })

  it('settles and cleans up when the initial prompt write throws', async () => {
    const terminal = ttyStreams()
    const output = new ThrowingPromptOutput()
    const reader = new NodePromptReader(terminal.input, output as unknown as PassThrough)

    await expect(reader.read('Secret: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
    expect(terminal.input.rawModeCalls).toEqual([])
  })

  it('settles and restores terminal state when raw enable throws and emits error', async () => {
    const terminal = ttyStreams()
    terminal.input.setRawMode = (mode: boolean): void => {
      terminal.input.rawModeCalls.push(mode)
      if (mode) {
        terminal.input.isRaw = true
        terminal.input.emit('error', new Error('raw enable sentinel'))
        throw new Error('raw enable throw sentinel')
      }
      terminal.input.isRaw = false
    }
    const reader = new NodePromptReader(terminal.input, terminal.output)

    await expect(reader.read('Secret: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
    expect(terminal.input.rawModeCalls).toEqual([true, false])
    expect(terminal.input.isRaw).toBe(false)
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('settles and cleans up when resume throws and pause rollback also throws', async () => {
    const terminal = ttyStreams()
    terminal.input.pause()
    const originalResume = terminal.input.resume.bind(terminal.input)
    terminal.input.resume = (() => {
      originalResume()
      throw new Error('resume sentinel')
    }) as InstrumentedInput['resume']
    terminal.input.pause = (() => {
      terminal.input.pauseCalls += 1
      throw new Error('pause rollback sentinel')
    }) as InstrumentedInput['pause']
    const reader = new NodePromptReader(terminal.input, terminal.output)

    await expect(reader.read('Secret: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('preserves EOF while every hidden cleanup side effect fails', async () => {
    const terminal = ttyStreams()
    terminal.input.pause()
    const originalSetRawMode = terminal.input.setRawMode
    terminal.input.setRawMode = (mode: boolean): void => {
      terminal.input.rawModeCalls.push(mode)
      if (!mode) {
        terminal.input.emit('error', new Error('raw restore EOF sentinel'))
        throw new Error('raw restore EOF throw sentinel')
      }
      originalSetRawMode(mode)
    }
    terminal.input.pause = (() => {
      terminal.input.pauseCalls += 1
      throw new Error('pause EOF throw sentinel')
    }) as InstrumentedInput['pause']
    const output = new ThrowingNewlineOutput()
    const reader = new NodePromptReader(terminal.input, output as unknown as PassThrough)
    const pending = reader.read('Secret: ', { hidden: true })
    terminal.input.end()

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('preserves a successful answer while every hidden cleanup side effect fails', async () => {
    const terminal = ttyStreams()
    terminal.input.pause()
    terminal.input.setRawMode = (mode: boolean): void => {
      terminal.input.rawModeCalls.push(mode)
      if (!mode) {
        terminal.input.emit('error', new Error('raw restore success sentinel'))
        throw new Error('raw restore success throw sentinel')
      }
      terminal.input.isRaw = true
    }
    terminal.input.pause = (() => {
      terminal.input.pauseCalls += 1
      throw new Error('pause success throw sentinel')
    }) as InstrumentedInput['pause']
    const output = new ThrowingNewlineOutput()
    const reader = new NodePromptReader(terminal.input, output as unknown as PassThrough)
    const pending = reader.read('Secret: ', { hidden: true })
    terminal.input.write('answer\n')

    await expect(pending).resolves.toBe('answer')
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('preserves caller abort while every hidden cleanup side effect fails', async () => {
    const terminal = ttyStreams()
    terminal.input.pause()
    const originalSetRawMode = terminal.input.setRawMode
    terminal.input.setRawMode = (mode: boolean): void => {
      terminal.input.rawModeCalls.push(mode)
      if (!mode) {
        terminal.input.emit('error', new Error('raw restore abort sentinel'))
        throw new Error('raw restore abort throw sentinel')
      }
      originalSetRawMode(mode)
    }
    terminal.input.pause = (() => {
      terminal.input.pauseCalls += 1
      throw new Error('pause abort throw sentinel')
    }) as InstrumentedInput['pause']
    const output = new ThrowingNewlineOutput()
    const reader = new NodePromptReader(terminal.input, output as unknown as PassThrough)
    const controller = new AbortController()
    const pending = reader.read('Secret: ', {
      hidden: true,
      signal: controller.signal,
    })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('drains synchronous raw-restore errors and preserves EOF/abort causes', async () => {
    const eof = ttyStreams()
    const originalSetRawMode = eof.input.setRawMode
    eof.input.setRawMode = (mode: boolean): void => {
      if (!mode) {
        eof.input.emit('error', new Error('raw EOF sentinel'))
        throw new Error('raw EOF restore sentinel')
      }
      originalSetRawMode(mode)
    }
    const eofReader = new NodePromptReader(eof.input, eof.output)
    const eofPending = eofReader.read('Secret: ', { hidden: true })
    eof.input.end()
    await expect(eofPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(eof.input.listenerCount('error')).toBe(0)
    expect(eof.input.listenerCount('close')).toBe(0)

    const abort = ttyStreams()
    const originalAbortSetRawMode = abort.input.setRawMode
    abort.input.setRawMode = (mode: boolean): void => {
      if (!mode) {
        abort.input.emit('error', new Error('raw abort sentinel'))
        throw new Error('raw abort restore sentinel')
      }
      originalAbortSetRawMode(mode)
    }
    const abortReader = new NodePromptReader(abort.input, abort.output)
    const controller = new AbortController()
    const abortPending = abortReader.read('Secret: ', {
      hidden: true,
      signal: controller.signal,
    })
    controller.abort()
    await expect(abortPending).rejects.toMatchObject({ name: 'AbortError' })
    expect(abort.input.listenerCount('error')).toBe(0)
    expect(abort.input.listenerCount('close')).toBe(0)
  })

  it('keeps the hidden result when final newline output throws', async () => {
    const terminal = ttyStreams()
    const output = new ThrowingNewlineOutput()
    const reader = new NodePromptReader(terminal.input, output as unknown as PassThrough)
    const pending = reader.read('Secret: ', { hidden: true })
    terminal.input.write('answer\n')

    await expect(pending).resolves.toBe('answer')
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.input.listenerCount('end')).toBe(0)
    expect(terminal.input.listenerCount('error')).toBe(0)
    expect(terminal.input.listenerCount('close')).toBe(0)
  })

  it('drains a write callback error after the old five-second window without timers in the reader', async () => {
    vi.useFakeTimers()
    try {
      const terminal = ttyStreams()
      const output = new DelayedFailureWritable()
      const reader = new NodePromptReader(terminal.input, output)
      const pending = reader.read('Secret: ', { hidden: true })
      const result = expect(pending).rejects.toMatchObject({
        code: 'CODEX_AUTH_LOGIN_FAILED',
        safeDetails: { reason: 'prompt_input' },
      })

      expect(output.listenerCount('error')).toBe(0)
      await vi.advanceTimersByTimeAsync(5_001)

      await result
      expect(output.listenerCount('error')).toBe(0)
      expect(output.listenerCount('close')).toBe(0)
      expect(output.listenerCount('finish')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not attach output lifecycle listeners while a write callback is pending', async () => {
    const terminal = ttyStreams()
    const output = new DeferredWritable()
    const outputErrorListener = (): void => undefined
    const outputCloseListener = (): void => undefined
    const outputFinishListener = (): void => undefined
    output.on('error', outputErrorListener)
    output.on('close', outputCloseListener)
    output.on('finish', outputFinishListener)
    const baseline = output.lifecycleListeners()
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })

    expect(output.lifecycleListeners()).toEqual(baseline)
    output.complete()
    terminal.input.write('answer\n')
    await expect(pending).resolves.toBe('answer')
    output.complete()
    expect(output.lifecycleListeners()).toEqual(baseline)
    output.removeListener('error', outputErrorListener)
    output.removeListener('close', outputCloseListener)
    output.removeListener('finish', outputFinishListener)
  })

  it('attaches one shared sink for a delayed prompt error and removes it after lifecycle close', async () => {
    const terminal = ttyStreams()
    const output = new DeferredWritable()
    const outputErrorListener = (): void => undefined
    const outputCloseListener = (): void => undefined
    const outputFinishListener = (): void => undefined
    output.on('error', outputErrorListener)
    output.on('close', outputCloseListener)
    output.on('finish', outputFinishListener)
    const baseline = output.lifecycleListeners()
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })

    output.complete(new Error('prompt delayed failure sentinel'))
    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
    expect(output.listenerCount('error')).toBe(baseline.error + 1)
    expect(output.listenerCount('close')).toBe(baseline.close + 1)
    expect(output.listenerCount('finish')).toBe(baseline.finish + 1)

    output.destroy()
    await new Promise<void>((resolve) => output.once('close', resolve))
    expect(output.lifecycleListeners()).toEqual(baseline)
    output.removeListener('error', outputErrorListener)
    output.removeListener('close', outputCloseListener)
    output.removeListener('finish', outputFinishListener)
  })

  it('preserves a settled answer when its prompt write reports a later error', async () => {
    const terminal = ttyStreams()
    const output = new DeferredWritable()
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })

    terminal.input.write('answer\n')
    await expect(pending).resolves.toBe('answer')
    expect(output.chunks).toEqual(['Secret: '])
    output.complete(new Error('late prompt failure sentinel'))

    await new Promise<void>((resolve) => output.once('close', resolve))
    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount('close')).toBe(0)
    expect(output.listenerCount('finish')).toBe(0)
  })

  it('preserves the answer when the final newline write reports an error', async () => {
    const terminal = ttyStreams()
    const output = new DeferredWritable()
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })
    output.complete()
    terminal.input.write('answer\n')
    await expect(pending).resolves.toBe('answer')
    expect(output.chunks).toEqual(['Secret: ', '\n'])

    output.complete(new Error('late newline failure sentinel'))
    await new Promise<void>((resolve) => output.once('close', resolve))
    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount('close')).toBe(0)
    expect(output.listenerCount('finish')).toBe(0)
  })

  it('shares one sink across multiple failing writes and keeps external listeners intact', async () => {
    const terminal = ttyStreams()
    const output = new DeferredWritable()
    const externalError = (): void => undefined
    output.on('error', externalError)
    const baseline = output.listenerCount('error')
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })

    terminal.input.write('answer\n')
    await expect(pending).resolves.toBe('answer')
    const closed = new Promise<void>((resolve) => output.once('close', resolve))
    output.complete(new Error('first shared sink failure sentinel'))
    expect(output.listenerCount('error')).toBe(baseline + 1)
    await new Promise<void>((resolve) => setImmediate(resolve))

    await closed
    expect(output.listenerCount('error')).toBe(baseline)
    expect(output.listenerCount('close')).toBe(0)
    expect(output.listenerCount('finish')).toBe(0)
    output.removeListener('error', externalError)
  })

  it('keeps the shared sink through a slow destroy and removes only its lifecycle listeners', async () => {
    const terminal = ttyStreams()
    const output = new SlowDestroyWritable()
    const externalError = (): void => undefined
    const externalClose = (): void => undefined
    output.on('error', externalError)
    output.on('close', externalClose)
    const baseline = output.lifecycleListeners()
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })

    output.complete(new Error('slow destroy sentinel'))
    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
    expect(output.lifecycleListeners()).toEqual({
      error: baseline.error + 1,
      close: baseline.close + 1,
      finish: baseline.finish + 1,
    })
    expect(output.destroyCallback).toBeDefined()
    const destroyCallback = output.destroyCallback
    destroyCallback?.(new Error('slow destroy completion sentinel'))
    await new Promise<void>((resolve) => output.once('close', resolve))
    expect(output.lifecycleListeners()).toEqual(baseline)
    output.removeListener('error', externalError)
    output.removeListener('close', externalClose)
  })

  it('does not end, destroy, or unref a shared output while draining write errors', async () => {
    const terminal = ttyStreams()
    const output = new DeferredWritable()
    const endSpy = vi.spyOn(output, 'end')
    const unrefSpy = vi.fn()
    Object.defineProperty(output, 'unref', { value: unrefSpy })
    const reader = new NodePromptReader(terminal.input, output)
    const pending = reader.read('Secret: ', { hidden: true })
    output.complete()
    terminal.input.write('answer\n')
    await expect(pending).resolves.toBe('answer')
    output.complete(new Error('output ownership sentinel'))
    await new Promise<void>((resolve) => output.once('close', resolve))

    expect(endSpy).not.toHaveBeenCalled()
    expect(unrefSpy).not.toHaveBeenCalled()
  })

  it('drains asynchronous prompt and final-newline Writable errors in a subprocess', async () => {
    const prompt = await runOutputErrorFixture('prompt')
    expect(prompt.code).toBe(0)
    expect(prompt.signal).toBeNull()
    expect(prompt.stdout).toContain('RESULT CODEX_AUTH_LOGIN_FAILED prompt_input LISTENERS 0 0 0')
    expect(prompt.stdout).not.toContain('UNCAUGHT')

    const newline = await runOutputErrorFixture('newline')
    expect(newline.code).toBe(0)
    expect(newline.signal).toBeNull()
    expect(newline.stdout).toContain('RESULT SUCCESS answer LISTENERS 0 0 0')
    expect(newline.stdout).not.toContain('UNCAUGHT')
  })

  it('maps visible empty EOF and partial lines to a safe EOF failure', async () => {
    const empty = streams()
    const emptyReader = new NodePromptReader(empty.input, empty.output)
    const emptyPending = emptyReader.read('Name: ', { hidden: false })
    empty.input.end()
    await expect(emptyPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })

    const partial = streams()
    const partialReader = new NodePromptReader(partial.input, partial.output)
    const partialPending = partialReader.read('Name: ', { hidden: false })
    partial.input.end('partial')
    await expect(partialPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
  })

  it('handles a pre-ended visible stream before constructing readline', async () => {
    const terminal = streams()
    terminal.input.end()
    terminal.input.resume()
    await new Promise<void>((resolve) => terminal.input.once('end', resolve))
    const reader = new NodePromptReader(terminal.input, terminal.output)

    await expect(reader.read('Name: ', { hidden: false })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    expect(terminal.capturedOutput()).toBe('')
  })

  it('preserves a complete visible line when end follows CR/LF', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output)
    const pending = reader.read('Name: ', { hidden: false })
    terminal.input.end('complete\n')

    await expect(pending).resolves.toBe('complete')
  })

  it('maps visible Ctrl-D and stream errors without exposing causes', async () => {
    const ctrlD = streams()
    const ctrlDReader = new NodePromptReader(ctrlD.input, ctrlD.output)
    const ctrlDPending = ctrlDReader.read('Name: ', { hidden: false })
    ctrlD.input.write('\u0004')
    await expect(ctrlDPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })

    const streamError = streams()
    const streamErrorReader = new NodePromptReader(streamError.input, streamError.output)
    const streamErrorPending = streamErrorReader.read('Name: ', { hidden: false })
    streamError.input.emit('error', new Error('visible stream secret sentinel'))
    await expect(streamErrorPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
  })

  it('honors whichever external cancellation or EOF cause arrives first', async () => {
    const eofFirst = streams()
    const eofController = new AbortController()
    const eofReader = new NodePromptReader(eofFirst.input, eofFirst.output)
    const eofPending = eofReader.read('Name: ', {
      hidden: false,
      signal: eofController.signal,
    })
    eofFirst.input.end()
    await expect(eofPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
    eofController.abort()

    const abortFirst = streams()
    const abortController = new AbortController()
    const abortReader = new NodePromptReader(abortFirst.input, abortFirst.output)
    const abortPending = abortReader.read('Name: ', {
      hidden: false,
      signal: abortController.signal,
    })
    abortController.abort()
    abortFirst.input.end()
    await expect(abortPending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps external cancellation first when its listener synchronously emits EOF or error', async () => {
    const eof = streams()
    const eofController = new AbortController()
    eofController.signal.addEventListener('abort', () => eof.input.end())
    const eofReader = new NodePromptReader(eof.input, eof.output)
    const eofPending = eofReader.read('Name: ', {
      hidden: false,
      signal: eofController.signal,
    })
    eofController.abort()
    await expect(eofPending).rejects.toMatchObject({ name: 'AbortError' })

    const streamError = streams()
    const streamErrorController = new AbortController()
    streamErrorController.signal.addEventListener('abort', () => {
      streamError.input.emit('error', new Error('external-error-race sentinel'))
    })
    const streamErrorReader = new NodePromptReader(streamError.input, streamError.output)
    const streamErrorPending = streamErrorReader.read('Name: ', {
      hidden: false,
      signal: streamErrorController.signal,
    })
    streamErrorController.abort()
    await expect(streamErrorPending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the first cause when external abort and close race in both orders', async () => {
    const abortFirst = streams()
    const abortFirstController = new AbortController()
    abortFirstController.signal.addEventListener('abort', () => abortFirst.input.emit('close'))
    const abortFirstReader = new NodePromptReader(abortFirst.input, abortFirst.output)
    const abortFirstPending = abortFirstReader.read('Name: ', {
      hidden: false,
      signal: abortFirstController.signal,
    })
    abortFirstController.abort()
    await expect(abortFirstPending).rejects.toMatchObject({ name: 'AbortError' })

    const closeFirst = streams()
    const closeFirstController = new AbortController()
    const closeFirstReader = new NodePromptReader(closeFirst.input, closeFirst.output)
    const closeFirstPending = closeFirstReader.read('Name: ', {
      hidden: false,
      signal: closeFirstController.signal,
    })
    closeFirst.input.once('close', () => closeFirstController.abort())
    closeFirst.input.emit('close')
    await expect(closeFirstPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })

    const hiddenAbortFirst = streams()
    const hiddenAbortFirstController = new AbortController()
    hiddenAbortFirstController.signal.addEventListener('abort', () => hiddenAbortFirst.input.emit('close'))
    const hiddenAbortFirstReader = new NodePromptReader(hiddenAbortFirst.input, hiddenAbortFirst.output)
    const hiddenAbortFirstPending = hiddenAbortFirstReader.read('Secret: ', {
      hidden: true,
      signal: hiddenAbortFirstController.signal,
    })
    hiddenAbortFirstController.abort()
    await expect(hiddenAbortFirstPending).rejects.toMatchObject({ name: 'AbortError' })

    const hiddenCloseFirst = streams()
    const hiddenCloseFirstController = new AbortController()
    const hiddenCloseFirstReader = new NodePromptReader(hiddenCloseFirst.input, hiddenCloseFirst.output)
    const hiddenCloseFirstPending = hiddenCloseFirstReader.read('Secret: ', {
      hidden: true,
      signal: hiddenCloseFirstController.signal,
    })
    hiddenCloseFirst.input.once('close', () => hiddenCloseFirstController.abort())
    hiddenCloseFirst.input.emit('close')
    await expect(hiddenCloseFirstPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })
  })

  it('keeps internal EOF or stream error first when external cancellation follows synchronously', async () => {
    const eof = streams()
    const eofController = new AbortController()
    const eofReader = new NodePromptReader(eof.input, eof.output)
    const eofPending = eofReader.read('Name: ', {
      hidden: false,
      signal: eofController.signal,
    })
    eof.input.once('end', () => eofController.abort())
    eof.input.end()
    await expect(eofPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'eof' },
    })

    const streamError = streams()
    const streamErrorController = new AbortController()
    const streamErrorReader = new NodePromptReader(streamError.input, streamError.output)
    const streamErrorPending = streamErrorReader.read('Name: ', {
      hidden: false,
      signal: streamErrorController.signal,
    })
    streamError.input.once('error', () => streamErrorController.abort())
    streamError.input.emit('error', new Error('internal-error-race sentinel'))
    await expect(streamErrorPending).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'prompt_input' },
    })
  })

  it('removes visible input listeners after success, failure, and abort', async () => {
    const success = streams()
    const successReader = new NodePromptReader(success.input, success.output)
    const successBaseline = {
      data: success.input.listenerCount('data'),
      end: success.input.listenerCount('end'),
      error: success.input.listenerCount('error'),
      close: success.input.listenerCount('close'),
    }
    const successPending = successReader.read('Name: ', { hidden: false })
    success.input.end('ok\n')
    await expect(successPending).resolves.toBe('ok')
    expect(success.input.listenerCount('data')).toBe(successBaseline.data)
    expect(success.input.listenerCount('end')).toBe(successBaseline.end)
    expect(success.input.listenerCount('error')).toBe(successBaseline.error)
    expect(success.input.listenerCount('close')).toBe(successBaseline.close)

    const failure = streams()
    const failureReader = new NodePromptReader(failure.input, failure.output)
    const failurePending = failureReader.read('Name: ', { hidden: false })
    failure.input.end()
    await expect(failurePending).rejects.toMatchObject({ code: 'CODEX_AUTH_LOGIN_FAILED' })
    expect(failure.input.listenerCount('data')).toBe(0)
    expect(failure.input.listenerCount('end')).toBe(0)
    expect(failure.input.listenerCount('error')).toBe(0)
    expect(failure.input.listenerCount('close')).toBe(0)

    const abort = streams()
    const abortReader = new NodePromptReader(abort.input, abort.output)
    const abortController = new AbortController()
    const abortPending = abortReader.read('Name: ', {
      hidden: false,
      signal: abortController.signal,
    })
    abortController.abort()
    await expect(abortPending).rejects.toMatchObject({ name: 'AbortError' })
    expect(abort.input.listenerCount('data')).toBe(0)
    expect(abort.input.listenerCount('end')).toBe(0)
    expect(abort.input.listenerCount('error')).toBe(0)
    expect(abort.input.listenerCount('close')).toBe(0)
  })

  it('fails before reading when production requires an interactive terminal', async () => {
    const terminal = streams()
    const reader = new NodePromptReader(terminal.input, terminal.output, {
      requireInteractive: true,
    })

    await expect(reader.read('Code: ', { hidden: true })).rejects.toMatchObject({
      code: 'CODEX_AUTH_LOGIN_FAILED',
      safeDetails: { reason: 'non_tty' },
    })
    expect(terminal.capturedOutput()).toBe('')
  })

})
