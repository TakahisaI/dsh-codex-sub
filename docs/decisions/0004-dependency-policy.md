# ADR 0004: Narrow, exact upstream dependencies

- Status: accepted
- Date: 2026-08-18

## Context

DSH is in developer preview and pi-ai owns the subscription provider transport. Optimistic version
ranges would claim compatibility that has not been tested.

## Decision

Use only published official DSH packages, `@earendil-works/pi-ai`, and Node built-ins at runtime.
Pin verified DSH release-family packages and pi-ai exactly for public releases. Isolate pi-ai runtime
imports in `src/piai/**` and DSH LLM imports in `src/dsh/**`.

## Consequences

- Dependency updates require a compatibility PR and release.
- Runtime checks can fail before provider registration.
- The packed-install gate accepts the verified two-copy pi-ai topology while requiring all DSH
  peers to resolve to the Host; ADR 0010 records the evidence and fail-closed identity check.
- Community bridge plugins are not implementation dependencies or sources.
