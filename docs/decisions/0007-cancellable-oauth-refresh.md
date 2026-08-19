# ADR 0007: Cancellable OAuth refresh under the credential lock

- Status: accepted
- Date: 2026-08-19

## Context

The authentication service contract accepts an `AbortSignal` when resolving request auth. The
pinned `@earendil-works/pi-ai` release publishes automatic locked refresh through
`Models.getAuth()`, but that method's public overloads accept only auth-resolution overrides and do
not accept an `AbortSignal`.

The same release publishes the lower-level pieces needed to preserve both cancellation and the
locking invariant:

- `OAuthAuth.refresh(credential, signal?)` performs the provider-owned network refresh;
- `OAuthAuth.toAuth(credential)` derives request auth without network access;
- `CredentialStore.modify()` runs a serialized read-modify-write callback and returns the
  post-operation credential.

The package's root declaration file also re-exports every provider API declaration. Under the
project's Node-only TypeScript configuration, loading the required public `createModels` export
therefore reports unrelated declaration errors from transitive Anthropic and Google SDK types:
missing nested `undici-types`, optional Model Context Protocol types, and browser event globals.
The narrow `openai-codex` provider subpath does not publish `createModels`, and importing an
unpublished internal subpath is forbidden by the dependency policy.

The file vault's published upstream lock helper has a fixed two-second waiter deadline. OAuth
refresh can exceed that deadline, so a concurrent refresh or logout cannot be promised to wait
indefinitely.

## Decision

`CodexAuthService` uses one `Models` collection containing exactly `openaiCodexProvider()` for login
and logout orchestration. Request-auth resolution uses the provider's published `OAuthAuth`
directly:

1. read the package-owned credential;
2. if it is expired, call `OAuthAuth.refresh()` inside `CredentialStore.modify()` and pass the
   request's signal;
3. derive request auth exactly once from the post-operation credential with `OAuthAuth.toAuth()`;
4. freeze the resulting access token for that request.

The service never calls provider API-key resolution and injects an auth context that returns no
ambient environment or filesystem credentials.

TypeScript keeps strict checking for project source while enabling `skipLibCheck` for published
dependency declarations. This is the narrow available workaround that keeps all runtime imports on
the package's export map; no missing transitive SDK is added as a project runtime dependency.

The first release retains the file vault's two-second waiter deadline. The lock holder keeps the
lock for the complete refresh. A contender either acquires the lock after the refresh or fails
closed with the existing safe `lock_failed` storage error; it never removes the lock, refreshes the
same credential concurrently, or interleaves logout with the write.

## Consequences

- Request cancellation reaches the provider-owned refresh operation.
- Refresh token rotation remains inside the same cross-process exclusion domain as logout.
- A fresh credential avoids taking the writer lock.
- `Models.getAuth()` is not used for request auth at this pinned version, so a focused contract test
  must continue to verify the provider's public `OAuthAuth` and request-auth shape.
- Dependency declaration files are not internally type-checked. Project source and its use of the
  published pi-ai surface remain strictly checked, and the exact pinned version remains a
  compatibility gate.
- A refresh lasting more than two seconds can make a concurrent refresh or logout fail safely
  instead of waiting for completion. Replacing or extending the upstream lock protocol is a future
  storage compatibility decision, not an implicit part of OAuth integration.
