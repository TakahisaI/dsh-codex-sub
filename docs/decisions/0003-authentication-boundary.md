# ADR 0003: Package-owned OAuth lifecycle

- Status: accepted
- Date: 2026-08-18

## Context

Reading Codex CLI or desktop credentials would couple the plugin to another application's private
state. DSH's general credential-reference seam is designed for string secrets and does not represent
a refresh token, access token, expiry, provider-specific fields, and cross-process refresh mutation
as one atomic object.

## Decision

The package owns a separate versioned OAuth credential document under `$DSH_HOME/dsh-codex-sub`.
pi-ai performs the provider OAuth and refresh behavior through its published auth contracts. A
project adapter maps between the project document and pi-ai's credential type.

## Consequences

- Users log in separately for this plugin.
- The plugin never reads or writes `~/.codex`.
- Refresh can be serialized correctly across DSH and CLI processes.
- A future keychain implementation can replace the file vault behind the same project port.
- Plaintext local storage relies on OS permissions and is documented honestly.

## File-vault implementation

The first vault implementation resolves the fixed package child through the public
`@deepseek-ai/dsh-home-paths` API. It uses the public `@deepseek-ai/dsh-atomic-write` lock and atomic
replacement helpers with one lock target for both modify and delete operations.

On POSIX, the package directory and document use modes `0700` and `0600`; existing group or other
permission bits fail closed. The directory and document are inspected without following the final
path component, and document reads additionally use `O_NOFOLLOW`. Windows keeps the same fixed-path,
bounded-read, atomicity, and concurrency behavior, but reports owner-only permission verification as
unsupported because this release does not verify Windows ACLs.

The upstream atomic replacement contract is atomic but not crash-durable because it does not fsync
the file or parent directory. Its writer lock also leaves orphan recovery to an operator after a
process exits while holding the lock. These limitations are accepted for the first file vault and
must not be described as stronger durability or automatic stale-lock recovery.
