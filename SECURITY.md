# Security policy

> This project closed on 2026-09-20. No versions receive security fixes. For a sensitive
> report about an existing installation, use the private reporting channel below and do not
> include credentials. Users should log out and uninstall the plugin when they no longer need it.

## Supported versions

None. The previously published Alpha versions are unmaintained.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/TakahisaI/dsh-codex-sub/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Never include any of the following in a report:

- access or refresh tokens;
- authorization URLs, authorization codes, or PKCE values;
- `auth.json` or another credential file;
- account, workspace, email, or plan identifiers;
- complete environment dumps, model conversations, or local filesystem paths.

Include only the affected package version or commit, Node and DSH versions, a sanitized
`doctor --json` report, reproduction steps using fake values, and the security impact. If a real
account was involved, state that fact without describing the account or its responses.

## Release-blocking severity

The following defects block a release:

- a secret can reach logs, errors, diagnostics, artifacts, settings, or public APIs;
- credential permissions, symlink rejection, atomic replacement, or cross-process exclusion can be
  bypassed;
- an ambient API key or unrelated credential can authenticate `openai-codex`;
- a signed-out or invalid request can reach provider network I/O before the documented auth check;
- a runtime mismatch can bypass fail-closed compatibility checks;
- the packed artifact can include credentials, local paths, development-only files, or unreviewed
  executable dependencies;
- provider registration can replace or corrupt an existing route.

Availability defects that cannot expose or corrupt credentials are assessed separately, but a
repeatable failure of a documented release gate still blocks that release.

## Disclosure and remediation

The maintainer will use the private advisory to coordinate validation, a fix, and disclosure.
Published package versions are immutable. If a released Alpha is unsafe, it will be deprecated and
replaced by a new version rather than deleted or overwritten.
