# Implementation plan

## Current candidate status

The worktree records an unpublished `0.1.0-alpha.2` candidate on DSH `0.1.1-rc.1`, Cordis
`4.0.1`, and pi-ai `0.82.1`. It is not release-ready and must not be described as public support
until the exact artifact and external release gates are completed.

Each milestone should be a separate PR unless the milestone is trivially small. Do not combine OAuth
and DSH integration in the same first implementation change.

## Milestone 0 — Repository foundation

Deliverables:

- select a project license or keep the package private and unlicensed (MIT selected);
- TypeScript ESM package setup;
- strict compiler configuration;
- build, typecheck, lint, test, and pack scripts;
- CI for supported Node versions;
- dependency review and automated update configuration;
- package file allowlist;
- compatibility consistency check scaffold.

Acceptance:

- `pnpm install --frozen-lockfile` works after lockfile creation;
- `pnpm run check` passes with the minimal source entry;
- `pnpm pack --dry-run` lists only intended files;
- no runtime feature exists yet.

## Milestone 1 — Pure contracts and credential codec

Deliverables:

- stable constants;
- JSON-safe value validator;
- `CodexError` and error codes;
- redaction helpers;
- credential document TypeScript types;
- strict versioned encode/decode;
- bounded input rules;
- auth status and diagnostic schemas;
- comprehensive pure unit tests.

Acceptance:

- no DSH or pi-ai runtime import in core modules;
- malformed, oversized, deep, non-finite, and shadowing provider data is rejected;
- generated secret sentinels never appear in errors;
- encode/decode round-trip is deterministic.

## Milestone 2 — File credential vault

Deliverables:

- DSH home resolution adapter;
- fixed package-owned directory and document path;
- symlink checks;
- owner-only permission checks;
- bounded read;
- atomic write;
- cross-process lock;
- `read`, `modify`, `delete`, and `inspect`;
- filesystem and concurrency tests.

Acceptance:

- concurrent refresh simulations serialize;
- logout cannot interleave with modify;
- failed callback leaves old state intact;
- insecure POSIX files fail closed;
- diagnostics reveal no path or secret.

## Milestone 3 — pi-ai authentication integration

Deliverables:

- project-document ↔ pi-ai OAuth credential conversion;
- `CredentialStore` implementation;
- `CodexAuthService`;
- login interaction adapter for terminal use;
- local status;
- request-auth resolution and refresh;
- logout;
- pi-ai contract tests with no real network.

Acceptance:

- provider-specific JSON fields round-trip;
- missing credentials fail before model network I/O;
- credentials inside the bounded pre-expiry window refresh under the vault lock;
- same-generation refresh is shared within one service and recovered safely across service
  instances after lock contention;
- caller cancellation, refresh deadline, and unclassified provider failure remain distinct and
  secret-safe;
- ambient OpenAI API keys are not consulted.

## Milestone 4 — DSH LLM integration

Deliverables:

- exact runtime compatibility guard;
- provider conflict check;
- explicit-token pi-ai provider wrapper;
- one `PiAiAdapter` profile;
- Cordis plugin entry;
- bundle patch;
- DSH adapter contract tests;
- public DSH registration-path spike and LLM-runtime contract test.

Acceptance:

- `openai-codex` is registered exactly once;
- model metadata comes from the provider catalog;
- DSH tools and approvals remain functional through a fake-provider integration test;
- request cancellation and replay behavior use DSH's adapter contract;
- no DSH Web, settings, search, or tool registration is added.

Verified decision:

The pinned DSH runtime exposes a live adapter's provider metadata and catalog through its public
registry after `registerAdapter()` alone. The spike does not exercise the actual model selector, so
Milestone 6 checked the ordinary selector through a packed DSH Web profile. The selector consumes
the live registry, so the first release omits a configurable-provider directory, settings
namespace, and browser card. See ADR 0006.

## Milestone 5 — CLI and diagnostics

Status: complete in the Milestone 5 implementation branch.

Deliverables:

- `dsh-codex-sub` executable;
- `login`, `logout`, `status`, `doctor`, and `version`;
- stable JSON schemas and exit codes;
- safe interactive auth URL/device-code handling according to pi-ai's published interaction events;
- CLI tests and secret-sentinel scans.

Acceptance:

- JSON commands write exactly one document to stdout;
- doctor is offline by default;
- login cancellation disposes timers/callbacks;
- no token, account ID, code, or raw stored document reaches output.

## Milestone 6 — Packaging and installation

Status: complete in the Milestone 6 implementation branch.

Deliverables:

- npm bundle manifest;
- built export map;
- tarball content verification;
- temporary-profile packed install test;
- packed model-selector visibility acceptance test;
- install, login, usage, logout, uninstall documentation;
- security and limitation documentation;
- release workflow enabled after the npm bootstrap decision was accepted; after the first real
  release established registry ownership, its final job was restricted to OIDC staging.

Acceptance:

- DSH installs the tarball as a bundle;
- dump-config shows one plugin row;
- DSH boots signed out;
- the provider appears in model discovery;
- uninstall leaves the package credential file untouched;
- logout removes only the package credential file.

Implementation evidence:

