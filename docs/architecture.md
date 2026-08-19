# Architecture

## 1. Architectural objective

The plugin must place a ChatGPT-authenticated Codex model behind DSH's ordinary LLM seam without
introducing a second agent runtime.

```text
DSH agent loop
  ├─ session log
  ├─ prompt assembly
  ├─ tool schemas and execution
  ├─ permissions and approvals
  ├─ attachments
  ├─ compaction and recovery
  └─ ctx.llm
        └─ dsh-codex-sub adapter
              └─ DSH PiAiAdapter
                    └─ pi-ai openai-codex provider
                          └─ request-scoped OAuth access token
```

DSH remains authoritative for every model-visible and durable behavior above `ctx.llm`. The plugin
owns only authentication, provider construction, compatibility, and diagnostics.

## 2. Why this design

A direct `LlmAdapter` implementation would require the project to maintain DSH message conversion,
stream ordering, tool-call fragments, replay state, reasoning metadata, image attachment conversion,
timeouts, and cancellation. DSH already publishes `PiAiAdapter` for that boundary. Reusing it keeps
the plugin thin and lets DSH evolve its own model-visible contract.

A Codex App Server or MCP integration would create a delegated Codex agent whose thread, tools,
approvals, and compaction are Codex-owned. That violates the product requirement that DSH own the
agent loop. App Server is therefore outside the core architecture.

Reading Codex CLI credentials would bind the plugin to another application's private persistence
format and lifecycle. The plugin instead owns a separate credential document.

## 3. Components

### 3.1 Core contracts

Pure TypeScript definitions for:

- stable IDs;
- error codes;
- auth status projections;
- JSON-safe values;
- diagnostic reports;
- compatibility reports.

This layer has no runtime dependency on DSH, pi-ai, React, or the filesystem.

### 3.2 Credential document codec

A pure codec converts between unknown JSON and a versioned project-owned document.

The stored schema must not be the pi-ai `OAuthCredential` shape. Known fields use project-owned
names, while provider-specific JSON is preserved in a bounded `providerData` object.

```json
{
  "schemaVersion": 1,
  "provider": "openai-codex",
  "credential": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 0,
    "providerData": {}
  }
}
```

The document contains no display metadata, email address, plan name, usage, or history.

### 3.3 File credential vault

`FileCredentialVault` owns:

- `$DSH_HOME/dsh-codex-sub/auth.json`;
- owner-only directory and file modes where supported;
- symlink rejection;
- bounded reads;
- atomic writes;
- cross-process read-modify-write locking;
- clone-on-read and clone-on-return;
- logout deletion.

The first implementation uses DSH's published atomic-write and home-path utilities, isolated in
`src/storage/**` so they can be replaced later. POSIX reads reject symbolic links at the final
document component with both metadata inspection and `O_NOFOLLOW`; Windows reports owner-only ACL
verification as unsupported while retaining bounded reads and writer serialization.

### 3.4 pi-ai credential-store adapter

`PiAiCredentialStore` implements pi-ai's published `CredentialStore` contract over the project vault.
It converts between the project document and pi-ai's OAuth credential type.

Its `modify()` implementation is the critical concurrency seam: the callback runs under the same
cross-process lock used by logout, returns `undefined` to leave the credential unchanged, and
resolves with the post-operation credential.

### 3.5 Codex authentication service

`CodexAuthService` owns one pi-ai `Models` collection configured with:

- the project credential-store adapter;
- exactly one provider created by the published `openaiCodexProvider()` factory.

It exposes only semantic operations:

- begin/complete login through an `AuthInteraction`;
- read local status without network access;
- resolve request auth, allowing pi-ai to refresh under the store lock;
- logout.

At the pinned pi-ai version, `Models.getAuth()` has no public cancellation input. Request-auth
resolution therefore composes the provider's published `OAuthAuth.refresh()` and
`OAuthAuth.toAuth()` methods with `CredentialStore.modify()` directly. This preserves cancellation
without moving refresh outside the vault lock; see ADR 0007.

It never exposes stored credentials as a public API. The DSH integration receives only a
request-scoped bearer token through an internal method.

