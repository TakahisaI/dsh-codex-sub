# dsh-codex-sub — Project Constitution

This file is the primary instruction source for every coding agent working in this repository.
Read it before any other file, then read the documents listed under **Required reading order**.

## Mission

Build an independently maintained DeepSeek Harness plugin that exposes the pi-ai `openai-codex`
provider as a normal DSH model route while authenticating with a user's ChatGPT subscription.

The three non-negotiable product requirements are:

1. Authenticate through ChatGPT/Codex OAuth rather than an OpenAI Platform API key.
2. Show `openai-codex` models in DSH's ordinary model selector.
3. Keep the agent loop, tools, approvals, session log, attachments, compaction, cancellation,
   persistence, and recovery owned by DSH.

The project is an integration plugin, not a second agent runtime.

## Source policy

Implement this project from:

- this repository's specifications;
- the public APIs and documentation of DeepSeek Harness;
- the public APIs and documentation of `@earendil-works/pi-ai`;
- official OpenAI and Codex documentation;
- relevant platform and protocol standards.

Do not copy or adapt implementation code from third-party DSH–Codex integration projects unless
the maintainer explicitly requests a comparison, migration, or interoperability task.

When an upstream contract is unclear, inspect its public package exports, write a focused contract
test, or document the unresolved assumption. Do not fill gaps by searching for another plugin's
implementation.

## Required reading order

1. `README.md`
2. `docs/architecture.md`
3. `docs/api-contracts.md`
4. `docs/security.md`
5. `docs/testing.md`
6. `docs/compatibility.md`
7. `docs/implementation-plan.md`
8. Relevant records under `docs/decisions/`

## Scope for the first public release

The first public release provides only:

- one DSH provider route: `openai-codex`;
- model metadata from the pinned pi-ai Codex provider catalog;
- ChatGPT OAuth login through a package CLI;
- package-owned OAuth credential persistence;
- automatic OAuth refresh at the start of a model request;
- DSH `PiAiAdapter` integration;
- `login`, `logout`, `status`, and `doctor` commands;
- explicit runtime compatibility checks;
- focused diagnostics and conflict errors;
- npm/tarball distribution as a DSH bundle.

## Explicit non-goals

Do not implement any of the following in the core package:

- an alternative agent loop;
- Codex App Server, Codex SDK, Codex CLI, or MCP delegation;
- OpenAI Platform API-key authentication;
- web settings UI or browser routes hosted by DSH;
- remote-origin trust configuration;
- usage, credits, quota, or rate-limit UI;
- web search provider registration;
- image-fetching or `view_image` tools;
- Fast Mode or per-session request mutation;
- default-model mutation;
- global search-route mutation;
- arbitrary endpoint, header, or model configuration;
- multiple ChatGPT accounts;
- migration from any prior community plugin or credential file;
- telemetry.

A future feature must live behind a new documented seam or a separate package. It must not enlarge
the core plugin's responsibility by convenience.

## Architectural boundaries

The repository is a single npm package. Do not create a monorepo until a second independently
released package actually exists.

Dependency direction:

```text
core contracts
    ↑
auth domain / diagnostics
    ↑
filesystem store     pi-ai integration
          \           /
           \         /
            DSH integration
                  ↑
                 CLI
```

Rules:

- `src/core/**` must not import DSH, pi-ai, React, or Node filesystem modules.
- `src/auth/**` owns authentication orchestration but not DSH model conversion.
- `src/storage/**` owns persistence and may use Node filesystem APIs plus approved DSH filesystem
  utilities.
- `src/piai/**` is the only directory allowed to import provider/auth runtime values from
  `@earendil-works/pi-ai`.
- `src/dsh/**` is the only directory allowed to import DSH LLM runtime values.
- `src/cli/**` may compose auth, storage, compatibility, and diagnostics; it must not create a DSH
  agent or agent loop.
- No browser/client bundle exists in the first release.
- No module may expose an access token, refresh token, account identifier, authorization code, or
  raw authorization URL through a public service API.

## Stable identities

Use these identities unless an upstream contract proves they are invalid:

