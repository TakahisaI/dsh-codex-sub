# ADR 0014: Keep prerelease and stable npm channels distinct

- Status: accepted
- Date: 2026-08-19

## Context

The first publication established `dsh-codex-sub@0.1.0-alpha.0` under the explicit `alpha`
dist-tag. Because it was the package's only published version, npm also initialized its required
`latest` tag to that same Alpha. The registry rejected removing `latest` without assigning it to
another version.

Later Alpha releases need an explicit policy for these two channels. Allowing an ordinary
prerelease to advance `latest` would make an unqualified installation appear stable. Repointing
`latest` to every prerelease would also erase the distinction established by the documented
`@alpha` installation path. Deleting or republishing the bootstrap version is not an acceptable
way to repair registry metadata.

## Decision

Publish every reviewed prerelease with the explicit `alpha` dist-tag. After approval, `alpha`
moves to the newly published Alpha. During all Alpha and Beta development, leave the
bootstrap-created `latest` tag on `0.1.0-alpha.0`.

Documentation and support instructions must use `dsh-codex-sub@alpha` for the current prerelease.
They must not describe an untagged install as the current Alpha. Inspect the registry's `alpha` and
`latest` values before staging and after approval. An unexpected tag transition blocks completion
and requires a new decision; it must not be repaired by deleting, overwriting, or republishing an
existing version.

The first stable release may move `latest` only after its own reviewed metadata, compatibility,
exact-artifact, and publication gates pass. That stable-release operation is outside Milestone 8.

## Consequences

- Alpha testers always receive the newest approved prerelease through `@alpha`.
- An unqualified npm install resolves to the bootstrap Alpha until the first stable release. This
  is a deliberate conservative registry state, not a claim that `0.1.0-alpha.0` is stable.
- Release evidence records both relevant dist-tags before and after approval.
- Published versions remain immutable and no registry history is rewritten to change channel
  metadata.
