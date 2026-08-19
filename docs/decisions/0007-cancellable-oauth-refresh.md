# ADR 0007: Shared, bounded OAuth refresh under the credential lock

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

The published refresh contract also has no structured error discriminator. Its declaration says
that refresh may throw for failures such as `invalid_grant`, but it does not publish an error class,
code, or other field that distinguishes permanent authentication rejection from a transient
transport failure. Parsing error messages would make both security and compatibility depend on
unstable prose.

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
refresh can exceed that deadline. A second service instance can therefore receive a safe
`lock_failed` result even though the lock holder is about to publish a usable refreshed credential.

## Decision

`CodexAuthService` uses one `Models` collection containing exactly `openaiCodexProvider()` for login
orchestration. It unwraps only known project storage errors from `ModelsError` and otherwise replaces
the upstream failure with a fixed safe login error. Logout calls the project credential store
directly so storage codes and private causes are preserved without a printable `ModelsError`.

Request-auth resolution uses the provider's published `OAuthAuth` directly:

1. read the package-owned credential;
2. if it expires within 30 seconds, join or create a process-local refresh flight for that exact
   credential generation;
3. run `OAuthAuth.refresh()` inside `CredentialStore.modify()` and race the shared operation against
   a 30-second service deadline;
4. after a safe `lock_failed`, re-read the document, reuse an externally refreshed credential when
   available, or retry while the credential is stale and the shared deadline remains open;
5. derive request auth exactly once from the post-operation credential with `OAuthAuth.toAuth()`;
6. freeze the resulting access token for that request.

Each request signal cancels only that request's wait. It does not abort a refresh already shared
with another request. The shared coordinator's deadline ends the modify callback and releases the
lock even if the provider's network promise remains pending. A late provider result is observed and
discarded; it is never written after the callback has ended. Provider request auth must contain
exactly the access token as `apiKey`. The service fails with `CODEX_UPSTREAM_PROTOCOL` if `headers`,
`baseUrl`, or another field appears, because the project request-auth contract cannot represent
those fields without silently discarding them.

Caller cancellation remains a fixed `AbortError`. The shared service deadline—including lock
contention that remains stale until that deadline—and an unclassified provider refresh failure use
`CODEX_AUTH_REFRESH_FAILED` with a fixed safe reason. `CODEX_REAUTH_REQUIRED` is reserved for a
failure that an upstream contract can identify as requiring renewed user authentication. The pinned
pi-ai contract cannot make that identification, so this package does not infer it from an exception
message. This is an explicit unresolved upstream assumption rather than a guessed `invalid_grant`
parser.

The service never calls provider API-key resolution and injects an auth context that returns no
ambient environment or filesystem credentials.

TypeScript keeps strict checking for project source while enabling `skipLibCheck` for published
dependency declarations. This is the narrow available workaround that keeps all runtime imports on
the package's export map; no missing transitive SDK is added as a project runtime dependency. A
blocking compatibility script runs TypeScript again with declaration checking enabled and accepts
only the exact pinned Anthropic/Google SDK diagnostics. It fails if the workaround becomes
unnecessary or if any new declaration error appears. The `@types/node` development dependency is
pinned exactly so a floating ambient-type update cannot change those expected counts independently
of the upstream contract under test.

The first release retains the file vault's two-second waiter deadline and never removes another
process's lock. A refresh contender may recover from `lock_failed` only by re-reading and retrying
through the ordinary vault API under the shared bounds. Logout retains the vault's normal safe
`lock_failed` behavior. No accepted refresh or logout write occurs outside the file lock.

## Consequences

- Request cancellation returns promptly without invalidating useful shared work. The 30-second
  coordinator deadline releases the package credential lock without depending on provider
  cancellation.
- Every accepted refresh-token rotation write remains inside the same cross-process exclusion
  domain as logout.
- A credential with more than 30 seconds remaining avoids taking the writer lock. Status uses the
  same window, so `refreshExpected` predicts request behavior.
- Concurrent callers in one service instance issue one provider refresh per credential generation.
- A second service instance can recover after the upstream two-second lock wait without deleting
  the lock or issuing a duplicate provider refresh.
- `Models.getAuth()` is not used for request auth at this pinned version, so a focused contract test
  must continue to verify the provider's public `OAuthAuth` and request-auth shape.
- Dependency declaration files are not internally type-checked. Project source and its use of the
  published pi-ai surface remain strictly checked, and the known-error compatibility check keeps
  the workaround observable at the exact pinned version.
- A refresh lasting more than two seconds can still make concurrent logout fail safely. Refresh
  contenders have bounded recovery, but replacing or extending the upstream lock protocol remains
  a future storage compatibility decision.
- The pinned pi-ai contract cannot distinguish `invalid_grant` from retryable transport failure.
  Until it publishes a structured discriminator, unclassified failures remain
  `CODEX_AUTH_REFRESH_FAILED` rather than being mislabeled as `CODEX_REAUTH_REQUIRED`.
- If a timed-out provider request rotates the refresh token remotely and later succeeds, its result
  is intentionally discarded after the lock is released. The next request can then require login;
  this availability tradeoff is preferable to holding the cross-process lock without a bound.
