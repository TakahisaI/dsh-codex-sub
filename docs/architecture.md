# Architecture

The current implementation is the unpublished `0.1.0-alpha.2` candidate: DSH
`0.1.1-rc.1`, Cordis `4.0.1`, and pi-ai `0.82.1`. This combination is a candidate record, not a
public support or release-ready claim.

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
- resolve request auth, sharing same-generation refresh work under the store lock;
- logout.

At the pinned pi-ai version, `Models.getAuth()` has no public cancellation input and the published
Codex refresh operation does not settle a stalled fetch when its signal is aborted. Request-auth
resolution therefore composes `OAuthAuth.refresh()` and `OAuthAuth.toAuth()` with
`CredentialStore.modify()` directly. Callers share refresh by credential generation, caller
cancellation is waiter-local, and a separate coordinator enforces the 30-second deadline. Login
uses Models with safe storage-error recovery; logout deletes through the credential store directly.
See ADR 0007.

It never exposes stored credentials as a public API. The DSH integration receives only a
request-scoped bearer token through an internal method.

### 3.6 DSH provider integration

The DSH layer creates one immutable `PiAiAdapter` profile for `openai-codex`. Catalog operations use
one shared metadata delegate. A model request creates a request-local delegate whose lazy
`resolveApiKey` hook resolves OAuth exactly once with the DSH request signal, after DSH has resolved
the provider/model and rejected unsupported stop or reasoning options. The memoized hook returns
only that frozen token. This preserves cancellation during auth even though the pinned public hook
does not receive an `AbortSignal` itself. The request-local provider wrapper also records a project `CodexError`
before pi-ai can normalize it into a generic in-band failure, allowing the DSH boundary to retain
the stable `CODEX_` code without parsing error text.

Responsibilities:

- preserve the pi-ai provider's model catalog and wire implementation;
- adapt explicit OAuth access tokens to the request auth mechanism expected by `PiAiAdapter`;
- reject ambient API-key fallback;
- expose provider display metadata;
- resolve DSH attachments at request time;
- use DSH's retry policy and stream timeout contracts;
- register exactly one provider route;
- report route collisions clearly.

The adapter stream is deliberately one provider attempt. In an ordinary DSH agent session, the
Host's `dsh-llm-retry` policy may repeat a transient failure at the durable request-error boundary.
At the pinned DSH version those attempts remain inside one open turn and step, with separate
`llm/retry` records; failed chunks are log-only and only a successful assembled
`assistant/message` can make a tool call executable. Each repeated provider attempt resolves a
fresh request-scoped OAuth result exactly once. Direct `ctx.llm.stream()` consumers receive no
automatic retry. See ADR 0015.

The request-auth provider wrapper adds an api-key-style explicit override to the provider's auth
surface while preserving its OAuth capability. pi-ai requires an auth method to report configured
before applying a request override, so that method returns a fixed internal marker. The wrapper's
wire methods reject the marker and any missing token before calling the upstream provider. Only the
token supplied by this plugin can reach the provider; the wrapper never discovers `OPENAI_API_KEY`
or another ambient key and does not mutate the upstream provider object.

The published DSH package exports `PiAiAdapter` and its resolved profile type but not its profile
materialization helpers. The integration therefore constructs the single fixed profile directly
from public types, `resolveRetryPolicy()`, and the published Codex provider factory. It does not
import DSH source subpaths. The pinned adapter also omits the request signal when reading an image
attachment; a request-local `AttachmentStore` proxy supplies that signal without reimplementing
message or image conversion. See ADR 0008.

The exact wrapper is verified by a contract test against the pinned pi-ai version rather than by
relying on undocumented internals.

### 3.7 Cordis plugin entry

The emitted package root is intentionally small:

1. dynamically load the fixed sibling `runtime.mjs` module;
2. verify supported runtime versions and Host LLM identity;
3. construct the vault and auth service;
4. construct the DSH adapter;
5. register `openai-codex` on `ctx.llm`;
6. rely on Cordis effect disposal for unregistration.