- the automated gate builds one real candidate tarball, distributes it to every packed-install
  cell, and packs only the Host probe locally in a fresh DSH Web profile;
- Ubuntu and macOS cover Node 22.19, 24, and 26;
- active CI and the release gate pass one set of checksum-verified candidate bytes to every
  platform job without repacking;
- the release gate rejects every ref except protected `main`, and all third-party Actions use
  reviewed full commit SHAs;
- candidate validation bounds each extracted file and aggregate unpacked bytes, and packaged
  README links cannot target files omitted from the tarball;
- the ordinary model selector was manually confirmed against that packed profile;
- the release workflow verifies one artifact across the complete matrix, then may stage those exact
  bytes through OIDC for separate maintainer approval.

## Milestone 7 — Alpha validation

Status: complete. ADR 0011 is accepted, npm two-factor authentication and recovery access are
prepared, and the MIT project license is committed. The exact artifact passed real-account smoke,
was published as `0.1.0-alpha.0`, matched after registry download, and has a matching GitHub
prerelease. The trusted publisher is stage-only and conventional publishing tokens are disabled.

Deliverables:

- manual real-account smoke record;
- alpha release notes;
- known limitations;
- support template requesting only secret-free diagnostics;
- security reporting process.

Acceptance:

- all release gates pass;
- no open release-blocking security issue;
- public documentation does not imply official endorsement or guaranteed ChatGPT access;
- npm package remains on an alpha dist-tag;
- the initial npm bootstrap and any provenance exception are explicitly recorded.

## Milestone 8 — Stage-only release proof

Status: complete. `0.1.0-alpha.1` was staged from the exact six-cell-verified workflow artifact,
approved separately with two-factor authentication, published with npm provenance, downloaded
back byte-for-byte, installed again, and paired with a matching GitHub prerelease. This milestone
changed release metadata and safeguards, not provider, OAuth, credential-storage, model-visible,
or compatibility behavior.

Deliverables:

- serialize manual release runs without cancelling an in-progress candidate;
- mechanically enforce the exact concurrency declaration;
- record the post-bootstrap `alpha` and `latest` dist-tag policy;
- prepare reviewed `0.1.0-alpha.1` candidate metadata and release notes;
- stage the exact six-cell-verified workflow artifact through OIDC;
- compare the staged download with the workflow artifact before maintainer approval;
- approve with two-factor authentication, verify the registry artifact, and create a matching
  GitHub prerelease.

Acceptance:

- overlapping release dispatches cannot race or cancel a candidate;
- the published bytes match the artifact verified on every supported OS and Node line;
- `alpha` moves to `0.1.0-alpha.1` while `latest` remains on `0.1.0-alpha.0`;
- the final release record contains only secret-free commit, checksum, compatibility, and
  pass/fail evidence;
- ordinary use in another DSH repository may supply additional behavioral confidence but does not
  replace the exact-artifact release proof.

## Post-Alpha reliability gate — DSH retry safety

Status: complete in the retry-safety implementation branch. This gate changes tests and documented
contracts, not runtime behavior.

Deliverables:

- deterministic full-agent-loop tests for transient failures, timeouts, cancellation, partial
  streams, retry exhaustion, and tool-call acceptance;
- exact-once tool execution proof across a failed attempt and an accepted retry;
- durable JSONL restart/resume proof for completed and outcome-unknown tool calls;
- crash-repair classification proof for unstarted and outcome-unknown tool calls;
- ADR 0015 recording the pinned DSH event-topology mismatch and ownership decision.

Acceptance:

- no failed partial output enters derived history;
- no failed attempt executes a tool;
- cancellation starts no replacement request;
- normal retry remains finite;
- resume does not repeat a previously completed tool;
- no generated secret sentinel reaches durable or model-visible output;
- no product runtime dependency or retry implementation is added.

## Post-Alpha reliability gate — bounded CLI stdio flush

Status: complete in the stdio-flush implementation branch. This gate changes only the private
executable lifecycle; command text, JSON schemas, authentication, and library behavior are
unchanged.

Deliverables:

- observe process stdout and stderr failures before a production command writes;
- observe Node's pending writable length without issuing a post-output write or ending
  process-owned streams;
- wait for callbacks and reported backpressure under one shared one-second deadline;
- preserve the command exit code on success and use silent exit code 3 when flushing cannot be
  proven complete;
- retain forced termination for unrelated lingering handles;
- exercise the emitted executable through a real JSON child-process pipe.

Acceptance:

- slow stdout and stderr retain their complete byte-for-byte command output;
- both streams must settle before exit, while a permanently stalled stream remains bounded;
- stream errors expose no native object, message, stack, path, buffered content, or secret sentinel;
- all temporary stream and SIGINT listeners are removed before final exit;
- `status --json` and `doctor --json` remain one newline-terminated document;
- a consumer that reads one complete JSON line and closes its pipe retains exit code 0;
- no runtime dependency or public library export is added.

## Deferred milestones

The following require separate proposals and are not implied by the core roadmap:

- OS keychain vault;
- minimal account Web UI;
- multiple accounts;
- request policy extensions;
- usage/quota display;
- search provider;
- image-fetching tool;
- delegated Codex App Server agent.
