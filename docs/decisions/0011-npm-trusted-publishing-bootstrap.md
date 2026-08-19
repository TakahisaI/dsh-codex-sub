# ADR 0011: Bootstrap npm ownership before trusted publishing

- Status: accepted
- Date: 2026-08-19

## Context

The release plan assumed that npm trusted publishing could be configured before the first public
version. The published npm contract does not support that order for a new package: package names
are established by a real first publish, while `npm trust` requires the package to exist in the
registry already. A registry lookup on 2026-08-19 found no public package named `dsh-codex-sub`,
but that result neither reserves the name nor establishes ownership.

Publishing an empty or artificial version only to hold the name is not an acceptable bootstrap.
The first registry artifact must be a reviewed, installable release that has passed the same
security and compatibility gates as every later Alpha. The package cannot silently fall back to a
long-lived npm token merely to preserve the original workflow order.

Relevant upstream contracts:

- [npm package-name disputes and username policy](https://docs.npmjs.com/policies/disputes/);
- [`npm trust`, including the existing-package prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/);
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/);
- [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

## Decision

Do not publish a placeholder or treat a successful name lookup as ownership. The maintainer has
prepared the npm account, enabled authorization-and-writes two-factor authentication, and stored
the generated recovery codes. Package ownership is not established until the actual
`0.1.0-alpha.0` candidate has passed every automated gate, the manual real-account smoke,
verification of the selected MIT license, and final tarball review.

Bootstrap the first real Alpha from a clean maintainer-controlled workstation using interactive
npm authentication with two-factor authentication and the `alpha` dist-tag. Do not create or
store a repository publishing token for this step. Record that this one version cannot carry
trusted-publisher provenance because the publisher could not be configured before the package
existed.

Before the first public metadata commit, enable the reviewed `.github/workflows/release.yml` as a
non-publishing release gate. It may verify and retain the candidate artifact, but it must contain no
npm credential, OIDC permission, or publish command. Package metadata must force public access and
the `alpha` dist-tag so the interactive bootstrap cannot update `latest` by omission.

Immediately after the package exists, configure that exact workflow as its trusted publisher,
restrict conventional token publishing in npm package settings, and add OIDC-backed publishing in
a reviewed follow-up for every later version. Prefer npm's staged-publishing approval flow. Verify
the next published Alpha's provenance and install that exact registry artifact in a clean DSH
profile.

On 2026-08-19 the maintainer explicitly accepted this one-release provenance exception after
enabling npm two-factor authentication and securing its recovery codes. This acceptance does not
authorize publication by itself: the exact candidate must still pass the release workflow and
manual real-account smoke, and the maintainer must explicitly approve the final publish action.

## Consequences

- npm registration occurred through the first real Alpha publish; the account-hardening gate is
  complete.
- `0.1.0-alpha.0` must be a complete release rather than a name-reservation artifact.
- The first Alpha's release record must state that trusted-publisher provenance is unavailable and
  link to this accepted decision.
- The release workflow was enabled before the first public metadata commit as a non-publishing
  verification workflow. After the package existed, a reviewed follow-up added OIDC staging.
- A repository token is not introduced as an undocumented bootstrap shortcut.
- Release documentation must not claim that an unused registry name is owned or reserved.

## Outcome

On 2026-08-19 the maintainer published the exact verified `0.1.0-alpha.0` tarball interactively
with two-factor authentication. Commit
`d9179684fbc82ed62eaab40b6b05f34e5d64321e` and tarball SHA-256
`009618b9205d675d9e19ca5e20584d0df46da0f70c3ec9398a1c212acb29adfe` identify the release. The
artifact fetched back from npm matched those bytes and passed packed installation again. The
matching GitHub release is a prerelease.

npm initialized both `alpha` and its required `latest` metadata tag to the sole published version.
An authenticated attempt to remove `latest` was rejected by the registry. No version was deleted,
overwritten, or republished. This is a first-package bootstrap consequence, not a declaration that
the Alpha is stable.

Immediately afterward, npm Trusted Publishing was restricted to GitHub repository
`TakahisaI/dsh-codex-sub` and workflow filename `release.yml`. The relationship permits only
`createStagedPackage`, not direct publication. Package publishing access now requires two-factor
authentication and disallows conventional tokens. Future workflow releases therefore stage the
exact verified artifact through OIDC and require a maintainer to approve it separately with 2FA.
