# Security model

## 1. Assets

The primary secrets are:

- OAuth access token;
- OAuth refresh token;
- ChatGPT account/workspace identifier or other provider-specific auth data;
- OAuth authorization code and PKCE material while login is in progress.

Secondary assets are model request contents and local filesystem metadata. The core plugin does not
persist request contents.

## 2. Trust boundaries

```text
terminal user
    │
    ▼
package CLI ─────── browser/ChatGPT OAuth
    │
    ▼
credential vault on local filesystem
    │
    ▼
pi-ai auth resolution and refresh
    │
    ▼
DSH model request
    │
    ▼
OpenAI/ChatGPT backend
```

DSH, pi-ai, Node.js, the operating system, and the current user's process are trusted dependencies.
Network responses, stored files, environment variables, command-line input, and upstream errors are
untrusted input.

## 3. Threats in scope

### 3.1 Another local OS user reads credentials

Mitigation:

- plugin directory mode 0700 and auth file mode 0600 on POSIX;
- reject existing broader permissions;
- do not offer a configuration switch to weaken permissions.

### 3.2 Symlink or path substitution

Mitigation:

- resolve the DSH home through the official helper;
- use a fixed plugin-owned child directory and filename;
- reject a symbolic link at the plugin directory or auth document;
- never accept an auth path from model input, DSH settings, or CLI flags.

### 3.3 Partial write or concurrent refresh corrupts credentials

Mitigation:

- one cross-process lock for modify and delete;
- atomic replace within the same directory;
- fsync/atomic helper behavior verified by tests or upstream contract;
- the pinned lock helper backs off for two seconds, then fails closed without removing the existing
  lock;
- decode the candidate before committing it.

### 3.4 Refresh races rotate the token twice

Mitigation:

- pi-ai refresh must execute inside `CredentialStore.modify()`;
- `modify()` re-reads the current document after acquiring the lock;
- the callback receives the current credential;
- the post-write credential is returned to the caller.

### 3.5 Secret leakage in output

Mitigation:

- errors use fixed safe messages and machine codes;
- diagnostics use projections, never raw objects;
- no generic serialization of caught errors across a UI or CLI JSON boundary;
- redaction covers bearer headers, token-like JWTs, OAuth query parameters, account identifiers, and
  authorization codes;
- tests inject unique sentinels and scan stdout, stderr, logs, reports, snapshots, and error strings.

### 3.6 Ambient API key silently authenticates the route

Mitigation:

- request auth comes only from the plugin-owned OAuth service;
- the pi-ai provider wrapper resolves no environment variable, file, or unrelated ambient
  credential;
- its non-secret configured marker is rejected by the wrapper's stream methods and can never reach
  the upstream wire implementation;
- each DSH request resolves one OAuth token before constructing its request-local adapter delegate;
- missing OAuth produces `CODEX_AUTH_REQUIRED` before network I/O.

### 3.7 Malformed or oversized credential document

Mitigation:

- read at most 64 KiB;
- strict top-level schema;
- bounded token lengths and provider data;
- maximum nesting depth and key count;
- reject non-finite numbers and non-plain objects;
- never quote the rejected input in an error.

### 3.8 Untrusted authorization URL

Mitigation during CLI login:

- parse URL before displaying or opening it;
- allow HTTPS only, with no username/password;
- accept loopback HTTP only when explicitly required by the upstream callback contract and never as
  the authorization destination;
- reject an explicit pi-ai OAuth callback bind host unless it is the loopback literal
  `127.0.0.1` or `::1`;
- do not persist or include the URL in diagnostics;
- cancel the login on invalid events.
- open a validated authorization destination only after an explicit Enter confirmation;
- use only the absolute `/usr/bin/open` (macOS) or `/usr/bin/xdg-open` (Linux) opener with
  `shell: false`, ignored stdio, a bounded timeout, and cancellation cleanup. Linux receives exactly
  `PATH=/usr/bin:/bin`; `HOME`, `BROWSER`, loader variables, shell startup files, Node injection,
  and all other ambient values are omitted. `XDG_RUNTIME_DIR` is copied only when its absolute,
  control-free, at-most-4096-byte `lstat` path is a current-user-owned directory with no group or
  other permission bits. Local `DISPLAY` must match `:[0-9]+` with an optional `.[0-9]+`; a
  `WAYLAND_DISPLAY` basename is accepted only when its current-user-owned socket exists under that
  runtime directory. The DBus source value is never copied: a current-user-owned runtime `bus`
  socket is represented as `unix:path=<runtime>/bus`. Strict bounded allow-lists cover desktop and
  session names/types. Without a validated local DISPLAY, Wayland socket, or runtime bus route,
  no native process is spawned. The child is unrefed exactly once immediately after spawn; the
  bounded open timer remains referenced until settlement and SIGTERM is the only kill signal.
- keep manual opening available when the native opener is unsupported or fails;
- read secret and manual-code prompts through a non-echoing terminal path;
- propagate cancellation to pending prompts and remove their listeners.

### 3.9 Supply-chain or incompatible upstream change

Mitigation:

- exact verified versions in `compatibility.json` and release dependencies;
- package-lock integrity through pnpm;
- dependency review and provenance checks;
- packed-install tests that verify Host dependency identity and block provider `fetch` while signed
  out;
- scheduled non-publishing canaries;
- fail closed on unsupported runtime combinations.

## 4. Threats outside the security boundary

The first release does not attempt to protect against:

- root/administrator access;
- another process running as the same OS user;
- a compromised DSH, pi-ai, Node.js, package manager, or operating system;
- screen capture, shell history, terminal logging, browser compromise, or clipboard compromise;
- upstream account suspension, policy changes, quota changes, or model withdrawal;
- memory scraping from the running process;
- Windows owner-only ACL hardening beyond what the selected filesystem utility can guarantee.

Windows is therefore outside the first-alpha supported operating systems rather than being treated
as a partially secured target.

These limitations must be stated honestly. Do not describe plaintext local token storage as encrypted.

## 5. Credential file rules

- Path: `$DSH_HOME/dsh-codex-sub/auth.json`.
- No alternate path flag in the first release.
- No migration or import from Codex CLI, ChatGPT Desktop, or another plugin.
- No export command.
- Logout removes only this package's file.
- Uninstall does not remove credentials automatically.
- The package never modifies `~/.codex`.

## 6. Network rules

- The plugin itself does not implement general-purpose fetch, proxy, search, image, or URL tools.
- OAuth and model network calls are delegated to the pinned pi-ai provider.
- OAuth refresh is bounded at the service boundary so a stalled provider request cannot hold the
  package credential lock indefinitely. Caller cancellation does not cancel refresh work shared by
  another request; the independent coordinator deadline remains authoritative.
- Refresh lock-contention recovery only re-reads or retries through the vault API. It never removes
  a lock or writes outside the cross-process exclusion boundary.
- No arbitrary base URL or header configuration is exposed.
- No telemetry endpoint exists.

## 7. Security review checklist

A release touching auth or storage must answer:

1. Can any new value contain a secret?
2. Can it reach a log, error, diagnostic, event, or CLI JSON object?
3. Does any operation bypass the credential lock?
4. Can an attacker redirect the auth path or endpoint?
5. Can an ambient credential become a fallback?
6. Does a new dependency execute install scripts?
7. Does a new upstream version change credential fields, refresh behavior, or provider auth?
8. Are old credentials still decoded safely or is a migration required?
9. Does cancellation leave callback servers, timers, or locks alive?
10. Are tests using generated fake values only?
