# dsh-codex-sub

`dsh-codex-sub` is a planned DeepSeek Harness plugin that exposes the pi-ai `openai-codex`
provider as a normal DSH model route using ChatGPT subscription authentication.

> Status: Milestones 0 through 3 are implemented: repository tooling, pure core contracts, the
> credential document codec, the secure package-owned file vault, and pi-ai OAuth integration. DSH
> integration and the CLI are not implemented, so there is no usable plugin yet.

## Product contract

The plugin exists to satisfy three requirements together:

1. ChatGPT/Codex OAuth subscription access.
2. Codex models in DSH's normal model picker.
3. DSH ownership of the agent loop, tools, approvals, sessions, attachments, compaction, and
   recovery.

The plugin is not a Codex subagent bridge. It supplies only an LLM provider route to DSH.

## Initial scope

The first release contains:

- `openai-codex` provider registration;
- model metadata from the pinned pi-ai provider catalog;
- a CLI for login, logout, status, and diagnostics;
- a package-owned, owner-only OAuth credential document;
- request-time OAuth refresh;
- a thin integration with DSH's public `PiAiAdapter`;
- exact runtime compatibility checks.

It deliberately excludes Web UI, search, image-fetching tools, quota display, Fast Mode,
configuration of default models, App Server, MCP, and migration from other plugins.

## Start here

Coding agents must read [`AGENTS.md`](AGENTS.md). The exact first prompt is provided in
[`CODEX_BOOTSTRAP_PROMPT.md`](CODEX_BOOTSTRAP_PROMPT.md).

Human readers should continue with:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/security.md`](docs/security.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/testing.md`](docs/testing.md)
- [`docs/compatibility.md`](docs/compatibility.md)

## Intended installation shape

Once implemented and published:

```sh
dsh plugin --profile web add dsh-codex-sub
dsh plugin --profile web exec dsh-codex-sub login
dsh web
```

The DSH model selector should then show models under **OpenAI Codex (ChatGPT)**.

The package must never change the profile's default model or global search route.

## Upstream boundary

The project depends on:

- DeepSeek Harness's public LLM plugin seam;
- DeepSeek Harness's public pi-ai adapter;
- pi-ai's published OpenAI Codex provider and OAuth contracts.

ChatGPT eligibility, model availability, quotas, backend behavior, and OAuth behavior remain
controlled upstream and may change. A ChatGPT subscription credential is not an OpenAI Platform API
key.

The project is not affiliated with or endorsed by OpenAI, ChatGPT, Codex, DeepSeek, DeepSeek
Harness, or earendil-works.

## Publication blocker

A project license must be selected before the package is made non-private or published. The initial
scaffold intentionally uses `UNLICENSED` and `private: true` until the repository owner makes that
decision.