```text
npm package:       dsh-codex-sub
Cordis row id:     llm-codex-sub
plugin name:       llm-codex-sub
provider route:    openai-codex
provider display:  OpenAI Codex (ChatGPT)
auth directory:    $DSH_HOME/dsh-codex-sub
auth document:     auth.json
```

The provider route is intentionally `openai-codex` because that is the pi-ai provider identity.
The package must fail clearly if another adapter already owns that route.

## Security invariants

These are release-blocking invariants:

1. Secrets never enter logs, errors, diagnostics, snapshots, tests, or settings.
2. Credential writes are atomic.
3. Refresh and logout are mutually exclusive across processes.
4. POSIX credential files are owner-only; broader permissions fail closed.
5. The package-owned auth path rejects symbolic links for its directory and document.
6. Credential input is size-bounded and schema-validated before use.
7. Every model request resolves auth once and freezes it for that request.
8. No ambient OpenAI API key may silently authenticate the `openai-codex` route.
9. Logout is the only normal operation that removes stored credentials.
10. Diagnostics perform no OAuth login and no network request by default.

See `docs/security.md` for the full threat model.

## Error behavior

Fail loudly and with stable machine-readable codes. Never silently disable the route, silently use
an unrelated credential, silently discard an unsupported request option, or silently clamp an
unsupported reasoning effort.

Plugin-owned error codes begin with `CODEX_`:

- `CODEX_AUTH_REQUIRED`
- `CODEX_REAUTH_REQUIRED`
- `CODEX_AUTH_STORAGE_INVALID`
- `CODEX_AUTH_STORAGE_INSECURE`
- `CODEX_AUTH_LOGIN_FAILED`
- `CODEX_PROVIDER_CONFLICT`
- `CODEX_INCOMPATIBLE_RUNTIME`
- `CODEX_UPSTREAM_PROTOCOL`

Preserve DSH/pi-ai provider-neutral errors where they already express the failure correctly, such
as unknown model, unsupported content, cancellation, or stream timeout.

## Implementation style

- TypeScript, ESM, strict mode.
- Prefer small pure functions and explicit constructor dependencies.
- No default exports.
- Avoid `any`; use `unknown` at trust boundaries and narrow it.
- Exhaustively handle discriminated unions.
- Keep public exports deliberately small.
- Use comments for invariants, protocol obligations, and non-obvious tradeoffs—not narration.
- No speculative abstraction. Introduce a port only when it protects an identified unstable or
  security-sensitive boundary.
- Do not hard-code model IDs or ChatGPT plan names.
- Do not parse access tokens or depend on token-internal claims.
- Never depend on pi-ai source subpaths that are not published exports.
- Never depend on DSH source subpaths that are not published exports.

## Testing rules

- No real OAuth operation in CI.
- No real ChatGPT account or token in fixtures.
- Every secret-bearing test uses generated sentinels and asserts those sentinels never appear in
  output.
- Contract tests pin behavior at the public DSH and pi-ai boundaries.
- A release requires a packed-tarball install test against the supported DSH release.
- Manual real-account smoke tests are documented but never automated with repository secrets.

## Dependency and version policy

- Runtime dependencies are restricted to official DSH packages, `@earendil-works/pi-ai`, and Node
  built-ins unless an ADR approves another dependency.
- Pin DSH release-family packages and pi-ai to exact verified versions for public releases.
- `compatibility.json` is the single source of truth for the verified runtime combination.
- A dependency update is a compatibility project, not a routine version bump.
- Canary workflows may test upstream main branches, but canaries never publish releases.

## Change policy

Every PR must state:

- the requirement it implements;
- the architectural boundary it changes;
- the checks run;
- whether secrets, auth persistence, provider identity, model-visible behavior, or compatibility
  changed.

Changes to auth storage, OAuth behavior, provider wrapping, DSH stream conversion, or public CLI JSON
require an ADR or an update to an existing ADR.

## Definition of done

A feature is done only when:

- implementation and tests satisfy the relevant acceptance criteria;
- documentation reflects public behavior and limitations;
- `pnpm run check` passes;
- `pnpm pack --dry-run` contains only intended files;
- the packed install smoke test passes;
- no generated secret sentinel appears in any captured output;
- compatibility metadata matches package metadata;
- no forbidden source was consulted.
