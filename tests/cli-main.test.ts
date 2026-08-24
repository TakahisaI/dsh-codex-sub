import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type {
  CodexAuthService,
  CodexAuthStatus,
  CredentialVaultInspection,
} from '../src/core/contracts.js'
import { CodexError } from '../src/core/errors.js'
import type { RuntimeCompatibilityReport } from '../src/dsh/compatibility.js'
import type { PiAiLoginInteraction } from '../src/piai/login-contract.js'
import {
  CLI_EXIT_CANCELLED,
  CLI_EXIT_EXPECTED_NEGATIVE,
  CLI_EXIT_FAILURE,
  CLI_EXIT_SUCCESS,
  CLI_EXIT_USAGE,
  runCli,
} from '../src/cli/main.js'
import type {
  CliEnvironment,
  CliIo,
  PromptReadOptions,
  PromptReader,
} from '../src/cli/types.js'

const PACKAGE_VERSION = '1.2.3-test'

class AuthProbe implements CodexAuthService {
  loginCalls = 0
  logoutCalls = 0
  resolveCalls = 0
  statusCalls = 0
  statusValue: CodexAuthStatus = { state: 'signed-out' }
  loginOperation: (
    interaction: PiAiLoginInteraction,
    signal: AbortSignal | undefined,
  ) => Promise<void> = async () => undefined
  logoutError: unknown
  statusError: unknown

  async login(interaction: unknown, signal?: AbortSignal): Promise<void> {
    this.loginCalls += 1
    await this.loginOperation(interaction as PiAiLoginInteraction, signal)
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1
    if (this.logoutError !== undefined) {
      throw this.logoutError
    }
  }

  async status(): Promise<CodexAuthStatus> {
    this.statusCalls += 1
    if (this.statusError !== undefined) {
      throw this.statusError
    }
    return this.statusValue
  }

  async resolveRequestAuth(): Promise<never> {
    this.resolveCalls += 1
    throw new Error('Model request auth must not be used by the CLI.')
  }
}

class PromptProbe implements PromptReader {
  readonly calls: Array<{ readonly prompt: string; readonly options: PromptReadOptions }> = []
  closeCalls = 0

  constructor(private readonly responses: string[] = []) {}

  async read(prompt: string, options: PromptReadOptions): Promise<string> {
    this.calls.push({ prompt, options })
    const response = this.responses.shift()
    if (response === undefined) {
      throw new Error('The test prompt queue is empty.')
    }
    return response
  }

  close(): void {
    this.closeCalls += 1
  }
}

function compatibleRuntime(): RuntimeCompatibilityReport {
  const check = (version: string) => Object.freeze({
    supported: version,
    installed: version,
    status: 'compatible' as const,
  })
  return Object.freeze({
    compatible: true,
    platform: Object.freeze({
      supported: Object.freeze(['darwin', 'linux']),
      installed: 'linux',
      status: 'compatible' as const,
    }),
    node: check('^22.19.0 || ^24.0.0 || ^26.0.0'),
    packages: Object.freeze({
      '@deepseek-ai/cordis': check('4.0.1'),
      '@deepseek-ai/dsh-attachment': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-atomic-write': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-home-paths': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-llm': check('0.1.1-rc.1'),
      '@deepseek-ai/dsh-llm-pi-ai': check('0.1.1-rc.1'),
      '@earendil-works/pi-ai': check('0.82.1'),
    }),
  })
}

