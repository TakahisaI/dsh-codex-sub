import { redactText } from '../core/redaction.js'
import { CodexError } from '../core/errors.js'
import type {
  PiAiLoginEvent,
  PiAiLoginInteraction,
  PiAiLoginPrompt,
} from '../piai/login-contract.js'
import type { BrowserOpener } from './browser-opener.js'
import type {
  CliIo,
  PromptReader,
} from './types.js'

const MAX_INTERACTIVE_TEXT_LENGTH = 4_096
const MAX_AUTH_URL_LENGTH = 8_192

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined
    && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
}

function protocolFailure(reason: string): CodexError {
  return new CodexError(
    'The pi-ai OAuth interaction is incompatible.',
    'CODEX_UPSTREAM_PROTOCOL',
    { safeDetails: { reason } },
  )
}

function safeInteractiveText(value: string, reason: string): string {
  if (value.length === 0 || value.length > MAX_INTERACTIVE_TEXT_LENGTH) {
    throw protocolFailure(reason)
  }
  const normalized = [...redactText(value)]
    .map((character) => isControlCharacter(character) ? ' ' : character)
    .join('')
    .replaceAll(/\s+/gu, ' ')
    .trim()
  if (normalized.length === 0) {
    throw protocolFailure(reason)
  }
  return normalized
}

function abortFailure(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortFailure()
  }
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

export function validateAuthorizationDestination(value: string): string {
  if (
    value.length === 0
    || value.length > MAX_AUTH_URL_LENGTH
    || [...value].some(isControlCharacter)
  ) {
    throw protocolFailure('auth_destination')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new CodexError(
      'The pi-ai OAuth interaction is incompatible.',
      'CODEX_UPSTREAM_PROTOCOL',
      { cause: error, safeDetails: { reason: 'auth_destination' } },
    )
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw protocolFailure('auth_destination')
  }
  return parsed.href
}

function combinedSignal(
  interactionSignal: AbortSignal | undefined,
  promptSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (interactionSignal === undefined) {
    return promptSignal
  }
  if (promptSignal === undefined || interactionSignal === promptSignal) {
    return interactionSignal
  }
  return AbortSignal.any([interactionSignal, promptSignal])
}

async function readSelect(
  prompt: Extract<PiAiLoginPrompt, { type: 'select' }>,
  reader: PromptReader,
  io: CliIo,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (prompt.options.length === 0 || prompt.options.length > 100) {
    throw protocolFailure('select_options')
  }
  const options = prompt.options.map((option) => Object.freeze({
    id: option.id,
    label: safeInteractiveText(option.label, 'select_label'),
    ...(option.description === undefined
      ? {}
      : { description: safeInteractiveText(option.description, 'select_description') }),
  }))
  const message = safeInteractiveText(prompt.message, 'select_message')
  const defaults = options.filter((option) => option.label.endsWith(' (default)'))
  if (defaults.length > 1) {
    throw protocolFailure('select_default')
  }
  reader.assertInteractive?.()
  io.stdout(`${message}\n`)
  for (const [index, option] of options.entries()) {
    io.stdout(`  ${String(index + 1)}) ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}\n`)
  }

  while (true) {
    const answer = await reader.read('Selection [n]: ', {
      hidden: false,
      ...(signal === undefined ? {} : { signal }),
    })
    if (answer.length === 0) {
      if (defaults.length === 1) {
        return defaults[0]!.id
      }
      io.stdout('Enter one of the listed numbers.\n')
      continue
    }
    if (/^[1-9]\d*$/u.test(answer)) {
      const selected = options[Number(answer) - 1]
      if (selected !== undefined) {
        return selected.id
      }
    }
    const matchingTargetIds = new Set(
      options
        .filter((option) => option.id === answer || option.label === answer)
        .map((option) => option.id),
    )
    if (matchingTargetIds.size === 1) {
      return [...matchingTargetIds][0]!
    }
    io.stdout('Enter one of the listed numbers.\n')
  }
}

async function readHiddenPrompt(
  message: string,
  reader: PromptReader,
  signal: AbortSignal | undefined,
): Promise<string> {
  reader.assertInteractive?.()
  return reader.read(`${message}: `, {
    hidden: true,
    ...(signal === undefined ? {} : { signal }),
  })
}

interface PendingAuthorization {
  readonly url: string
  consumed: boolean
}