The runtime guard reads the verified versions from `compatibility.json`, resolves installed package
metadata without exposing its paths, and fails closed before registration on a missing, unknown, or
mismatched Node/DSH/pi-ai combination. It also requires the injected LLM service to use the exact
published constructor resolved from the verified DSH package; plugin-local version metadata cannot
prove Host service identity by itself. The dynamic package root converts a missing or incompatible
runtime module into the same safe compatibility classification instead of allowing a static linker
failure to escape. A duplicate DSH route is translated from the public `DUPLICATE_ADAPTER` failure
to `CODEX_PROVIDER_CONFLICT` without changing the existing owner. The translation uses the public
own `code` data property rather than error-class identity.

The pinned DSH runtime exposes live provider metadata and the adapter-owned catalog through
`listProviders()` and `listModels()` after `registerAdapter()`. A Milestone 6 packed DSH Web profile
confirmed that the ordinary model selector consumes this live registry and displays the
provider-owned catalog under **OpenAI Codex (ChatGPT)**. The plugin therefore starts without a
configurable-provider directory or model-discovery namespace because it owns no user-editable
provider settings or dormant route. See ADR 0006.

The verified packed topology shares every direct DSH/Cordis peer with the parent Host and contains
two pi-ai copies at the same pinned version, one owned by the Host and one by this package. The
adapter boundary remains structural across those copies. The packed gate exercises a signed-out
request through that boundary and requires an auth failure before provider `fetch`. See ADR 0010.

There is no Web server injection, settings card, search service, tool registration, or session
event registration. This is a structural boundary of the production plugin, not a runtime claim
derived from checking services that the contract fixture never mounted.

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

The executable is a separate build entry and does not expand the package's public library exports.
It parses with Node's built-in `parseArgs` and composes the auth service, vault inspection, runtime
compatibility evaluator, and the pinned provider's in-memory catalog. It never constructs a DSH
agent. Production auth, vault, and prompt dependencies are lazy: help and version do not construct
them, while construction failures for operational commands stay inside the CLI's safe error
boundary. Once a command settles, the executable removes its SIGINT listener and waits until Node
reports no accepted bytes queued for stdout or stderr. `drain` and event-loop checks cover both
backpressured and below-threshold asynchronous writes under one shared one-second deadline. The
flush phase performs no write and does not close process-owned stdio, so a one-document consumer
may close after the newline without causing a new `EPIPE`. Successful flushing preserves the
selected command code; a stream failure or deadline emits no additional diagnostic and exits 3.
The executable then forces termination so a leaked upstream OAuth handle cannot keep it alive. See
ADR 0016.

`login` adapts pi-ai's published interaction events. It validates destinations as HTTPS URLs with
no user information, keeps a destination only for the next manual-code prompt, and asks for an
explicit empty Enter before invoking the fixed shell-free macOS/Linux default-browser opener.
Unsupported or failed launches fall back to manual opening without native error details. Secret and
manual-code prompts use non-echoing reads, and SIGINT aborts the interaction and pending prompt
resources.

`status` is local and offline. `doctor` is deterministic and secret-free: it uses bounded vault
inspection rather than a full credential read and performs no login, refresh, model request, or
network operation. JSON output is one `StatusReportV1` or `DoctorReportV1` document. See ADR 0009.

## 4. Request lifecycle

```text
DSH prepares immutable call
    │
    ▼
PiAiAdapter captures and validates provider/model profile
    │
    ├─ invalid model/options → DSH failure without OAuth work
    │
    ▼
lazy CodexAuthService.resolveRequestAuth() (memoized once)
    │
    ├─ credential missing → CODEX_AUTH_REQUIRED
    ├─ token fresh → derive request auth
    └─ token expires within 30s → join/create same-generation refresh flight
                                  └─ CredentialStore.modify() under file lock
                                     ├─ refresh succeeds → atomic write
                                     ├─ lock contention → bounded re-read/retry
                                     └─ unclassified/deadline failure
                                        → CODEX_AUTH_REFRESH_FAILED
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
bin                   dsh-codex-sub executable through the package manifest
./compatibility.json  machine-readable supported combination
./package.json        package metadata
```

Do not export credential classes, token-resolving services, pi-ai provider wrappers, or DSH adapter
construction internals from the package root.
