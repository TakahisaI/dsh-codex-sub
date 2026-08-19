import { parseArgs } from 'node:util'

export type CliInvocation =
  | { readonly command: 'help' }
  | { readonly command: 'login' }
  | { readonly command: 'logout' }
  | { readonly command: 'status'; readonly json: boolean }
  | { readonly command: 'doctor'; readonly json: boolean }
  | { readonly command: 'version' }

export class CliUsageError extends Error {
  constructor() {
    super('Invalid command-line usage.')
    this.name = 'CliUsageError'
  }
}

function usageError(): never {
  throw new CliUsageError()
}

export function parseCliArguments(arguments_: readonly string[]): CliInvocation {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    })
  } catch {
    return usageError()
  }

  const help = parsed.values['help'] === true
  const json = parsed.values['json'] === true
  const version = parsed.values['version'] === true
  const positionals = parsed.positionals

  if (version) {
    if (help || json || positionals.length !== 0) {
      return usageError()
    }
    return Object.freeze({ command: 'version' })
  }

  if (help) {
    if (json || positionals.length > 1) {
      return usageError()
    }
    return Object.freeze({ command: 'help' })
  }

  if (positionals.length === 0) {
    if (json) {
      return usageError()
    }
    return Object.freeze({ command: 'help' })
  }

  if (positionals[0] === 'help') {
    if (json || positionals.length !== 1) {
      return usageError()
    }
    return Object.freeze({ command: 'help' })
  }

  if (positionals.length !== 1) {
    return usageError()
  }

  switch (positionals[0]) {
    case 'login':
    case 'logout':
    case 'version':
      if (json) {
        return usageError()
      }
      return Object.freeze({ command: positionals[0] })
    case 'status':
      return Object.freeze({ command: 'status', json })
    case 'doctor':
      return Object.freeze({ command: 'doctor', json })
    default:
      return usageError()
  }
}
