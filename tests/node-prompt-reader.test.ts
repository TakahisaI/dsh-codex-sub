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
