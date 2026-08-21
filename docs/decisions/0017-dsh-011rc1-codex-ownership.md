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

## Verification lanes

The supported lane remains exact DSH `0.1.0-rc.7`, Cordis `4.0.1`, pi-ai `0.82.1`. Root metadata,
runtime checks, built-entry smoke, packed installation, and release claims stay pinned to that
combination.

The candidate lane is isolated in a temporary install root with exact DSH/Cordis packages at
`0.1.1-rc.1` and pi-ai at `0.82.1`. Its black-box probes verify:

- the required image budget;
- the required auth-injection shape;
- live provider registration and catalog resolution through the candidate adapter;
- duplicate directory rejection (`DUPLICATE_DIRECTORY`);
- explicit-token streaming without any read or write through the fail-closed native store;
- offline fake authorization save/read/delete on the native record seam.

The production runtime guard intentionally rejects candidate DSH before registration. A future
alpha may update peers only after this decision and the complete exact-artifact matrix pass.

## Consequences and exit criteria

Promotion to a reviewed alpha requires all of the following:

1. supported rc.7 full checks and six-cell packed-install matrix remain green;
2. isolated rc.1 probes pass on the same Node matrix where practical;
3. peer dependencies and machine-readable compatibility move together only after review;
4. fresh packed rc.1 installation proves one route, duplicate-route safety, signed-out
   `CODEX_AUTH_REQUIRED`, zero provider network attempts, CLI diagnostics, and credential
   preservation/removal behavior;
5. a maintainer-controlled real-account smoke covers login, model request, natural refresh,
   restart, and logout on the exact artifact;
6. upstream Web login-start remains absent only while this package remains responsible for the
   user-facing bridge; once DSH ships that surface, ownership should be revisited under a new
   compatibility spike.

Native option A remains blocked until browser login, durable/restart behavior, logout semantics,
route coexistence, and migration are proven. Option C would leave the working rc.7 line frozen but
would not validate the already-published rc.1 contract; B preserves evidence for both boundaries
without publishing an unverified combination.