async function readPrompt(
  prompt: PiAiLoginPrompt,
  reader: PromptReader,
  io: CliIo,
  interactionSignal: AbortSignal | undefined,
  pendingAuthorization: { get(): PendingAuthorization | undefined; clear(): void },
  browserOpener: BrowserOpener | undefined,
): Promise<string> {
  const signal = combinedSignal(interactionSignal, prompt.signal)
  switch (prompt.type) {
    case 'select':
      if (pendingAuthorization.get() !== undefined) {
        throw protocolFailure('auth_sequence')
      }
      return readSelect(prompt, reader, io, signal)
    case 'text':
      if (pendingAuthorization.get() !== undefined) {
        throw protocolFailure('auth_sequence')
      }
      reader.assertInteractive?.()
      return reader.read(`${safeInteractiveText(prompt.message, 'text_prompt')}: `, {
        hidden: false,
        ...(signal === undefined ? {} : { signal }),
      })
    case 'secret':
      if (pendingAuthorization.get() !== undefined) {
        throw protocolFailure('auth_sequence')
      }
      reader.assertInteractive?.()
      return reader.read(`${safeInteractiveText(prompt.message, 'secret_prompt')}: `, {
        hidden: true,
        ...(signal === undefined ? {} : { signal }),
      })
    case 'manual_code':
      {
        const message = safeInteractiveText(prompt.message, 'manual_code_prompt')
        const pending = pendingAuthorization.get()
        if (pending === undefined) {
          return readHiddenPrompt(message, reader, signal)
        }
        if (pending.consumed) {
          throw protocolFailure('auth_sequence')
        }
        pending.consumed = true
        // The first hidden read doubles as the explicit browser confirmation. An
        // entered code is passed through unchanged and never invokes the opener.
        const answer = await readHiddenPrompt(
          `${message}\nPress Enter to open in your default browser, or enter the authorization code`,
          reader,
          signal,
        )
        if (answer.length > 0) {
          pendingAuthorization.clear()
          return answer
        }

        throwIfAborted(signal)
        let opened = false
        if (browserOpener !== undefined) {
          try {
            opened = await browserOpener.open(pending.url, signal)
          } catch (error) {
            if (isAbortFailure(error)) {
              throw error
            }
          }
        }
        pendingAuthorization.clear()
        if (!opened) {
          io.stdout('Could not open the browser automatically. Open the URL manually.\n')
        }
        throwIfAborted(signal)
        return readHiddenPrompt(message, reader, signal)
      }
  }
}

function writeNotification(event: PiAiLoginEvent, io: CliIo): void {
  switch (event.type) {
    case 'info': {
      const message = safeInteractiveText(event.message, 'info_message')
      const links = (event.links ?? []).map((link) => Object.freeze({
        url: validateAuthorizationDestination(link.url),
        label: link.label === undefined
          ? 'More information'
          : safeInteractiveText(link.label, 'info_link_label'),
      }))
      io.stdout(`${message}\n`)
      for (const link of links) {
        io.stdout(`${link.label}: ${link.url}\n`)
      }
      break
    }
    case 'auth_url': {
      const url = validateAuthorizationDestination(event.url)
      if (event.instructions !== undefined) {
        io.stdout(`${safeInteractiveText(event.instructions, 'auth_instructions')}\n`)
      }
      io.stdout(`Open this URL to continue:\n${url}\n`)
      break
    }
    case 'device_code': {
      const verificationUrl = validateAuthorizationDestination(event.verificationUri)
      const userCode = safeInteractiveText(event.userCode, 'device_code')
      io.stdout(`Open this URL to continue:\n${verificationUrl}\n`)
      io.stdout(`Device code: ${userCode}\n`)
      break
    }
    case 'progress':
      io.stdout(`${safeInteractiveText(event.message, 'progress_message')}\n`)
      break
  }
}

export function createTerminalLoginInteraction(options: {
  readonly io: CliIo
  readonly reader: PromptReader
  readonly signal?: AbortSignal
  readonly browserOpener?: BrowserOpener
}): PiAiLoginInteraction {
  let pendingAuthorization: PendingAuthorization | undefined
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    prompt(prompt: PiAiLoginPrompt): Promise<string> {
      return readPrompt(
        prompt,
        options.reader,
        options.io,
        options.signal,
        {
          get: () => pendingAuthorization,
          clear: () => {
            pendingAuthorization = undefined
          },
        },
        options.browserOpener,
      )
    },
    notify(event: PiAiLoginEvent): void {
      if (pendingAuthorization !== undefined && event.type === 'auth_url') {
        throw protocolFailure('auth_sequence')
      }
      writeNotification(event, options.io)
      if (event.type === 'auth_url') {
        pendingAuthorization = { url: validateAuthorizationDestination(event.url), consumed: false }
      }
    },
  })
}
