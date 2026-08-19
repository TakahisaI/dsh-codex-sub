import { StringDecoder } from 'node:string_decoder'
import type {
  Readable,
  Writable,
} from 'node:stream'
import { createInterface } from 'node:readline/promises'

import { CodexError } from '../core/errors.js'
import type {
  PromptReadOptions,
  PromptReader,
} from './types.js'

const MAX_PROMPT_INPUT_LENGTH = 16_384

type TerminalInput = Readable & {
  readonly isRaw?: boolean
  readonly isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

function abortFailure(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function inputFailure(): CodexError {
  return new CodexError('Interactive login input failed.', 'CODEX_AUTH_LOGIN_FAILED', {
    safeDetails: { reason: 'prompt_input' },
  })
}

export class NodePromptReader implements PromptReader {
  readonly #input: TerminalInput
  readonly #lifetime = new AbortController()
  readonly #output: Writable
  #closed = false

  constructor(input: TerminalInput, output: Writable) {
    this.#input = input
    this.#output = output
  }

  async read(prompt: string, options: PromptReadOptions): Promise<string> {
    if (this.#closed) {
      throw abortFailure()
    }
    const signal = options.signal === undefined
      ? this.#lifetime.signal
      : AbortSignal.any([this.#lifetime.signal, options.signal])
    if (options.hidden) {
      return this.#readHidden(prompt, signal)
    }

    const readline = createInterface({
      input: this.#input,
      output: this.#output,
      terminal: this.#input.isTTY === true,
    })
    try {
      const result = await readline.question(prompt, { signal })
      if (result.length > MAX_PROMPT_INPUT_LENGTH) {
        throw inputFailure()
      }
      return result
    } finally {
      readline.close()
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true
      this.#lifetime.abort()
    }
  }

  #readHidden(prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortFailure())
        return
      }

      const decoder = new StringDecoder('utf8')
      const characters: string[] = []
      const wasPaused = this.#input.isPaused()
      const wasRaw = this.#input.isRaw === true
      let settled = false

      const cleanup = (): void => {
        this.#input.removeListener('data', onData)
        this.#input.removeListener('end', onEnd)
        this.#input.removeListener('error', onError)
        signal.removeEventListener('abort', onAbort)
        if (this.#input.isTTY === true && this.#input.setRawMode !== undefined) {
          this.#input.setRawMode(wasRaw)
        }
        if (wasPaused) {
          this.#input.pause()
        }
      }
      const settle = (operation: () => void): void => {
        if (!settled) {
          settled = true
          cleanup()
          this.#output.write('\n')
          operation()
        }
      }
      const finish = (): void => {
        settle(() => resolve(characters.join('')))
      }
      const fail = (error: unknown): void => {
        settle(() => reject(error))
      }
      const acceptText = (text: string): void => {
        for (const character of text) {
          if (character === '\r' || character === '\n' || character === '\u0004') {
            finish()
            return
          }
          if (character === '\u0003') {
            fail(abortFailure())
            return
          }
          if (character === '\b' || character === '\u007f') {
            characters.pop()
          } else if (character >= ' ') {
            characters.push(character)
            if (characters.length > MAX_PROMPT_INPUT_LENGTH) {
              fail(inputFailure())
              return
            }
          }
        }
      }
      const onData = (chunk: string | Buffer): void => {
        acceptText(typeof chunk === 'string' ? chunk : decoder.write(chunk))
      }
      const onEnd = (): void => {
        const trailing = decoder.end()
        if (trailing.length > 0) {
          acceptText(trailing)
        }
        if (!settled) {
          finish()
        }
      }
      const onError = (): void => {
        fail(inputFailure())
      }
      const onAbort = (): void => {
        fail(abortFailure())
      }

      this.#output.write(prompt)
      signal.addEventListener('abort', onAbort, { once: true })
      this.#input.on('data', onData)
      this.#input.once('end', onEnd)
      this.#input.once('error', onError)
      if (this.#input.isTTY === true && this.#input.setRawMode !== undefined) {
        this.#input.setRawMode(true)
      }
      this.#input.resume()
    })
  }
}
