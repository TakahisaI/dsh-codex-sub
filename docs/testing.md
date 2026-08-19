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
- request auth refreshes an expired credential under `modify()`;
- simultaneous request-auth calls do not double-refresh;
- cancellation and the service deadline release the writer even when provider refresh does not
  settle;
- `undefined` from a modify callback leaves the credential unchanged;
- refresh failure is translated to `CODEX_REAUTH_REQUIRED` without leaking the cause;
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
plugin-boundary review because those services are not mounted by the fixture. End-to-end selector
visibility remains a Milestone 6 packed-install test.

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
- the request signal reaches attachment reads even though the pinned adapter omits it;
- auth-required and reauth-required codes survive the public DSH stream boundary;
- a project error raised after auth and the explicit-token marker both retain their `CODEX_` code
  through the public DSH stream boundary;
- the OAuth-only provider wrapper cannot send its internal configured marker and never reads an
  ambient credential;
- duplicate-route translation works with a data-shaped error from a distinct host package copy;
- exact runtime mismatches fail before registration without exposing resolved package paths.

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

The tarball should contain only intended runtime files and documentation. It must not contain:

- source maps with local paths unless deliberately approved;
- tests or fixtures;
- `.env` files;
- auth files;
- development prompts;
- Git metadata;
- temporary build output.

Install the tarball into a temporary DSH profile and verify:

1. `dsh plugin --profile <temp> add <tarball>` succeeds.
2. `dsh --profile <temp> --dump-config` contains one `llm-codex-sub` row.
3. DSH boots while signed out and exposes a clear auth-required failure only when the route is used.
4. The model catalog is visible through the DSH model-list seam.
5. Removing the package removes the bundle row.
6. Removing the package does not delete the package-owned credential file.

The install smoke uses no real OAuth request.

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

- Node 22.19;
- Node 24;
- Node 26;
- supported DSH release;
- exact supported pi-ai release.

Non-blocking scheduled canaries:

- DSH default branch;
- latest pi-ai release;
- pi-ai default branch when practical.

Canaries open an issue or dependency PR. They never publish.

## 5. Release gates

A release is blocked unless:

- all unit, contract, CLI, and package tests pass;
- packed install passes on every supported Node line;
- `compatibility.json`, package peer dependencies, and doctor expectations agree;
- secret-sentinel scan passes;
- dependency review passes;
- manual smoke is recorded for a release that changes OAuth, pi-ai, or DSH integration;
- known limitations and compatibility are updated.
