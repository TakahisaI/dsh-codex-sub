import type { CodexCredentialDocument } from './credential-document.js'
import type { PROVIDER_ID } from './constants.js'
import type { CodexErrorCode } from './errors.js'

export interface CredentialVaultInspection {
  readonly state: 'absent' | 'present' | 'invalid' | 'insecure' | 'unreadable'
  readonly formatVersion?: number
  readonly permissions: 'owner-only' | 'insecure' | 'unsupported' | 'unknown'
}

export interface CodexCredentialVault {
  read(): Promise<CodexCredentialDocument | undefined>
  modify(
    operation: (
      current: CodexCredentialDocument | undefined,
    ) => Promise<CodexCredentialDocument | undefined>,
  ): Promise<CodexCredentialDocument | undefined>
  delete(): Promise<void>
  inspect(): Promise<CredentialVaultInspection>
}

export type CodexAuthStatus =
  | { readonly state: 'signed-out' }
  | { readonly state: 'signed-in'; readonly refreshExpected: boolean }
  | { readonly state: 'invalid-storage'; readonly code: CodexErrorCode }
  | { readonly state: 'insecure-storage'; readonly code: CodexErrorCode }

export interface CodexRequestAuth {
  readonly bearerToken: string
}

export interface CodexAuthService {
  login(interaction: unknown, signal?: AbortSignal): Promise<void>
  status(): Promise<CodexAuthStatus>
  resolveRequestAuth(signal?: AbortSignal): Promise<CodexRequestAuth>
  logout(): Promise<void>
}

export interface StatusReportV1 {
  readonly schemaVersion: 1
  readonly package: { readonly name: string; readonly version: string }
  readonly provider: typeof PROVIDER_ID
  readonly status: CodexAuthStatus
}

export interface VersionCheck {
  readonly supported: string
  readonly installed: string | null
  readonly status: 'compatible' | 'incompatible' | 'unknown'
}

export interface PlatformCheck {
  readonly supported: readonly string[]
  readonly installed: string
  readonly status: 'compatible' | 'incompatible'
}

export interface DoctorReportV1 {
  readonly schemaVersion: 1
  readonly overall: 'compatible' | 'incompatible' | 'degraded' | 'unknown'
  readonly package: { readonly name: string; readonly version: string }
  readonly runtime: {
    readonly platform: PlatformCheck
    readonly node: VersionCheck
    readonly packages: Readonly<Record<string, VersionCheck>>
  }
  readonly credentialStore: CredentialVaultInspection
  readonly catalog: {
    readonly provider: typeof PROVIDER_ID
    readonly modelCount: number
  }
  readonly hints: readonly string[]
}
