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

  it('removes visible input listeners after success, failure, and abort', async () => {
    const success = streams()
    const successReader = new NodePromptReader(success.input, success.output)
    const successBaseline = {
      data: success.input.listenerCount('data'),
      end: success.input.listenerCount('end'),
      error: success.input.listenerCount('error'),
    }
    const successPending = successReader.read('Name: ', { hidden: false })
    success.input.end('ok\n')
    await expect(successPending).resolves.toBe('ok')
    expect(success.input.listenerCount('data')).toBe(successBaseline.data)
    expect(success.input.listenerCount('end')).toBe(successBaseline.end)
    expect(success.input.listenerCount('error')).toBe(successBaseline.error)

    const failure = streams()
    const failureReader = new NodePromptReader(failure.input, failure.output)
    const failurePending = failureReader.read('Name: ', { hidden: false })
    failure.input.end()
    await expect(failurePending).rejects.toMatchObject({ code: 'CODEX_AUTH_LOGIN_FAILED' })
    expect(failure.input.listenerCount('data')).toBe(0)
    expect(failure.input.listenerCount('end')).toBe(0)
    expect(failure.input.listenerCount('error')).toBe(0)

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
