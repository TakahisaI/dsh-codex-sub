# Testing strategy

## 1. Test layers

### 1.1 Pure unit tests

Cover:

- JSON-safe value validation;
- credential document encode/decode;
- schema-version rejection;
- file-size, depth, key-count, and string-length limits;
- auth status projection;
- error-code construction;
- redaction;
- compatibility evaluation;
- CLI argument parsing and exit-code selection.

These tests have no DSH, pi-ai, network, or real filesystem dependency unless the subject is the file
vault.

### 1.2 File-vault tests

Use a temporary DSH home.

Required cases:

- missing document;
- valid read/write/delete;
- parent directory and file modes;
- insecure POSIX mode rejection;
- directory symlink rejection;
- document symlink rejection;
- malformed JSON;
- unsupported schema version;
- oversized document;
- atomic replacement leaves either old or new valid content after simulated failure;
- two concurrent modifies serialize;
- modify and logout serialize;
- callback rejection leaves the original document unchanged;
- clone-on-read prevents caller mutation from changing stored state.

Platform-specific expectations must be explicit. POSIX permission assertions may be skipped on
Windows, but Windows behavior still needs storage and concurrency coverage.

### 1.3 pi-ai auth contract tests

Test only published behavior at the pinned version.

Inject a fake provider with OAuth behavior equivalent to the public contract and verify:

- login persists through `CredentialStore.modify()`;
- request auth refreshes a credential that expires inside the 30-second skew under `modify()`;
- simultaneous request-auth calls on one service share one same-generation refresh;
- cancelling one waiter does not invalidate the refresh for another waiter;
- the service deadline releases the writer even when provider refresh does not settle;
- real file-vault tests cover one service instance, multiple service instances that cross the
  upstream lock wait deadline, and logout serialization;
- lock contention recovery reuses an externally refreshed credential and never removes the lock;
- `undefined` from a modify callback leaves the credential unchanged;
- deadline and unclassified refresh failures use `CODEX_AUTH_REFRESH_FAILED` without leaking the
  cause or being mislabeled as requiring login;
- no test infers `invalid_grant` by parsing an upstream exception message;
- provider-specific JSON fields round-trip through the project document;
- request auth contains the access token only in the internal return value.

Add one focused contract test using the real `openaiCodexProvider()` object without network I/O:

- provider ID is `openai-codex`;
- an OAuth auth method exists;
- catalog models are non-empty;
- the explicit request-auth wrapper accepts the plugin-supplied token and does not use ambient keys.
- unsupported `ModelAuth` fields fail instead of being discarded.

If the real provider cannot be tested without network I/O, isolate the untestable line and document
it as a manual compatibility check rather than mocking undocumented internals.

### 1.4 DSH registration-path spike

Mount a minimal Cordis context with the pinned public DSH LLM runtime and a fake `LlmAdapter`.

Verify:

- `registerAdapter()` exposes provider and fake model metadata through the public LLM registry;
- the configurable-provider directory remains empty;
- the package-name namespace has no model-discovery registration;
- duplicate registration and disposal preserve the serving route atomically;
- effect disposal removes the serving route and emits the expected topology update;
- the bundle manifest contains exactly one canonical insert row addressed to the built package root.

The test does not claim global discovery absence while DSH publishes no discovery-namespace list.
The absence of settings, Web, search, tool, session, and agent-loop registration is a structural
plugin-boundary review because those services are not mounted by the fixture. Milestone 6 adds the
packed Host registry probe and manual ordinary-selector check described below.

### 1.5 DSH adapter contract tests

Mount a minimal Cordis context with DSH's LLM runtime and a fake pi-ai provider factory.

Verify:

- registration owns exactly `openai-codex`;
- duplicate route registration fails with `CODEX_PROVIDER_CONFLICT`;
- provider display name is correct;
- model list comes from the provider catalog;
- text stream maps correctly through DSH `PiAiAdapter`;
- reasoning metadata is preserved;
- tool-call argument deltas remain raw JSON fragments;
- usage occurs before finish and nothing occurs after finish;
- abort propagates;
- stream idle timeout propagates;
- unsupported DSH options fail rather than disappear;
- replay state survives an allowed continuation or degrades through DSH's documented path;
- image input uses DSH attachments only when the model advertises image support.
- the request signal reaches attachment reads even though the pinned adapter omits it, and combines
  with a future attachment-operation signal when both are present;
- auth-required and reauth-required codes survive the public DSH stream boundary;
- unknown models and unsupported stop/reasoning options perform no auth resolution on the direct
  adapter path;
- each valid request lazily resolves auth exactly once after DSH preflight;
- a project error raised after auth and the explicit-token marker both retain their `CODEX_` code
  through the public DSH stream boundary;
- the OAuth-only provider wrapper cannot send its internal configured marker and never reads an
  ambient credential;
- duplicate-route translation works with a structurally compatible Host error;
- exact runtime mismatches fail before registration without exposing resolved package paths.
- unsupported operating systems fail before registration, and doctor exposes the platform plus
  every package check used by its overall compatibility result.

Do not re-test every internal behavior of DSH `PiAiAdapter`; pin only the behaviors on which this
plugin relies.

After the normal source tests, build the package root and mount that emitted module in the same
minimal Cordis/LLM composition. The built-entry check must observe the real provider catalog and
complete effect disposal without OAuth or model network traffic.

### 1.6 CLI tests

Capture stdout and stderr separately.

- `status --json` emits exactly one schema-valid JSON document;
- signed-out exits 1 without an error stack;
- `doctor --json` is deterministic and offline;
- invalid args exit 2;
- cancelled login exits 4;
- human-readable commands contain no raw JSON secrets;
- every secret sentinel is absent from stdout and stderr.
- every published pi-ai notification and prompt form is handled;
- authorization destinations reject non-HTTPS, userinfo, malformed, and control-character input
  before output;
