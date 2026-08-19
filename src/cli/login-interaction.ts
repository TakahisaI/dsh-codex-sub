import { redactText } from '../core/redaction.js'
import { CodexError } from '../core/errors.js'
import type {
  PiAiLoginEvent,
  PiAiLoginInteraction,
  PiAiLoginPrompt,
} from '../piai/login-contract.js'
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
  io.stdout(`${message}\n`)
  for (const [index, option] of options.entries()) {
    io.stdout(`  ${String(index + 1)}) ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}\n`)
  }

  while (true) {
    const answer = (await reader.read('Selection: ', {
      hidden: false,
      ...(signal === undefined ? {} : { signal }),
    })).trim()
    if (/^[1-9]\d*$/u.test(answer)) {
      const selected = options[Number(answer) - 1]
      if (selected !== undefined) {
        return selected.id
      }
    }
    io.stdout('Enter one of the listed numbers.\n')
  }
}

async function readPrompt(
  prompt: PiAiLoginPrompt,
  reader: PromptReader,
  io: CliIo,
  interactionSignal: AbortSignal | undefined,
): Promise<string> {
  const signal = combinedSignal(interactionSignal, prompt.signal)
  switch (prompt.type) {
    case 'select':
      return readSelect(prompt, reader, io, signal)
    case 'text':
      return reader.read(`${safeInteractiveText(prompt.message, 'text_prompt')}: `, {
        hidden: false,
        ...(signal === undefined ? {} : { signal }),
      })
    case 'secret':
      return reader.read(`${safeInteractiveText(prompt.message, 'secret_prompt')}: `, {
        hidden: true,
        ...(signal === undefined ? {} : { signal }),
      })
    case 'manual_code':
      return reader.read(`${safeInteractiveText(prompt.message, 'manual_code_prompt')}: `, {
        hidden: true,
        ...(signal === undefined ? {} : { signal }),
      })
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
}): PiAiLoginInteraction {
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    prompt(prompt: PiAiLoginPrompt): Promise<string> {
      return readPrompt(prompt, options.reader, options.io, options.signal)
    },
    notify(event: PiAiLoginEvent): void {
      writeNotification(event, options.io)
    },
  })
}
