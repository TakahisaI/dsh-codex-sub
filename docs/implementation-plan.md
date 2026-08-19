# Implementation plan

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
- release workflow prepared but not enabled until the npm bootstrap decision is accepted and the
  first real release establishes registry ownership.

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
- the ordinary model selector was manually confirmed against that packed profile;
- the release workflow is stored with a disabled extension and contains no publication step.

## Milestone 7 — Alpha validation

Status: in progress. Documentation, support, and secret-safe recording can be prepared before the
release, but real-account OAuth, acceptance or replacement of ADR 0011's npm bootstrap proposal,
and publication remain manual gates. The MIT project license has been selected and committed.

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