- secret and manual-code input is returned to the auth flow without terminal echo;
- status and doctor do not call request-auth resolution, login, refresh, or model I/O;
- help and version do not construct production auth, vault, or prompt dependencies;
- lazy production dependency failures use the fixed safe printer;
- the emitted executable prints the package version and exits even when another active handle
  remains after the command settles.

### 1.7 Package tests

Build and pack the package, then inspect the tarball.

Release validation creates the candidate tarball once. Every platform job uses
`test:packed-install -- --package-tarball <absolute-path>` so the driver validates and installs the
downloaded bytes without rebuilding or repacking the package. The probe remains locally generated
test instrumentation. A capture that exceeds its stdout/stderr limit fails the gate because an
incomplete transcript cannot prove that secret sentinels stayed out of output. A complete capture
whose final byte exactly meets the limit remains valid. See ADR 0013.

The tarball should contain only intended runtime files and documentation. It must not contain:

- source maps with local paths unless deliberately approved;
- tests or fixtures;
- `.env` files;
- auth files;
- development prompts;
- Git metadata;
- temporary build output.

Install the tarball into a temporary DSH profile and verify:

1. `dsh plugin --profile web add <tarball>` succeeds in a fresh DSH home.
2. `dsh --profile web --dump-config` contains one `llm-codex-sub` row and one package bundle layer.
3. The six direct DSH/Cordis peers resolve to the parent Host, not profile-root copies.
4. The Host and plugin pi-ai copies are distinct, pinned to the same version, and interoperate.
5. Every peer required by the Host's DSH pi-ai adapter resolves from the Host.
6. DSH Web boots while signed out and the live provider/catalog seam used by the selector contains
   one provider and a non-empty, unique model list.
7. A signed-out route call returns `CODEX_AUTH_REQUIRED` while a blocked `fetch` records no network
   attempt.
8. The packaged `status --json` and `doctor --json` commands run from the profile.
9. Removing the package removes its bundle row and executable but preserves byte-identical package
   credentials.
10. Reinstalling the same tarball reuses the credential, and logout removes only `auth.json` while
    preserving another package-directory file.

The install smoke uses generated fake credentials and no real OAuth request. The ordinary DSH Web
model selector is also checked manually on the packed profile because DSH does not publish a UI
test seam for that consumer.

## 2. Secret-sentinel gate

Each relevant suite creates values such as:

```text
ACCESS_SENTINEL_<random>
REFRESH_SENTINEL_<random>
ACCOUNT_SENTINEL_<random>
CODE_SENTINEL_<random>
```

After the test, scan:

- captured stdout/stderr;
- logger buffers;
- serialized diagnostics;
- error messages and stacks;
- snapshots;
- temporary non-auth files;
- test reports.

Any occurrence is a test failure.

## 3. Manual real-account smoke test

Run only on a maintainer-controlled machine. Never store output in CI artifacts.
Use [`alpha-smoke-record.md`](alpha-smoke-record.md) and record only the candidate identity plus
`PASS`, a sanitized issue reference, or a justified `DEFERRED` result for each step.

1. Install a packed prerelease into a fresh DSH profile.
2. Run the package login command and complete ChatGPT OAuth.
3. Confirm `status --json` reports signed in without account data.
4. Start DSH and select an `openai-codex` model.
5. Send a plain text request.
6. Run one harmless DSH-owned tool flow requiring an approval.
7. Cancel an in-flight response.
8. Restart DSH and resume the same session.
9. Allow the access token to require refresh or use a controlled expired fixture if upstream permits.
10. Logout and confirm the next request returns a clear auth-required error.

Record only pass/fail and package/runtime versions.

## 4. CI matrix

Blocking CI:

- Ubuntu packed install on Node 22.19, 24, and 26;
- macOS packed install on Node 22.19, 24, and 26;
- the supported DSH release;
- the exact supported pi-ai release.

Blocking CI builds one candidate on Ubuntu/Node 24 and uploads its tarball plus `SHA256SUMS` once.
All six packed-install cells download, checksum, validate, and install those same bytes without a
package build or repack. The release-state check derives the exact six-cell matrix from
`compatibility.json` and rejects drift in either active CI or the disabled release workflow.

Unit tests reject relative or symbolic-link tarballs, oversized files, allowlist drift, duplicate
archive paths, extra artifact entries, checksum or filename mismatch, stdout or stderr capture
overflow, missing or extra matrix cells in block or flow style, and rebuilds or direct repacks in
artifact-consumer and candidate-ready jobs. The release workflow contract also rejects publication
and OIDC write permission before trusted publishing is enabled. Tests locate either the disabled or
enabled release-workflow filename so the activation rename cannot bypass or break this gate. The
active CI handoff remains the cross-platform integration proof for the operating-system archive and
artifact clients.

Windows is not a first-alpha target because the current vault cannot verify owner-only ACLs there.

Non-blocking scheduled canaries:

- DSH default branch;
- latest pi-ai release;
- pi-ai default branch when practical.

Canaries open an issue or dependency PR. They never publish.

## 5. Release gates

A release is blocked unless:

- all unit, contract, CLI, and package tests pass;
- packed install passes on every supported Node line;
- Linux, macOS, manual smoke, and publication consume the same checksum-verified candidate tarball;
- `compatibility.json`, package peer dependencies, and doctor expectations agree;
- secret-sentinel scan passes;
- dependency review passes;
- manual smoke is recorded for a release that changes OAuth, pi-ai, or DSH integration;
- known limitations and compatibility are updated.
