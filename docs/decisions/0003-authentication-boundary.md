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
