# dsh-codex-sub

`dsh-codex-sub` is a DeepSeek Harness plugin that exposes the pi-ai `openai-codex`
provider as a normal DSH model route using ChatGPT subscription authentication.

> Status: Milestones 0 through 6 are implemented: repository tooling, pure core contracts, the
> credential document codec, the secure package-owned file vault, pi-ai OAuth integration, and the
> native DSH LLM provider route, plus the package CLI, offline diagnostics, and packed-install
> release gates. Milestone 7 Alpha preparation is in progress. No package version has been
> published, and publication remains blocked on the maintainer decisions listed below.

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

## Verified compatibility

| Component | Verified value |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@earendil-works/pi-ai` | `0.82.1` |
| Node.js | `^22.19.0 || ^24.0.0 || ^26.0.0` |
| Operating systems | Linux and macOS |

See [known limitations](docs/known-limitations.md) for the account, storage, platform, and product
boundaries of the first Alpha.

## Install a packed build

The package is still private. To test a local tarball, build and pack it, then add the resulting
`.tgz` file to a DSH Web profile:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm pack
dsh plugin --profile web add ./dsh-codex-sub-0.0.0-development.tgz \
  --save-exact \
  --allow-build=@google/genai \
  --allow-build=protobufjs
dsh plugin --profile web exec dsh-codex-sub login
dsh web
```

The two build approvals belong to the pinned DSH Web dependency tree, not to this package. The DSH
model selector then shows the provider-owned catalog under **OpenAI Codex (ChatGPT)**.

The package must never change the profile's default model or global search route.

To inspect the installation without signing in:

```sh
dsh plugin --profile web exec dsh-codex-sub status --json
dsh plugin --profile web exec dsh-codex-sub doctor --json
```

Uninstalling the bundle deliberately preserves `$DSH_HOME/dsh-codex-sub/auth.json`. Run logout
before uninstall when the credential should also be removed:

```sh
dsh plugin --profile web exec dsh-codex-sub logout
dsh plugin --profile web remove dsh-codex-sub
```

Reinstalling the package reuses a preserved credential. Logout removes only `auth.json`; it does
not remove another file in the package-owned directory.

## CLI

The package executable provides:

```sh
dsh-codex-sub login
dsh-codex-sub logout
dsh-codex-sub status --json
dsh-codex-sub doctor --json
dsh-codex-sub version
```

`status` and `doctor` are local and offline. Login prints a validated HTTPS authorization
destination but does not open a browser automatically. Secret and manual-code prompts do not echo
input. JSON commands emit one versioned document and never include credential contents, account
identifiers, token timestamps, authorization URLs, or local paths.

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

## Support and security

For installation or behavior problems, use the repository issue forms and include only exact
versions plus sanitized `doctor --json` output. Never post credentials, authorization URLs or
codes, account identifiers, full environment dumps, local paths, or model conversations.

Report suspected vulnerabilities privately through [`SECURITY.md`](SECURITY.md).

## Publication blocker

A project license and the initial npm publishing bootstrap must be selected before the package is
made non-private or published. npm has no separate package-name reservation step; the first real
publish establishes ownership. ADR 0011 records the proposed one-release bootstrap before OIDC
trusted publishing can be configured. The repository intentionally uses `UNLICENSED` and
`private: true`; its release workflow remains stored as a disabled file and has no publish step.
Draft Alpha notes and the secret-free manual-smoke record are available under
[`docs/releases/`](docs/releases/) and [`docs/alpha-smoke-record.md`](docs/alpha-smoke-record.md).
