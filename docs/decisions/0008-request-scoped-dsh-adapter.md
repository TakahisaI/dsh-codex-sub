# ADR 0008: Request-scoped authentication around the public DSH PiAiAdapter

- Status: accepted
- Date: 2026-08-19

## Context

Milestone 4 must expose the pi-ai `openai-codex` provider through DSH's normal `LlmAdapter` seam
while resolving package-owned OAuth once per model request. The pinned public
`@deepseek-ai/dsh-llm-pi-ai` package exports `PiAiAdapter` and
`ResolvedPiAiProviderProfile`, but keeps profile materialization and provider-construction helpers
package-internal. Its public `resolveApiKey(provider, profile)` callback also receives no request
`AbortSignal`.

The pinned Codex provider advertises OAuth only. pi-ai's public `Models` contract applies an
explicit `apiKey` stream option after determining that the provider has configured authentication.
An OAuth-only provider with no credential store is therefore rejected as unconfigured before the
request override is applied. DSH's generic pi-ai adapter intentionally has no OAuth credential
store, so using the provider unchanged cannot express this package's request-scoped credential.

An offline public-contract test found one more cancellation gap: the pinned `PiAiAdapter` resolves
DSH image attachments at request time but calls `AttachmentStore.readImage()` without the request
signal, even though that store's public method accepts one.

## Decision

Construct one fixed `ResolvedPiAiProviderProfile` directly from published values:

- `openaiCodexProvider()` for the catalog and wire implementation;
- the public profile type from the DSH pi-ai package;
- `resolveRetryPolicy()` from the DSH LLM package;
- project-owned provider display metadata and a 300-second stream-idle interval.

Do not import a DSH source subpath or duplicate model metadata.

Wrap the returned provider without mutation. The wrapper preserves its public identity, base
metadata, OAuth method, model functions, and stream functions, then adds one api-key auth method
that never reads an environment variable or file. That method returns a fixed non-secret internal
marker because pi-ai requires a configured auth result before it applies the explicit request
override. Both wrapper stream methods reject the marker, an empty value, or an absent value before
delegating. Consequently the marker can never become a bearer credential or reach provider I/O;
only the access token supplied in the current stream options is accepted.

Register one long-lived `CodexDshAdapter` with DSH. It delegates catalog and exact-model operations
to one metadata-only `PiAiAdapter`. For each stream it:

1. calls `CodexAuthService.resolveRequestAuth(options.signal)` exactly once;
2. converts project `CodexError` values to DSH `LlmError` values with the same stable code and no
   serialized cause;
3. creates a request-local `PiAiAdapter` whose credential callback returns that frozen token and
   whose provider wrapper captures a project `CodexError` before pi-ai can reduce it to a generic
   in-band error event;
4. converts that captured failure before yielding any DSH chunk, without parsing an error message;
5. supplies a request-local `AttachmentStore` proxy that forwards the DSH signal when the pinned
   adapter omits it;
6. delegates message conversion, reasoning, tools, replay, usage, timeout, and provider streaming
   to DSH's adapter.

The Cordis entry evaluates exact runtime compatibility before construction or registration, then
registers only `openai-codex`. It translates only DSH's public `DUPLICATE_ADAPTER` error to
`CODEX_PROVIDER_CONFLICT`; the check reads the public own enumerable `code` data property because a
host and bundled plugin can load distinct copies of the DSH error class. Every other registration
failure is preserved. Cordis owns disposal.

## Consequences

- Authentication refresh remains cancellable even though `PiAiAdapter.resolveApiKey` has no signal.
- A request holds one access token only in a short-lived closure and never mutates a shared provider.
- The fixed marker satisfies pi-ai's configured-auth gate but is rejected before provider I/O.
- Project-owned stream failures keep their stable code even when pi-ai would otherwise turn a
  thrown provider failure into a generic error event.
- DSH continues to own all model-visible conversion, retry, replay, attachment, timeout, and stream
  behavior.
- Request-local `PiAiAdapter` allocation is accepted as the smallest public-API-only composition;
  no second agent runtime or message converter is introduced.
- Public contract tests must pin the configured marker guard, one-auth-call invariant, attachment
  signal forwarding, stream timeout, replay, raw tool fragments, and actual Codex catalog.
- A future DSH release that passes a signal to `resolveApiKey` or attachment reads may allow the
  request-local wrappers to be simplified, but only after a compatibility review.
