# ADR 0017: Retain package-owned Codex auth for DSH 0.1.1-rc.1

- Status: accepted
- Date: 2026-08-21

## Context

DeepSeek Harness `dsh-llm-pi-ai@0.1.1-rc.1` adds a native credential and authorization layer.
The adapter now requires `PiAiAdapterOptions.auth`, exposes `recordKeyFor('openai-codex')`
as `llm-pi-ai/openai-codex`, and can connect pi-ai credential storage and OAuth refresh to DSH's
credential records and neutral authorization seam. It still depends on pi-ai `^0.82.1`; it has
not moved to the separately released pi-ai `0.83`/`0.84` lines.

Public inspection of the release found the native runtime path but no browser implementation that
starts the Codex login from the Models page or carries its notices/prompts over the Web wire. The
published plugin, in contrast, already provides a working CLI login surface, package-owned
owner-only storage, request-time refresh, offline diagnostics, exact rc.7 compatibility, and an
ordinary DSH model route.

Upstream inspected release: `dsh-v0.1.1-rc.1`, commit
`528c682e061696f5a160f363f236ecbf53cbd006`.

## Decision

Choose **B: retain package-owned provider/OAuth ownership** for the next candidate while making
the minimum structural changes required by DSH `0.1.1-rc.1`.

The adapter supplies the newly required auth injection as a fail-closed boundary:

- it reports no stored credential;
- it refuses every native write and logout;
- it returns no environment value, including when an ambient OpenAI key exists;
- it reports no ambient credential file;
- normal requests continue to use exactly one package-resolved bearer token through the existing
  explicit-token provider wrapper.

This is deliberately not native adoption. The injection exists so DSH cannot silently install its
in-memory default store or discover another credential if the override path changes.

Do not copy or convert OAuth credentials between `$DSH_HOME/dsh-codex-sub/auth.json` and DSH's
`llm-pi-ai/openai-codex` record. Any later migration must be designed against public contracts and
defaults to re-login unless a safe conversion is proven without exposing secrets.

## Evidence record

This decision is accepted from two completed, secret-free evidence lanes plus standing lanes:

- The merged source-level candidate spike (#46) proved the production entry against exact
  `0.1.1-rc.1` packages: the required auth-injection shape, one production adapter route with
  `DUPLICATE_ADAPTER` rejection, package-owned auth resolution delivering its bearer token to the
  explicit-token provider boundary, zero reads or writes through the fail-closed native store
  during streaming, request-image offload under a deliberately one-byte profile budget, and
  offline fake authorization save/read/delete on the native record seam.
- The merged fresh-packed ephemeral-overlay lane (#49, closing #47) installed one unpublished
  production bundle, overlaid for rc.1 metadata only, into an isolated fresh Host: a unique
  provider route with a seven-model catalog, direct and adapter-transitive peers resolving to the
  same Host copies with two pi-ai copies retained, duplicate-route and configurable-directory
  rejection, signed-out `CODEX_AUTH_REQUIRED` with zero provider network attempts across
  save/restart/post-logout/confirm-deleted boots, working packaged CLI status and doctor, the
  package-owned credential preserved across restart and removed by logout without disturbing an
  adjacent file, and an independent native credential record deleted across process boundaries.
- Natural refresh observation on a real account (#33) remains a maintainer-controlled follow-up;
  it is not an ownership prerequisite because refresh contracts are covered offline and the
  supported release line is unchanged.
- Scheduled upstream drift detection (#36) continues as a non-blocking canary outside blocking CI.

## Verification lanes

The supported lane remains exact DSH `0.1.0-rc.7`, Cordis `4.0.1`, pi-ai `0.82.1`. Root metadata,
runtime checks, built-entry smoke, packed installation, and release claims stay pinned to that
combination.

The candidate lane is isolated in a temporary install root with exact DSH/Cordis packages at
`0.1.1-rc.1` and pi-ai at `0.82.1`. Its black-box probes bundle the production entry and verify:

- the required image budget;
- the required auth-injection shape;
- one production `CodexDshAdapter` route on candidate `LlmRuntime`, with duplicate registration
  rejected (`DUPLICATE_ADAPTER`);
- one package-owned auth resolution and delivery of its bearer token to the explicit-token
  provider boundary;
- zero reads or writes through the fail-closed native store during streaming;
- request-image offload when the profile budget is deliberately set to one byte;
- explicit-token streaming without any read or write through the fail-closed native store;
- offline fake authorization save/read/delete on the native record seam.

The probe uses generated offline access/refresh/account sentinels, checks that command output does
not expose them, disposes authorization and credential fibers, and removes its credential root.
CI runs this lane once on Node 24; broader runtime expansion remains an exit criterion below.

### Packed-topology status

| Lane | Result | Scope |
| --- | --- | --- |
| Supported rc.7 full check | PASS locally | lint, types, declarations, tests, boundaries, build, smoke, compatibility, licenses, release state, pack contract |
| Supported rc.7 packed install | PASS locally | signed-out auth failure before I/O and zero provider network attempts |
| Candidate rc.1 isolated lane | PASS locally | production adapter stream, fail-closed injection, duplicate route, native record seam |
| Ephemeral-overlay packed rc.1 candidate | PASS locally | isolated fresh Host install of a test-only rc.1 metadata overlay built from one production bundle; route, duplicate adapter/directory rejection, offline failure across four Host boots, CLI diagnostics, package-owned restart/logout with adjacent-file preservation, native record restart/delete/delete-persistence |
| Exact published rc.7 artifact on rc.1 | NOT TESTED | intentionally rejected by the frozen supported-lane guard; requires a future compatibility release and its own matrix |

The ephemeral-overlay packed probe starts from one frozen production bundle, then applies a
test-only manifest/compatibility overlay so that identical emitted code can activate on an isolated
`0.1.1-rc.1` Host. In CI it consumes the single verified unpublished artifact produced by the
candidate job; locally it may build that input first. The overlay does not change repository
compatibility metadata or publish anything, and it must not be reported as the exact public artifact
running on DSH rc.1. The probe pins the isolated Host's DSH release-line packages to
`0.1.1-rc.1`, proves direct and adapter-transitive peers resolve to the same Host copies, retains
two pi-ai copies, rejects duplicate adapters and directories, proves signed-out requests fail
before provider I/O on save/restart/post-logout/confirm-deleted boots, verifies CLI diagnostics,
preserves the package-owned credential through restart and removes it through logout without
disturbing an adjacent marker file, and deletes an independent native record across process
boundaries. Native and package-owned stores receive distinct generated sentinel triplets, and the
native record is required to match only its own triplet. Generated sentinels bound subprocess
captures through stdio close, are redacted from failures, and are checked against printable output.
Attachment/image-budget behavior is covered by the source-level rc.1 candidate lane. Replay,
retry, and cancellation remain covered by the supported rc.7 contract suites only and are NOT
TESTED on rc.1; the candidate-lane probe runs a single stream with retries disabled and exercises
no replay or cancellation scenario. Fresh-packed rc.1 coverage for all four behaviors is deferred
to #51. Natural refresh remains #33 and a real-account smoke remains promotion-gated.

The supported matrix is enforced by CI. The isolated source and fresh-packed candidate lanes run as
dedicated Node 24 CI jobs.

The production runtime guard intentionally rejects candidate DSH before registration. A future
alpha may update peers only after this decision and the complete exact-artifact matrix pass.

## Consequences and exit criteria

With this decision accepted, work on an rc.1-compatible candidate may begin, but nothing may be
published or moved into supported compatibility metadata until every exit criterion below passes,
including the exact published-artifact matrix on rc.1.

Promotion to a reviewed alpha requires all of the following:

1. supported rc.7 full checks and six-cell packed-install matrix remain green;
2. isolated rc.1 probes pass on the same Node matrix where practical (the current gate is Node 24);
3. peer dependencies and machine-readable compatibility move together only after review;
4. ephemeral-overlay packed rc.1 installation proves one route, duplicate-route safety,
   signed-out `CODEX_AUTH_REQUIRED`, zero provider network attempts, CLI diagnostics, and
   credential preservation/removal behavior; the exact published artifact on rc.1 remains
   explicitly out of scope for this evidence;
5. a maintainer-controlled real-account smoke covers login, model request, natural refresh,
   restart, and logout on the exact artifact;
6. upstream Web login-start remains absent only while this package remains responsible for the
   user-facing bridge; once DSH ships that surface, ownership should be revisited under a new
   compatibility spike.

Native option A remains blocked until browser login, durable/restart behavior, logout semantics,
route coexistence, and migration are proven. Option C would leave the working rc.7 line frozen but
would not validate the already-published rc.1 contract; B preserves evidence for both boundaries
without publishing an unverified combination.

## Follow-ups

Every deferred or untested item is classified and tracked here:

- DEFERRED (#51) — Broaden fresh packed rc.1 evidence to attachment, replay, retry, and
  cancellation; the source-level rc.1 lane already covers attachment/image-budget behavior, while
  replay, retry, and cancellation are proven only by the supported rc.7 suites. The ownership
  decision does not depend on repeating these behaviors on a fresh install.
- NOT TESTED (#50) — Prove the exact published artifact on DSH rc.1 only in a future
  compatibility-release lane with its own full matrix; do not use peer overrides or duplicate
  installs as substitute evidence. This is a promotion gate, not an ownership prerequisite.
- DEFERRED (#52) — Decide whether to broaden the candidate lane beyond Node 24 after upstream
  compatibility stabilizes.
- DEFERRED (maintainer-controlled, #33) — Track natural OAuth refresh through normal use until a
  real-account smoke runs; refresh contracts are covered offline, so this is not an ownership
  prerequisite.
- CONDITIONAL (#53) — Revisit this ownership decision when DSH ships the Web/browser login-start
  surface.
