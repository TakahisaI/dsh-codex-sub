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
previously published plugin line, in contrast, provided a working CLI login surface, package-owned
owner-only storage, request-time refresh, offline diagnostics, exact rc.7 compatibility, and an
ordinary DSH model route. The current candidate updates that boundary to DSH `0.1.1-rc.1`.

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
- The merged fresh-packed lane (#49, closing #47) now consumes the immutable exact workflow
  artifact directly in an isolated fresh Host: a unique provider route with a seven-model catalog,
  direct and adapter-transitive peers resolving to the same Host copies with two pi-ai copies
  retained, duplicate-route and configurable-directory rejection, signed-out
  `CODEX_AUTH_REQUIRED` with zero provider network attempts across save/restart/post-logout/
  confirm-deleted boots, working packaged CLI status and doctor, the package-owned credential
  preserved across restart and removed by logout without disturbing an adjacent file, and an
  independent native credential record deleted across process boundaries.
- Natural refresh observation on a real account (#33) remains a maintainer-controlled follow-up;
  it is not an ownership prerequisite because refresh contracts are covered offline and the
  supported release line is unchanged.
- Scheduled upstream drift detection (#36) continues as a non-blocking canary outside blocking CI.

### Candidate-owned image and auth boundary

The candidate keeps the request-image budget fixed at 20 MiB (`20 * 1024 * 1024`) in the adapter.
DSH's public package root does not export an equivalent constant, so the plugin does not import an
unpublished DSH subpath. Oversized image and base64 inputs are replaced with DSH-owned text before
provider I/O. This replacement is an adapter responsibility and is not exposed as plugin
configuration.

The public rc.1 `PiAiAdapterOptions.auth` type is the only auth-injection seam. The injected
implementation is fail-closed: native credential reads are unset, native writes/deletes/logout
return fixed safe errors, and environment/file lookup is empty. No package credential is copied,
migrated, or used as a native fallback.

## Verification lanes

The current candidate lane is exact DSH `0.1.1-rc.1`, Cordis `4.0.1`, pi-ai `0.82.1`. Root
metadata, runtime checks, built-entry smoke, packed installation, and candidate claims are pinned
to that combination. The earlier published rc.7 lane remains historical evidence only.

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
| Historical published rc.7 full check | PASS locally | prior Alpha evidence; not the current candidate claim |
| Historical published rc.7 packed install | PASS locally | prior Alpha evidence; not the current candidate claim |
| Candidate rc.1 isolated lane | PASS locally | production adapter stream, fail-closed injection, duplicate route, native record seam |
| Candidate rc.1 source/contract replay, retry, cancellation | PASS locally | source-level contract suites exercise the DSH-owned conversion and lifecycle boundaries on exact `0.1.1-rc.1` |
| Fresh-packed rc.1 replay, retry, cancellation | PASS (see [`compatibility-reports/rc1-request-contracts.md`](../compatibility-reports/rc1-request-contracts.md)) | requests-phase boot proves attachment resolution onto the wire, replay continuation, the single-attempt retry boundary, and aborted-finish cancellation with zero external hosts |
| Fresh-packed rc.1 workflow artifact | PASS locally | one immutable workflow artifact installed without mutation into an exact-pinned fresh `0.1.1-rc.1` Host: unique route with seven-model catalog, duplicate adapter/directory rejection, signed-out `CODEX_AUTH_REQUIRED` with zero provider network attempts across save/restart/post-logout/confirm-deleted boots, CLI status/doctor compatible, package-owned credential preserved then removed by logout without disturbing an adjacent file, independent native record deleted across process boundaries |

The fresh-packed probe consumes the single verified unpublished workflow artifact produced by the
candidate job and installs those bytes directly into an isolated Host. It does not rewrite a
manifest or repack the artifact. The probe
pins the isolated Host's DSH release-line packages to `0.1.1-rc.1`, proves direct and
adapter-transitive peers resolve to the same Host copies, retains two pi-ai copies, rejects
duplicate adapters and directories, proves signed-out requests fail before provider I/O on
save/restart/post-logout/confirm-deleted boots, verifies CLI diagnostics, preserves the
package-owned credential through restart and removes it through logout without disturbing an
adjacent marker file, and deletes an independent native record across process boundaries. Native
and package-owned stores receive distinct generated sentinel triplets, and the native record is
required to match only its own triplet. Generated sentinels bound subprocess captures through
stdio close, are redacted from failures, and are checked against printable output.
Attachment/image-budget behavior plus replay, retry, and cancellation are PASS in the source-level
rc.1 contract suites, and a requests-phase boot now proves them on the fresh packed install as
well (see [`compatibility-reports/rc1-request-contracts.md`](../compatibility-reports/rc1-request-contracts.md)).
Natural refresh remains #33 and a real-account smoke remains promotion-gated.

The candidate matrix is enforced by CI. The isolated source and fresh-packed candidate lanes run as
dedicated Node 24 CI jobs, alongside the exact-artifact lane that downloads the same verified
workflow artifact, checks its SHA before and after installation, and installs those bytes without
mutation into a Host whose DSH release-line packages are each pinned to the exact candidate
version. Because every upstream package declares a caret range and `0.1.1-rc.2` is now public,
an unpinned install resolves to newer packages; the lane discovers the full release-line package
set from the seed graph and pins it explicitly through pnpm workspace overrides before verifying
the topology above. The future compatibility-release matrix remains the gate for published bytes
on rc.1 (#50).

The production runtime guard accepts only the exact candidate DSH/Cordis/pi-ai values. The
candidate remains unpublished and is not public support until this decision and the complete
exact-artifact matrix pass; the exact-artifact lane supplies the installability half of that matrix,
and the compatibility-release lane (#50) completes it with the published bytes themselves.

## Consequences and exit criteria

With this decision accepted, work on an rc.1-compatible candidate may continue, but nothing may be
published or described as public support until every exit criterion below passes, including the
exact published-artifact matrix on rc.1.

Promotion to a reviewed alpha requires all of the following:

1. historical rc.7 full checks and six-cell packed-install matrix remain available as prior Alpha evidence;
2. isolated rc.1 probes pass on the same Node matrix where practical (the current gate is Node 24);
3. peer dependencies and machine-readable compatibility move together only after review;
4. fresh-packed installation of the exact workflow artifact proves one route, duplicate-route
   safety, signed-out `CODEX_AUTH_REQUIRED`, zero provider network attempts, CLI diagnostics,
   credential preservation/removal behavior, and — since #51 — fresh-packed attachment
   resolution, replay continuation, the single-attempt retry boundary, and cancellation;
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

- RESOLVED (#51) — Fresh packed rc.1 evidence now covers attachment resolution, replay
  continuation, the single-attempt retry boundary, and cancellation; see
  [`compatibility-reports/rc1-request-contracts.md`](../compatibility-reports/rc1-request-contracts.md)
  and the updated packed-topology status above.
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