### 3.6 DSH provider integration

The DSH layer creates one `PiAiAdapter` profile for `openai-codex`.

Responsibilities:

- preserve the pi-ai provider's model catalog and wire implementation;
- adapt explicit OAuth access tokens to the request auth mechanism expected by `PiAiAdapter`;
- reject ambient API-key fallback;
- expose provider display metadata;
- resolve DSH attachments at request time;
- use DSH's retry policy and stream timeout contracts;
- register exactly one provider route;
- report route collisions clearly.

The request-auth provider wrapper may add an api-key-style explicit override to the provider's auth
surface while preserving its OAuth capability. The wrapper must accept only the explicit token
supplied by this plugin; it must not discover `OPENAI_API_KEY` or other ambient keys.

The exact wrapper is verified by a contract test against the pinned pi-ai version rather than by
relying on undocumented internals.

### 3.7 Cordis plugin entry

The plugin entry is intentionally small:

1. verify supported runtime versions;
2. construct the vault and auth service;
3. construct the DSH adapter;
4. register `openai-codex` on `ctx.llm`;
5. rely on Cordis effect disposal for unregistration.

There is no Web server injection, settings card, search service, tool registration, or session
event registration.

### 3.8 CLI

The package publishes a `dsh-codex-sub` executable.

Commands:

```text
dsh-codex-sub login
dsh-codex-sub logout
dsh-codex-sub status [--json]
dsh-codex-sub doctor [--json]
dsh-codex-sub version
```

When installed in a profile, the expected invocation is:

```sh
dsh plugin --profile web exec dsh-codex-sub login
```

`login` is interactive. `status` and `doctor` are deterministic and secret-free. `doctor` performs
no network call unless a future explicitly named probe flag is added.

## 4. Request lifecycle

```text
DSH prepares immutable call
    │
    ▼
PiAiAdapter captures provider/model profile
    │
    ▼
CodexAuthService.resolveRequestAuth()
    │
    ├─ credential missing → CODEX_AUTH_REQUIRED
    ├─ token fresh → derive request auth
    └─ token expired → CredentialStore.modify() under file lock
                           ├─ refresh succeeds → atomic write
                           └─ refresh fails → CODEX_REAUTH_REQUIRED
    │
    ▼
freeze token for this request
    │
    ▼
pi-ai openai-codex stream
    │
    ▼
DSH PiAiAdapter converts stream to DSH StreamChunk
```

A credential or dependency update that occurs after request auth is resolved affects the next model
request, never the one in flight.

## 5. Model catalog behavior

- The plugin does not hard-code model IDs.
- The pinned pi-ai provider catalog is authoritative for model IDs, names, context windows,
  modalities, and reasoning efforts.
- The plugin does not add unknown models through configuration.
- The plugin does not override model capacities.
- Model access remains account- and upstream-dependent even when a model appears in the catalog.
- A pi-ai update that changes the catalog is reviewed as a compatibility change.

## 6. Configuration

The first release has no user-editable runtime configuration. Constants such as the provider route
and stream timeout are project-owned and tested.

This is deliberate. A configuration surface is added only after a real deployment need exists and
an ADR defines ownership, validation, and compatibility semantics.

The plugin never selects a DSH default model. Users do so through DSH's existing profile/settings
mechanism.

## 7. Extensibility

Future changes should prefer separate packages or narrow ports:

- OS keychain storage can implement the credential-vault interface.
- A minimal account UI can consume semantic auth operations through a separately designed Host/Client
  service without gaining token access.
- Optional request policies can be introduced through a typed registry if a real requirement such
  as a service tier appears.
- A delegated Codex agent belongs in a separate App Server/MCP package.

Search, image-fetching, usage, and quota features are not natural extensions of the core provider
and should remain separate even if implemented later.

## 8. Public exports

Keep package exports minimal:

```text
.                    Cordis plugin entry and stable constants
./cli                 executable implementation only if required by build
./compatibility.json  machine-readable supported combination
./package.json        package metadata
```

Do not export credential classes, token-resolving services, pi-ai provider wrappers, or DSH adapter
construction internals from the package root.
