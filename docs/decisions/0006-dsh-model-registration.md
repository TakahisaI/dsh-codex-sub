# ADR 0006: Register the Codex route through the live LLM adapter registry

- Status: accepted
- Date: 2026-08-19

## Context

The first release must make one always-live `openai-codex` route and its provider-owned model catalog
visible through DSH's ordinary model selector. It has no user-editable provider settings, browser
plugin, or dormant routes. The public LLM registration contract had to be proven against the exact
supported DSH release before production adapter work began; the actual selector remains a packed
installation acceptance test because it is not a published consumer mounted by this Host-only
fixture.

The contract test uses DeepSeek Harness `0.1.0-rc.7`, specifically
`@deepseek-ai/dsh-llm` `0.1.0-rc.7`, with `@deepseek-ai/cordis` `4.0.1`. It imports `Context`,
`LlmRuntime`, `LlmAdapter`, and the related types only from the published package roots. It mounts
the public LLM service and a fake adapter without OAuth, credentials, provider traffic, or DSH
source-only test helpers.

The pinned `@deepseek-ai/dsh-llm` README documents
`listModelDiscoveryNamespaces()`, but that method is absent from both its published root declaration
and its runtime service. This project does not depend on that documentation-only method. The test
uses the published `discoverModels()` operation and its `NO_DISCOVERY` result to prove that the
package-name namespace has no discovery registration. Global absence cannot be enumerated through
the published API while the documented list method remains unpublished.

## Decision

Start with only the live route:

```text
ctx.llm.registerAdapter(['openai-codex'], adapter)
```

The adapter supplies `providerInfo()`, `listModels()`, and `resolveModel()`. The public
`listProviders()`, `listModels()`, and `resolveModelInfo()` calls then expose the provider display
metadata and model catalog through the pinned LLM runtime. This proves the live registry shape, not
that the actual model selector consumes it.

Do not initially call `registerConfigurableProviders()` or `registerModelDiscovery()`. The
configurable provider directory represents routes activated through a user-settings namespace,
including dormant routes. This plugin's single route is live whenever the plugin is loaded and has
no such configuration owner. Adding a directory entry would claim a settings surface the package
does not provide. If the Milestone 6 packed selector test shows that the live registry is
insufficient, add the smallest Host-only directory registration supported by the public API and
update this decision before release.

Use Cordis fiber disposal as the registration lifetime. Disposal removes the route and emits the
same topology update used by registration. A duplicate route registration fails atomically with
DSH's `DUPLICATE_ADAPTER` error and does not retain any non-conflicting route from the rejected
candidate set. The production plugin translates the route conflict to
`CODEX_PROVIDER_CONFLICT` at its boundary.

Keep the bundle row addressed to the package root export through `name: dsh-codex-sub`; do not add a
temporary or source-subpath entry.

## Consequences

- Model IDs remain adapter-owned; the contract fixture uses a fake ID and production code will use
  the pinned pi-ai catalog.
- The fixture structurally calls only `registerAdapter()`; it does not mount settings, Web, search,
  tool, session, or agent-loop services. Their absence is reviewed from the plugin boundary rather
  than inferred by querying an otherwise empty Cordis context.
- The contract test proves the pinned LLM runtime's provider/model registry, duplicate atomicity,
  topology notification, and effect-based cleanup.
- Milestone 4 implements this live-only registration in the package root plugin entry; no
  configurable-provider or discovery registration was added.
- The actual Web selector and installed bundle loader are not imported into this Host-only test.
  Milestone 6 must install the packed tarball in a temporary DSH profile and confirm end-to-end model
  visibility and bundle-row loading.
- Any DSH compatibility update must rerun this contract and review the configurable-provider
  decision, including whether the documentation-only discovery-list method has become a published
  API.
