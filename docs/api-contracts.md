# API contracts

These interfaces describe intent. Implementations must adapt them to the exact published types of
the pinned dependencies and record material mismatches in an ADR.

## 1. Stable constants

```ts
export const PACKAGE_NAME = 'dsh-codex-sub' as const
export const PLUGIN_NAME = 'llm-codex-sub' as const
export const PLUGIN_ROW_ID = 'llm-codex-sub' as const
export const PROVIDER_ID = 'openai-codex' as const
export const PROVIDER_DISPLAY_NAME = 'OpenAI Codex (ChatGPT)' as const
export const AUTH_DIRECTORY_NAME = 'dsh-codex-sub' as const
export const AUTH_FILENAME = 'auth.json' as const
```

## 2. JSON-safe data

```ts
export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
```

Reject non-finite numbers, dangerous object prototypes, excessive nesting, excessive keys, and
values above the configured byte budget.

## 3. Credential document

```ts
export interface CodexCredentialDocumentV1 {
  readonly schemaVersion: 1
  readonly provider: typeof PROVIDER_ID
  readonly credential: {
    readonly accessToken: string
    readonly refreshToken: string
    readonly expiresAt: number
    readonly providerData: JsonObject
  }
}

export type CodexCredentialDocument = CodexCredentialDocumentV1
```

Validation requirements:

- access and refresh tokens are non-empty bounded strings;
- `expiresAt` is a positive finite integer in milliseconds since Unix epoch;
- `providerData` contains the remaining JSON-safe provider fields;
- `providerData` may not shadow `type`, `access`, `refresh`, or `expires` during pi-ai conversion;
- top-level fields are exact;
- the encoded document stays below 64 KiB.

## 4. Credential vault

```ts
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
```

`modify` runs the operation under a cross-process lock. Returning `undefined` leaves the current
entry unchanged; deletion uses `delete()` only.

## 5. Auth status

```ts
export type CodexAuthStatus =
  | { readonly state: 'signed-out' }
  | { readonly state: 'signed-in'; readonly refreshExpected: boolean }
  | { readonly state: 'invalid-storage'; readonly code: string }
  | { readonly state: 'insecure-storage'; readonly code: string }
```

Status is local and offline. It must not claim that the upstream session is valid. An expired local
access token still reports `signed-in` with `refreshExpected: true`; the next model request performs
the refresh.

## 6. Authentication service

```ts
export interface CodexRequestAuth {
  readonly bearerToken: string
}

export interface CodexAuthService {
  login(interaction: unknown, signal?: AbortSignal): Promise<void>
  status(): Promise<CodexAuthStatus>
  resolveRequestAuth(signal?: AbortSignal): Promise<CodexRequestAuth>
  logout(): Promise<void>
}
```

The concrete pi-ai adapter narrows `interaction` to the published `AuthInteraction` type internally.
Do not export `CodexRequestAuth` from the package root.

## 7. Error shape

```ts
export type CodexErrorCode =
  | 'CODEX_AUTH_REQUIRED'
  | 'CODEX_REAUTH_REQUIRED'
  | 'CODEX_AUTH_STORAGE_INVALID'
  | 'CODEX_AUTH_STORAGE_INSECURE'
  | 'CODEX_AUTH_LOGIN_FAILED'
  | 'CODEX_PROVIDER_CONFLICT'
  | 'CODEX_INCOMPATIBLE_RUNTIME'
  | 'CODEX_UPSTREAM_PROTOCOL'

export class CodexError extends Error {
  readonly code: CodexErrorCode
  readonly safeDetails?: Readonly<Record<string, JsonValue>>
}
```

`message` and `safeDetails` must be safe to print. Causes remain internal and are passed to DSH where
supported without serializing their contents.

## 8. CLI JSON

All JSON commands emit exactly one JSON document to stdout and diagnostics to stderr only when the
command itself cannot produce its schema.

### `status --json`

```ts
export interface StatusReportV1 {
  readonly schemaVersion: 1
  readonly package: { readonly name: string; readonly version: string }
  readonly provider: typeof PROVIDER_ID
  readonly status: CodexAuthStatus
}
```

### `doctor --json`

```ts
export interface DoctorReportV1 {
  readonly schemaVersion: 1
  readonly overall: 'compatible' | 'incompatible' | 'degraded' | 'unknown'
  readonly package: { readonly name: string; readonly version: string }
  readonly runtime: {
    readonly node: VersionCheck
    readonly dshLlm: VersionCheck
    readonly dshPiAi: VersionCheck
    readonly piAi: VersionCheck
  }
  readonly credentialStore: CredentialVaultInspection
  readonly catalog: {
    readonly provider: typeof PROVIDER_ID
    readonly modelCount: number
  }
  readonly hints: readonly string[]
}

export interface VersionCheck {
  readonly supported: string
  readonly installed: string | null
  readonly status: 'compatible' | 'incompatible' | 'unknown'
}
```

Reports never include an absolute path, account identifier, token expiry timestamp, email address,
plan name, authorization URL, or credential contents.

## 9. CLI exit codes

```text
0  success / signed in / compatible
1  expected negative state (signed out, incompatible doctor result)
2  invalid command-line usage
3  storage or runtime failure
4  login cancelled
```

Document any later exit-code addition before release.
