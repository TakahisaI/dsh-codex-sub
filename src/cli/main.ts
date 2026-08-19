import type {
  Readable,
  Writable,
} from 'node:stream'

import packageDocument from '../../package.json' with { type: 'json' }
import type { CodexAuthStatus } from '../core/contracts.js'
import { isCodexError } from '../core/errors.js'
import {
  evaluateRuntimeCompatibility,
  inspectInstalledRuntime,
} from '../dsh/compatibility.js'
import { PiAiCodexAuthService } from '../piai/auth-service.js'
import { codexCatalogModelCount } from '../piai/catalog.js'
import { FileCredentialVault } from '../storage/file-credential-vault.js'
import { createTerminalLoginInteraction } from './login-interaction.js'
import { NodePromptReader } from './node-prompt-reader.js'
import {
  CLI_HELP,
  writeDoctor,
  writeJson,
  writeStatus,
} from './output.js'
import {
  CliUsageError,
  parseCliArguments,
} from './parser.js'
import {
  createDoctorReport,
  createStatusReport,
} from './reports.js'
import type {
  CliEnvironment,
  CliIo,
} from './types.js'

export const CLI_EXIT_SUCCESS = 0
export const CLI_EXIT_EXPECTED_NEGATIVE = 1
export const CLI_EXIT_USAGE = 2
export const CLI_EXIT_FAILURE = 3
export const CLI_EXIT_CANCELLED = 4

function statusExitCode(status: CodexAuthStatus): number {
  switch (status.state) {
    case 'signed-in':
      return CLI_EXIT_SUCCESS
    case 'signed-out':
      return CLI_EXIT_EXPECTED_NEGATIVE
    case 'invalid-storage':
    case 'insecure-storage':
      return CLI_EXIT_FAILURE
  }
}

function hasAbortName(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  try {
    let current: object | null = error
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name')
      if (descriptor !== undefined) {
        if ('value' in descriptor) {
          return descriptor.value === 'AbortError'
        }
        return descriptor.get !== undefined
          && Reflect.apply(descriptor.get, error, []) === 'AbortError'
      }
      current = Object.getPrototypeOf(current)
    }
  } catch {
    return false
  }
  return false
}

function safeFailure(io: CliIo, error: unknown): void {
  if (isCodexError(error)) {
    io.stderr(`${error.code}: ${error.message}\n`)
  } else {
    io.stderr('The command failed unexpectedly.\n')
  }
}

export async function runCli(
  arguments_: readonly string[],
  environment: CliEnvironment,
  io: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  let invocation
  try {
    invocation = parseCliArguments(arguments_)
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr('Invalid command-line usage. Run with --help.\n')
      return CLI_EXIT_USAGE
    }
    safeFailure(io, error)
    return CLI_EXIT_FAILURE
  }

  try {
    switch (invocation.command) {
      case 'help':
        io.stdout(CLI_HELP)
        return CLI_EXIT_SUCCESS
      case 'version':
        io.stdout(`${environment.packageVersion}\n`)
        return CLI_EXIT_SUCCESS
      case 'login': {
        const promptReader = environment.promptReader
        const interaction = createTerminalLoginInteraction({
          io,
          reader: promptReader,
          ...(signal === undefined ? {} : { signal }),
        })
        try {
          await environment.authService.login(interaction, signal)
        } finally {
          promptReader.close()
        }
        io.stdout('Signed in.\n')
        return CLI_EXIT_SUCCESS
      }
      case 'logout':
        await environment.authService.logout()
        io.stdout('Signed out.\n')
        return CLI_EXIT_SUCCESS
      case 'status': {
        const status = await environment.authService.status()
        if (invocation.json) {
          writeJson(io, createStatusReport(environment.packageVersion, status))
        } else {
          writeStatus(io, status)
        }
        return statusExitCode(status)
      }
      case 'doctor': {
        const report = createDoctorReport({
          version: environment.packageVersion,
          runtime: environment.inspectRuntime(),
          credentialStore: await environment.credentialVault.inspect(),
          modelCount: environment.catalogModelCount(),
        })
        if (invocation.json) {
          writeJson(io, report)
        } else {
          writeDoctor(io, report)
        }
        return report.overall === 'compatible'
          ? CLI_EXIT_SUCCESS
          : CLI_EXIT_EXPECTED_NEGATIVE
      }
    }
  } catch (error) {
    if (invocation.command === 'login' && (signal?.aborted === true || hasAbortName(error))) {
      io.stderr('Login cancelled.\n')
      return CLI_EXIT_CANCELLED
    }
    safeFailure(io, error)
    return CLI_EXIT_FAILURE
  }
}

export function createProcessCliIo(stdout: Writable, stderr: Writable): CliIo {
  return Object.freeze({
    stdout(text: string): void {
      stdout.write(text)
    },
    stderr(text: string): void {
      stderr.write(text)
    },
  })
}

export function createProductionCliEnvironment(
  input: Readable & {
    readonly isRaw?: boolean
    readonly isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
  },
  output: Writable,
): CliEnvironment {
  let vault: FileCredentialVault | undefined
  let authService: PiAiCodexAuthService | undefined
  let promptReader: NodePromptReader | undefined

  const resolveVault = (): FileCredentialVault => {
    vault ??= new FileCredentialVault()
    return vault
  }

  return Object.freeze({
    packageVersion: packageDocument.version,
    get authService(): PiAiCodexAuthService {
      authService ??= new PiAiCodexAuthService({ vault: resolveVault() })
      return authService
    },
    get credentialVault(): FileCredentialVault {
      return resolveVault()
    },
    inspectRuntime: () => evaluateRuntimeCompatibility(inspectInstalledRuntime()),
    catalogModelCount: codexCatalogModelCount,
    get promptReader(): NodePromptReader {
      promptReader ??= new NodePromptReader(input, output)
      return promptReader
    },
  })
}

export async function runProductionCli(
  arguments_: readonly string[],
  input: Readable & {
    readonly isRaw?: boolean
    readonly isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
  },
  stdout: Writable,
  stderr: Writable,
  signal?: AbortSignal,
): Promise<number> {
  return runCli(
    arguments_,
    createProductionCliEnvironment(input, stdout),
    createProcessCliIo(stdout, stderr),
    signal,
  )
}
