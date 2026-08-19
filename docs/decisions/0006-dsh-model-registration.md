# ADR 0006: Register the Codex route through the live LLM adapter registry

- Status: accepted
- Date: 2026-08-19

## Context

The first release must make one always-live `openai-codex` route and its provider-owned model catalog
visible through DSH's ordinary model-selection seam. It has no user-editable provider settings,
browser plugin, or dormant routes. The smallest sufficient registration contract had to be proven
against the exact supported DSH release before production adapter work began.

The contract test uses DeepSeek Harness `0.1.0-rc.7`, specifically
`@deepseek-ai/dsh-llm` `0.1.0-rc.7`, with `@deepseek-ai/cordis` `4.0.1`. It imports `Context`,
`LlmRuntime`, `LlmAdapter`, and the related types only from the published package roots. It mounts
the public LLM service and a fake adapter without OAuth, credentials, provider traffic, or DSH
source-only test helpers.

The pinned `@deepseek-ai/dsh-llm` README documents
`listModelDiscoveryNamespaces()`, but that method is absent from both its published root declaration
and its runtime service. This project does not depend on that documentation-only method. The test
uses the published `discoverModels()` operation and its `NO_DISCOVERY` result to prove that the
plugin did not register a settings discovery namespace.

## Decision

Register only the live route:

```text
ctx.llm.registerAdapter(['openai-codex'], adapter)
```

The adapter supplies `providerInfo()`, `listModels()`, and `resolveModel()`. The public
`listProviders()`, `listModels()`, and `resolveModelInfo()` calls then expose the provider display
metadata and model catalog used by Host model-selection consumers.

Do not call `registerConfigurableProviders()` or `registerModelDiscovery()`. The configurable
provider directory represents routes activated through a user-settings namespace, including
dormant routes. This plugin's single route is live whenever the plugin is loaded and has no such
configuration owner. Adding a directory entry would claim a settings surface the package does not
provide.

Use Cordis fiber disposal as the registration lifetime. Disposal removes the route and emits the
same topology update used by registration. A duplicate route registration fails atomically with
DSH's `DUPLICATE_ADAPTER` error and does not retain any non-conflicting route from the rejected
candidate set. The production plugin will translate the route conflict to
`CODEX_PROVIDER_CONFLICT` at its boundary.

Keep the bundle row addressed to the package root export through `name: dsh-codex-sub`; do not add a
temporary or source-subpath entry.

## Consequences

- Model IDs remain adapter-owned; the contract fixture uses a fake ID and production code will use
  the pinned pi-ai catalog.
- The registration adds no settings, Web, search, tool, session, or agent-loop service.
- The contract test proves the documented Host provider/model listing seam, duplicate atomicity,
  topology notification, and effect-based cleanup against the pinned versions.
- The actual Web selector and installed bundle loader are not imported into this Host-only test.
  Milestone 6 must install the packed tarball in a temporary DSH profile and confirm end-to-end model
  visibility and bundle-row loading.
- Any DSH compatibility update must rerun this contract and review the configurable-provider
  decision, including whether the documentation-only discovery-list method has become a published
  API.
