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

// These symbols never cross the PromptReader boundary. They let the visible
// reader distinguish an input EOF/stream failure from a caller cancellation,
// even though readline reports both through an AbortError.
const INTERNAL_EOF_REASON = Symbol('node-prompt-reader.eof')
const INTERNAL_STREAM_ERROR_REASON = Symbol('node-prompt-reader.stream-error')

type TerminalInput = Readable & {
  readonly isRaw?: boolean
  readonly isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

function abortFailure(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function inputFailure(reason = 'prompt_input'): CodexError {
  return new CodexError('Interactive login input failed.', 'CODEX_AUTH_LOGIN_FAILED', {
    safeDetails: { reason },
  })
}

function inputUnavailable(input: TerminalInput): boolean {
  return input.readableEnded === true || input.destroyed === true || input.readable === false
}

function failureForSignal(reason: unknown): unknown {
  if (reason === INTERNAL_EOF_REASON) {
    return inputFailure('eof')
  }
  if (reason === INTERNAL_STREAM_ERROR_REASON) {
    return inputFailure('prompt_input')
  }
  return abortFailure()
}

export interface NodePromptReaderOptions {
  /** Production login requires a real terminal; tests may use stream fixtures. */
  readonly requireInteractive?: boolean
}

export class NodePromptReader implements PromptReader {
  readonly #input: TerminalInput
  readonly #lifetime = new AbortController()
  readonly #output: Writable
  readonly #requireInteractive: boolean
  #closed = false

  constructor(input: TerminalInput, output: Writable, options: NodePromptReaderOptions = {}) {
    this.#input = input
    this.#output = output
    this.#requireInteractive = options.requireInteractive === true
  }

  async read(prompt: string, options: PromptReadOptions): Promise<string> {
    if (this.#closed) {
      throw abortFailure()
    }
    this.assertInteractive()
    if (this.#lifetime.signal.aborted || options.signal?.aborted === true) {
      throw abortFailure()
    }
    if (options.hidden) {
      if (inputUnavailable(this.#input)) {
        throw inputFailure('eof')
      }
      return this.#readHidden(prompt, options.signal)
    }

    if (inputUnavailable(this.#input)) {
      throw inputFailure('eof')
    }

    const internalAbort = new AbortController()
    const signal = options.signal === undefined
      ? AbortSignal.any([this.#lifetime.signal, internalAbort.signal])
      : AbortSignal.any([this.#lifetime.signal, options.signal, internalAbort.signal])
    let ended = false
    let closed = false
    let lineCompleted = false
    let sawControlD = false
    let settled = false
    const abortInternal = (reason: typeof INTERNAL_EOF_REASON | typeof INTERNAL_STREAM_ERROR_REASON): void => {
      // An external abort event can synchronously emit end/error from one of
      // its listeners. The base signal is already marked aborted at that
      // point, so keep the combined signal's external first cause intact.
      if (
        !settled
        && !internalAbort.signal.aborted
        && !this.#lifetime.signal.aborted
        && !options.signal?.aborted
      ) {
        internalAbort.abort(reason)
      }
    }
    const observeInput = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const character of text) {
        // Once a complete line has arrived, a subsequent Ctrl-D/end event is
        // part of stream teardown and must not turn that successful line into
        // an EOF failure.
        if (character === '\r' || character === '\n') {
          lineCompleted = true
          return
        }
        if (character === '\u0004') {
          sawControlD = true
          abortInternal(INTERNAL_EOF_REASON)
          return
        }
      }
    }
    const observeEnd = (): void => {
      ended = true
      if (!lineCompleted) {
        abortInternal(INTERNAL_EOF_REASON)
      }
    }
    const observeClose = (): void => {
      closed = true
      if (!lineCompleted) {
        abortInternal(INTERNAL_EOF_REASON)
      }
    }
    const observeError = (): void => {
      if (!lineCompleted) {
        abortInternal(INTERNAL_STREAM_ERROR_REASON)
      }
    }
    const observeReadlineError = (): void => {
      if (!lineCompleted) {
        abortInternal(INTERNAL_STREAM_ERROR_REASON)
      }
    }

    // Attach all stream observers before constructing readline. This closes
    // the pre-ended/empty-EOF race where readline could otherwise miss end.
    this.#input.on('data', observeInput)
    this.#input.once('end', observeEnd)
    this.#input.once('error', observeError)
    this.#input.once('close', observeClose)
    let readline: ReturnType<typeof createInterface> | undefined

    try {
      if (inputUnavailable(this.#input)) {
        abortInternal(INTERNAL_EOF_REASON)
      }
      if (signal.aborted) {
        throw abortFailure()
      }
      readline = createInterface({
        input: this.#input,
        output: this.#output,
        terminal: this.#input.isTTY === true,
      })
      // readline re-emits input errors on its own EventEmitter. Keep a local
      // sink so a stream failure cannot become an uncaught EventEmitter error.
      readline.on('error', observeReadlineError)
      const result = await readline.question(prompt, { signal })
      if (sawControlD || ((ended || closed) && !lineCompleted)) {
        throw inputFailure('eof')
      }
      if (result.length > MAX_PROMPT_INPUT_LENGTH) {
        throw inputFailure()
      }
      return result
    } catch (error) {
      const reason = signal.reason
      if (reason === INTERNAL_EOF_REASON) {
        throw inputFailure('eof')
      }
      if (reason === INTERNAL_STREAM_ERROR_REASON) {
        throw inputFailure('prompt_input')
      }
      if (signal.aborted || this.#lifetime.signal.aborted || options.signal?.aborted) {
        throw abortFailure()
      }
      throw error
    } finally {
      settled = true
      this.#input.removeListener('data', observeInput)
      this.#input.removeListener('end', observeEnd)
      this.#input.removeListener('error', observeError)
      this.#input.removeListener('close', observeClose)
      readline?.removeListener('error', observeReadlineError)
      readline?.close()
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true
      this.#lifetime.abort()
    }
  }

  assertInteractive(): void {
    if (this.#requireInteractive && this.#input.isTTY !== true) {
      throw inputFailure('non_tty')
    }
  }

  #readHidden(prompt: string, externalSignal: AbortSignal | undefined): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const internalAbort = new AbortController()
      const signal = externalSignal === undefined
        ? AbortSignal.any([this.#lifetime.signal, internalAbort.signal])
        : AbortSignal.any([this.#lifetime.signal, externalSignal, internalAbort.signal])
      const decoder = new StringDecoder('utf8')
      const characters: string[] = []
      const wasPaused = this.#input.isPaused()
      const wasRaw = this.#input.isRaw === true
      let settled = false
      let promptWritten = false
      let rawModeChanged = false
      let resumed = false

      const abortInternal = (reason: typeof INTERNAL_EOF_REASON | typeof INTERNAL_STREAM_ERROR_REASON): void => {
        // If an external abort listener synchronously ends/errors the input,
        // preserve the external signal as the combined first cause.
        if (
          !settled
          && !internalAbort.signal.aborted
          && !this.#lifetime.signal.aborted
          && !externalSignal?.aborted
        ) {
          internalAbort.abort(reason)
        }
      }

      const cleanup = (): void => {
        const bestEffort = (effect: () => void): void => {
          try {
            effect()
          } catch {
            // Cleanup is deliberately best effort. The original prompt result
            // remains authoritative even when a terminal hook is broken.
          }
        }

        bestEffort(() => signal.removeEventListener('abort', onAbort))
        // Keep the input error sink installed while terminal rollback runs:
        // setRawMode/pause implementations can synchronously emit `error`.
        bestEffort(() => {
          if (rawModeChanged && this.#input.isTTY === true && this.#input.setRawMode !== undefined) {
            this.#input.setRawMode(wasRaw)
          }
        })
        bestEffort(() => {
          if (resumed && wasPaused) {
            this.#input.pause()
          }
        })
        bestEffort(() => this.#input.removeListener('data', onData))
        bestEffort(() => this.#input.removeListener('end', onEnd))
        bestEffort(() => this.#input.removeListener('close', onClose))
        bestEffort(() => this.#input.removeListener('error', onError))
      }
      const settle = (operation: () => void): void => {
        if (!settled) {
          settled = true
          try {
            cleanup()
          } finally {
            if (promptWritten) {
              const drainOutputError = (): void => undefined
              let drainInstalled = false
              try {
                try {
                  this.#output.on('error', drainOutputError)
                  drainInstalled = true
                } catch {
                  // A nonstandard output may reject listener installation;
                  // still make the write attempt and preserve the result.
                }
                try {
                  this.#output.write('\n')
                } catch {
                  // Newline rendering is best effort and must not replace the
                  // original answer, EOF, or caller-abort result.
                }
              } finally {
                if (drainInstalled) {
                  try {
                    this.#output.removeListener('error', drainOutputError)
                  } catch {
                    // Listener cleanup itself is also best effort.
                  }
                }
              }
            }
            // Always invoke the original operation, including after any
            // terminal or output cleanup failure.
            operation()
          }
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
          if (character === '\r' || character === '\n') {
            finish()
            return
          }
          if (character === '\u0004') {
            abortInternal(INTERNAL_EOF_REASON)
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
          abortInternal(INTERNAL_EOF_REASON)
        }
      }
      const onError = (): void => {
        abortInternal(INTERNAL_STREAM_ERROR_REASON)
      }
      const onClose = (): void => {
        if (!settled) {
          abortInternal(INTERNAL_EOF_REASON)
        }
      }
      const onAbort = (): void => {
        fail(failureForSignal(signal.reason))
      }

      try {
        // Attach every observer before any prompt/raw/resume side effect. This
        // makes an EOF that arrives in the attach window a clean input failure.
        this.#input.on('data', onData)
        this.#input.once('end', onEnd)
        // Keep this listener attached until terminal rollback is complete. A
        // broken raw-mode hook may synchronously emit an `error` event.
        this.#input.on('error', onError)
        this.#input.once('close', onClose)
        signal.addEventListener('abort', onAbort, { once: true })

        if (inputUnavailable(this.#input)) {
          abortInternal(INTERNAL_EOF_REASON)
        }
        if (signal.aborted) {
          fail(failureForSignal(signal.reason))
          return
        }

        // Mark the prompt before writing because a custom Writable may write a
        // prefix and then throw. The trailing newline remains best effort.
        promptWritten = true
        this.#output.write(prompt)
        if (signal.aborted || internalAbort.signal.aborted) {
          fail(failureForSignal(signal.reason))
          return
        }
        if (this.#input.isTTY === true && this.#input.setRawMode !== undefined) {
          // Mark before calling the hook: implementations may change state
          // and then throw, so cleanup must still attempt the rollback.
          rawModeChanged = true
          this.#input.setRawMode(true)
        }
        if (signal.aborted || internalAbort.signal.aborted) {
          fail(failureForSignal(signal.reason))
          return
        }
        resumed = true
        this.#input.resume()
      } catch (error) {
        // Setup hooks are outside the prompt protocol and may throw arbitrary
        // native errors. Convert them to the fixed public failure while
        // preserving whichever EOF/abort cause already won the race.
        if (!settled) {
          fail(signal.aborted ? failureForSignal(signal.reason) : inputFailure('prompt_input'))
        }
        // A Promise executor will otherwise reject with the native error after
        // a synchronous hook throws. The public failure above is authoritative.
        void error
      }
    })
  }
}
