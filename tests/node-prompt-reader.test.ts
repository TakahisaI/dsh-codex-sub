import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

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