function captureIo(): { readonly io: CliIo; stdout: () => string; stderr: () => string } {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout(text) {
        stdout += text
      },
      stderr(text) {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function fixture(input: {
  readonly status?: CodexAuthStatus
  readonly inspection?: CredentialVaultInspection
  readonly runtime?: RuntimeCompatibilityReport
  readonly modelCount?: number
  readonly promptReader?: PromptReader
} = {}): {
  readonly auth: AuthProbe
  readonly promptReader: PromptReader
  readonly environment: CliEnvironment
  readonly counters: { inspect: number; runtime: number; catalog: number }
} {
  const auth = new AuthProbe()
  auth.statusValue = input.status ?? { state: 'signed-out' }
  const promptReader = input.promptReader ?? new PromptProbe()
  const counters = { inspect: 0, runtime: 0, catalog: 0 }
  const inspection = input.inspection ?? {
    state: 'present' as const,
    formatVersion: 1,
    permissions: 'owner-only' as const,
  }
  return {
    auth,
    promptReader,
    counters,
    environment: {
      packageVersion: PACKAGE_VERSION,
      authService: auth,
      credentialVault: {
        async inspect() {
          counters.inspect += 1
          return inspection
        },
      },
      inspectRuntime() {
        counters.runtime += 1
        return input.runtime ?? compatibleRuntime()
      },
      catalogModelCount() {
        counters.catalog += 1
        return input.modelCount ?? 7
      },
      promptReader,
    },
  }
}

describe('CLI command orchestration', () => {
  it('prints help and rejects invalid usage with the stable exit code', async () => {
    const testFixture = fixture()
    const help = captureIo()
    const invalid = captureIo()

    await expect(runCli([], testFixture.environment, help.io)).resolves.toBe(CLI_EXIT_SUCCESS)
    await expect(runCli(['unknown'], testFixture.environment, invalid.io)).resolves.toBe(
      CLI_EXIT_USAGE,
    )

    expect(help.stdout()).toContain('Usage: dsh-codex-sub <command> [options]\n')
    expect(help.stderr()).toBe('')
    expect(invalid.stdout()).toBe('')
    expect(invalid.stderr()).toBe('Invalid command-line usage. Run with --help.\n')
  })

  it('prints only the package version', async () => {
    const testFixture = fixture()
    const capture = captureIo()

    await expect(runCli(['version'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_SUCCESS,
    )
    expect(capture.stdout()).toBe(`${PACKAGE_VERSION}\n`)
    expect(capture.stderr()).toBe('')
  })

  it.each([
    [[], 'Usage: dsh-codex-sub <command> [options]\n'],
    [['version'], `${PACKAGE_VERSION}\n`],
  ] as const)('does not construct command dependencies for %#', async (arguments_, output) => {
    const capture = captureIo()
    let dependencyReads = 0
    const unavailable = (): never => {
      dependencyReads += 1
      throw new Error('Production command dependencies must remain lazy.')
    }
    const environment: CliEnvironment = {
      packageVersion: PACKAGE_VERSION,
      get authService() {
        return unavailable()
      },
      get credentialVault() {
        return unavailable()
      },
      inspectRuntime: unavailable,
      catalogModelCount: unavailable,
      get promptReader() {
        return unavailable()
      },
    }

    await expect(runCli(arguments_, environment, capture.io)).resolves.toBe(CLI_EXIT_SUCCESS)
    expect(capture.stdout()).toContain(output)
    expect(capture.stderr()).toBe('')
    expect(dependencyReads).toBe(0)
  })

  it('prints a safe failure when lazy command construction fails', async () => {
    const sentinel = `PATH_SENTINEL_${randomUUID()}`
    const capture = captureIo()
    const testFixture = fixture()
    const environment: CliEnvironment = {
      ...testFixture.environment,
      get authService(): CodexAuthService {
        throw new CodexError('Credential storage could not be read.', 'CODEX_AUTH_STORAGE_INVALID', {
          cause: new Error(sentinel),
        })
      },
    }

    await expect(runCli(['status'], environment, capture.io)).resolves.toBe(CLI_EXIT_FAILURE)
    expect(capture.stdout()).toBe('')
    expect(capture.stderr()).toBe(
      'CODEX_AUTH_STORAGE_INVALID: Credential storage could not be read.\n',
    )
    expect(capture.stderr()).not.toContain(sentinel)
  })

  it.each([
    [{ state: 'signed-out' }, CLI_EXIT_EXPECTED_NEGATIVE, 'Signed out.\n'],
    [
      { state: 'signed-in', refreshExpected: false },
      CLI_EXIT_SUCCESS,
      'Signed in. The local access token is fresh.\n',
    ],
    [
      { state: 'signed-in', refreshExpected: true },
      CLI_EXIT_SUCCESS,
      'Signed in. Authentication will refresh on the next model request.\n',
    ],
    [
      { state: 'invalid-storage', code: 'CODEX_AUTH_STORAGE_INVALID' },
      CLI_EXIT_FAILURE,
      'Credential storage is invalid. Run doctor for safe details.\n',
    ],
    [
      { state: 'insecure-storage', code: 'CODEX_AUTH_STORAGE_INSECURE' },
      CLI_EXIT_FAILURE,
      'Credential storage is insecure. Run doctor for safe details.\n',
    ],
  ] as const)('renders local status %#', async (status, exitCode, expectedOutput) => {
    const testFixture = fixture({ status })
    const capture = captureIo()

    await expect(runCli(['status'], testFixture.environment, capture.io)).resolves.toBe(exitCode)
    expect(capture.stdout()).toBe(expectedOutput)
    expect(capture.stderr()).toBe('')
    expect(testFixture.auth.statusCalls).toBe(1)
    expect(testFixture.auth.resolveCalls).toBe(0)
    expect(testFixture.counters).toEqual({ inspect: 0, runtime: 0, catalog: 0 })
  })

  it('writes exactly one StatusReportV1 JSON document', async () => {
    const testFixture = fixture({
      status: { state: 'signed-in', refreshExpected: true },
    })
    const capture = captureIo()

    await expect(runCli(['status', '--json'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_SUCCESS,
    )
    expect(capture.stdout()).toBe(
      '{"schemaVersion":1,"package":{"name":"dsh-codex-sub","version":"1.2.3-test"},'
      + '"provider":"openai-codex","status":{"state":"signed-in","refreshExpected":true}}\n',
    )
    expect(JSON.parse(capture.stdout())).toEqual({
      schemaVersion: 1,
      package: { name: 'dsh-codex-sub', version: PACKAGE_VERSION },
      provider: 'openai-codex',
      status: { state: 'signed-in', refreshExpected: true },
    })
    expect(capture.stdout().trim().split('\n')).toHaveLength(1)
    expect(capture.stderr()).toBe('')
  })

  it('writes one deterministic DoctorReportV1 document without auth or network work', async () => {
    const testFixture = fixture()
    const capture = captureIo()

    await expect(runCli(['doctor', '--json'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_SUCCESS,
    )
    const report: unknown = JSON.parse(capture.stdout())
    expect(report).toEqual({
      schemaVersion: 1,
      overall: 'compatible',
      package: { name: 'dsh-codex-sub', version: PACKAGE_VERSION },
      runtime: {
        platform: {
          supported: ['darwin', 'linux'],
          installed: 'linux',
          status: 'compatible',
        },
        node: {
          supported: '^22.19.0 || ^24.0.0 || ^26.0.0',
          installed: '^22.19.0 || ^24.0.0 || ^26.0.0',
          status: 'compatible',
        },
        packages: {
          '@deepseek-ai/cordis': {
            supported: '4.0.1',
            installed: '4.0.1',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-llm': {
            supported: '0.1.1-rc.1',
            installed: '0.1.1-rc.1',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-llm-pi-ai': {
            supported: '0.1.1-rc.1',
            installed: '0.1.1-rc.1',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-attachment': {
            supported: '0.1.1-rc.1',
            installed: '0.1.1-rc.1',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-atomic-write': {
            supported: '0.1.1-rc.1',
            installed: '0.1.1-rc.1',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-home-paths': {
            supported: '0.1.1-rc.1',
            installed: '0.1.1-rc.1',
            status: 'compatible',
          },
          '@earendil-works/pi-ai': {
            supported: '0.82.1',
            installed: '0.82.1',
            status: 'compatible',
          },
        },
      },
      credentialStore: { state: 'present', formatVersion: 1, permissions: 'owner-only' },
      catalog: { provider: 'openai-codex', modelCount: 7 },
      hints: [],
    })
    expect(capture.stdout().trim().split('\n')).toHaveLength(1)
    expect(capture.stderr()).toBe('')
    expect(testFixture.counters).toEqual({ inspect: 1, runtime: 1, catalog: 1 })
    expect(testFixture.auth.loginCalls).toBe(0)
    expect(testFixture.auth.statusCalls).toBe(0)
    expect(testFixture.auth.resolveCalls).toBe(0)
    expect(testFixture.auth.logoutCalls).toBe(0)
  })

  it('returns an expected-negative result for an incompatible doctor report', async () => {
    const incompatible = compatibleRuntime()
    const runtime: RuntimeCompatibilityReport = {
      ...incompatible,
      compatible: false,
      node: {
        supported: '^22.19.0 || ^24.0.0 || ^26.0.0',
        installed: '23.0.0',
        status: 'incompatible',
      },
    }
    const testFixture = fixture({ runtime })
    const capture = captureIo()

    await expect(runCli(['doctor'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_EXPECTED_NEGATIVE,
    )
    expect(capture.stdout()).toContain('Overall: incompatible\n')
    expect(capture.stderr()).toBe('')
  })

  it('logs in through the interaction, hides secret answers, and closes prompts', async () => {
    const secret = `CODE_SENTINEL_${randomUUID()}`
    const promptReader = new PromptProbe([secret])
    const testFixture = fixture({ promptReader })
    testFixture.auth.loginOperation = async (interaction) => {
      interaction.notify({ type: 'progress', message: 'Waiting for browser authorization.' })
      await expect(interaction.prompt({
        type: 'manual_code',
        message: 'Authorization code',
      })).resolves.toBe(secret)
    }
    const capture = captureIo()

    await expect(runCli(['login'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_SUCCESS,
    )
    expect(capture.stdout()).toBe('Waiting for browser authorization.\nSigned in.\n')
    expect(capture.stdout()).not.toContain(secret)
    expect(capture.stderr()).toBe('')
    expect(promptReader.calls[0]?.options.hidden).toBe(true)
    expect(promptReader.closeCalls).toBe(1)
  })

  it('settles login cancellation, closes prompts, and exits 4', async () => {
    const promptReader = new PromptProbe()
    const testFixture = fixture({ promptReader })
    testFixture.auth.loginOperation = async (_interaction, signal) => new Promise<void>(
      (_resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new DOMException('provider detail', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () => {
          reject(new DOMException('provider detail', 'AbortError'))
        }, { once: true })
      },
    )
    const capture = captureIo()
    const controller = new AbortController()

    const pending = runCli(['login'], testFixture.environment, capture.io, controller.signal)
    controller.abort()

    await expect(pending).resolves.toBe(CLI_EXIT_CANCELLED)
    expect(capture.stdout()).toBe('')
    expect(capture.stderr()).toBe('Login cancelled.\n')
    expect(promptReader.closeCalls).toBe(1)
  })

  it('prints only safe fixed failures and closes login prompts', async () => {
    const sentinel = `REFRESH_SENTINEL_${randomUUID()}`
    const promptReader = new PromptProbe()
    const testFixture = fixture({ promptReader })
    testFixture.auth.loginOperation = async () => {
      throw new CodexError('ChatGPT/Codex login failed.', 'CODEX_AUTH_LOGIN_FAILED', {
        cause: new Error(sentinel),
      })
    }
    const capture = captureIo()

    await expect(runCli(['login'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_FAILURE,
    )
    expect(capture.stdout()).toBe('')
    expect(capture.stderr()).toBe('CODEX_AUTH_LOGIN_FAILED: ChatGPT/Codex login failed.\n')
    expect(capture.stderr()).not.toContain(sentinel)
    expect(promptReader.closeCalls).toBe(1)
  })

  it('logs out idempotently through the semantic auth service', async () => {
    const testFixture = fixture()
    const first = captureIo()
    const second = captureIo()

    await expect(runCli(['logout'], testFixture.environment, first.io)).resolves.toBe(
      CLI_EXIT_SUCCESS,
    )
    await expect(runCli(['logout'], testFixture.environment, second.io)).resolves.toBe(
      CLI_EXIT_SUCCESS,
    )
    expect(testFixture.auth.logoutCalls).toBe(2)
    expect(first.stdout()).toBe('Signed out.\n')
    expect(second.stdout()).toBe('Signed out.\n')
    expect(first.stderr()).toBe('')
    expect(second.stderr()).toBe('')
  })

  it('keeps generated credential and path sentinels out of failed JSON command output', async () => {
    const sentinels = [
      `ACCESS_SENTINEL_${randomUUID()}`,
      `REFRESH_SENTINEL_${randomUUID()}`,
      `ACCOUNT_SENTINEL_${randomUUID()}`,
      `CODE_SENTINEL_${randomUUID()}`,
      `VERIFIER_SENTINEL_${randomUUID()}`,
      `CHALLENGE_SENTINEL_${randomUUID()}`,
      `/PATH_SENTINEL_${randomUUID()}/auth.json`,
    ]
    const testFixture = fixture()
    testFixture.auth.statusError = new CodexError(
      'Credential storage could not be read.',
      'CODEX_AUTH_STORAGE_INVALID',
      { cause: new Error(sentinels.join(' ')) },
    )
    const capture = captureIo()

    await expect(runCli(['status', '--json'], testFixture.environment, capture.io)).resolves.toBe(
      CLI_EXIT_FAILURE,
    )
    expect(capture.stdout()).toBe('')
    expect(capture.stderr()).toBe(
      'CODEX_AUTH_STORAGE_INVALID: Credential storage could not be read.\n',
    )
    for (const sentinel of sentinels) {
      expect(`${capture.stdout()}\n${capture.stderr()}`).not.toContain(sentinel)
    }
  })
})
