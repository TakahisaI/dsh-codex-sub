import type {
  CodexAuthService,
  CodexCredentialVault,
} from '../core/contracts.js'
import type { RuntimeCompatibilityReport } from '../dsh/compatibility.js'

export interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export interface PromptReadOptions {
  readonly hidden: boolean
  readonly signal?: AbortSignal
}

export interface PromptReader {
  read(prompt: string, options: PromptReadOptions): Promise<string>
  close(): void
}

export interface CliEnvironment {
  readonly packageVersion: string
  readonly authService: CodexAuthService
  readonly credentialVault: Pick<CodexCredentialVault, 'inspect'>
  readonly inspectRuntime: () => RuntimeCompatibilityReport
  readonly catalogModelCount: () => number
  readonly promptReader: PromptReader
}
