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

Although `OAuthAuth.refresh()` accepts a signal in its public type, an offline black-box contract
test against the pinned `openaiCodexProvider()` shows that aborting the signal does not settle a
refresh whose token fetch is stalled. The service therefore cannot rely on provider cancellation to
release the credential lock.

`Models.login()` and `Models.logout()` also wrap credential-store failures in `ModelsError`, whose
native cause is printable. Login still benefits from Models' provider/auth selection, but the
project boundary must recover known storage errors before exposing them. Logout has no additional
orchestration beyond deleting the provider credential.

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
orchestration. It unwraps only known project storage errors from `ModelsError` and otherwise replaces
the upstream failure with a fixed safe login error. Logout calls the project credential store
directly so storage codes and private causes are preserved without a printable `ModelsError`.

Request-auth resolution uses the provider's published `OAuthAuth` directly:

1. read the package-owned credential;
2. if it is expired, start `OAuthAuth.refresh()` inside `CredentialStore.modify()` and race it
   against the request signal and a 30-second service deadline;
3. derive request auth exactly once from the post-operation credential with `OAuthAuth.toAuth()`;
4. freeze the resulting access token for that request.

Cancellation and the deadline end the modify callback and release the lock even if the provider's
network promise remains pending. A late provider result is observed and discarded; it is never
written after the callback has ended. Provider request auth must contain exactly the access token as
`apiKey`. The service fails with `CODEX_UPSTREAM_PROTOCOL` if `headers`, `baseUrl`, or another field
appears, because the project request-auth contract cannot represent those fields without silently
discarding them.

The service never calls provider API-key resolution and injects an auth context that returns no
ambient environment or filesystem credentials.

TypeScript keeps strict checking for project source while enabling `skipLibCheck` for published
dependency declarations. This is the narrow available workaround that keeps all runtime imports on
the package's export map; no missing transitive SDK is added as a project runtime dependency. A
blocking compatibility script runs TypeScript again with declaration checking enabled and accepts
only the exact pinned Anthropic/Google SDK diagnostics. It fails if the workaround becomes
unnecessary or if any new declaration error appears.

The first release retains the file vault's two-second waiter deadline. The lock holder keeps the
lock until refresh settles, cancellation wins, or the 30-second deadline expires. A contender
either acquires the lock after that boundary or fails closed with the existing safe `lock_failed`
storage error; it never removes the lock, refreshes the same stored credential concurrently, or
interleaves logout with an accepted write.

## Consequences

- Request cancellation and the 30-second deadline release the package credential lock without
  depending on provider cancellation.
- Every accepted refresh-token rotation write remains inside the same cross-process exclusion
  domain as logout.
- A fresh credential avoids taking the writer lock.
- `Models.getAuth()` is not used for request auth at this pinned version, so a focused contract test
  must continue to verify the provider's public `OAuthAuth` and request-auth shape.
- Dependency declaration files are not internally type-checked. Project source and its use of the
  published pi-ai surface remain strictly checked, and the known-error compatibility check keeps
  the workaround observable at the exact pinned version.
- A refresh lasting more than two seconds can make a concurrent refresh or logout fail safely
  instead of waiting for completion. Replacing or extending the upstream lock protocol is a future
  storage compatibility decision, not an implicit part of OAuth integration.
- If a timed-out provider request rotates the refresh token remotely and later succeeds, its result
  is intentionally discarded after the lock is released. The next request can then require login;
  this availability tradeoff is preferable to holding the cross-process lock without a bound.
