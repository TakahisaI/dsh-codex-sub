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

Status is local and offline. It must not claim that the upstream session is valid. A local access
token that is expired or expires within 30 seconds reports `signed-in` with
`refreshExpected: true`; the next model request performs the refresh. Known storage failures project
to the two storage states; an unexpected programming or runtime failure rejects instead of being
mislabeled as invalid storage.

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
Request-auth refresh uses a 30-second pre-expiry window and is bounded to 30 seconds. Concurrent
callers in one service instance share a flight for the same credential generation. A caller's
cancellation ends only that caller's wait; the shared deadline releases the credential lock even
when the pinned provider does not settle its refresh promise. Safe file-lock contention is retried
while the credential remains stale and the shared deadline remains open. The current request-auth
projection accepts only the exact access-token `apiKey`; additional upstream auth fields fail
explicitly.
Do not export `CodexRequestAuth` from the package root.

## 7. DSH request integration

The internal DSH adapter resolves `CodexAuthService.resolveRequestAuth(options.signal)` exactly once
when the stream is first consumed. The returned bearer token is retained only by that request-local
delegate and is never stored in provider metadata or a public service. Missing or refresh-required
authentication reaches the DSH failure vocabulary with its stable `CODEX_` code before provider
I/O.

The fixed provider profile uses the pi-ai catalog, DSH's normal retry policy, and a 300-second stream
idle timeout. Unsupported reasoning effort and content combinations remain DSH/pi-ai failures; the
plugin does not clamp or discard them.

`CodexDshAdapter.stream()` is a single provider attempt. The package exposes the retry policy but
does not install or execute a retry loop. When the Host loads DSH's retry plugin, every eligible
repeat calls `resolveRequestAuth()` once again, while failed partial output remains outside derived
message history and tool acceptance. At the pinned DSH version the durable retry records stay in
the same turn and step. Status-bearing 429/5xx and recognized transport/timeout failures use DSH's
finite normal policy; an unclassified overload remains a bounded, non-retried `PI_AI_ERROR`.

## 8. Error shape

```ts
export type CodexErrorCode =
  | 'CODEX_AUTH_REQUIRED'
  | 'CODEX_REAUTH_REQUIRED'
  | 'CODEX_AUTH_REFRESH_FAILED'
  | 'CODEX_AUTH_STORAGE_INVALID'
  | 'CODEX_AUTH_STORAGE_INSECURE'
  | 'CODEX_AUTH_LOGIN_FAILED'
  | 'CODEX_PROVIDER_CONFLICT'
  | 'CODEX_INCOMPATIBLE_RUNTIME'
  | 'CODEX_UPSTREAM_PROTOCOL'

export class CodexError extends Error {
  readonly code: CodexErrorCode
  readonly safeDetails?: Readonly<Record<string, JsonPrimitive>>
}
```

`message` and `safeDetails` must be safe to print. Causes remain internal and are passed to DSH where
supported without serializing their contents. `safeDetails` is a detached, frozen, flat record of
JSON primitives. Nested objects and arrays are intentionally rejected so callers cannot mutate a
diagnostic after error construction or hide an unbounded secret-bearing object behind a shallow
freeze.

`CODEX_AUTH_REFRESH_FAILED` means refresh did not produce a usable credential but the public
upstream contract did not prove that interactive login is required. Its safe `reason` distinguishes
`deadline` and `provider_unclassified` without inspecting an upstream exception message.
`CODEX_REAUTH_REQUIRED` is reserved for an explicitly classified permanent authentication
rejection.

## 9. CLI JSON

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

export interface PlatformCheck {
  readonly supported: readonly string[]
  readonly installed: string
  readonly status: 'compatible' | 'incompatible'
}

export interface VersionCheck {
  readonly supported: string
  readonly installed: string | null
  readonly status: 'compatible' | 'incompatible' | 'unknown'
}
```

`runtime.packages` contains exactly every DSH, Cordis, and pi-ai package version checked by the
runtime compatibility guard, keyed by its published package name. For the first Alpha these are
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`,
`@deepseek-ai/dsh-attachment`, `@deepseek-ai/dsh-atomic-write`,
`@deepseek-ai/dsh-home-paths`, and `@earendil-works/pi-ai`. The order is deterministic and follows
`compatibility.json`; the CLI does not maintain a smaller diagnostic subset.

Reports never include an absolute path, account identifier, token expiry timestamp, email address,
plan name, authorization URL, or credential contents.

Doctor classifies an unsupported operating system or known version mismatch as `incompatible`,
missing version metadata as `unknown`, and a locally unhealthy credential store, unverifiable
permissions on a present credential, or an empty catalog as `degraded`. An absent credential can
still be `compatible` and adds a bounded login hint; `status` owns the signed-in/signed-out result.
See ADR 0012.

## 10. CLI exit codes

```text
0  success / signed in / compatible
1  expected negative state (signed out, or any doctor result other than compatible)
2  invalid command-line usage
3  storage or runtime failure
4  login cancelled
```

Document any later exit-code addition before release.
