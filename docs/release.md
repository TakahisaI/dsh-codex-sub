# Release policy

## Distribution

Supported distribution forms:

1. npm prerelease with built artifacts;
2. locally generated `pnpm pack` tarball.

Direct GitHub dependency installation is not supported initially. It requires an install-time
`prepare` script and user build permission, which increases supply-chain and support surface.

## Versioning

- Start at `0.1.0-alpha.0`.
- Use the npm `alpha` dist-tag.
- Move `alpha` to each newly approved prerelease, while leaving npm's bootstrap-created `latest`
  tag on `0.1.0-alpha.0` until the first stable release.
- Recommend only an explicit `@alpha` install during prerelease development; do not present an
  untagged install as the current Alpha.
- Plugin versions are independent of DSH versions.
- Every release notes the exact verified DSH/pi-ai combination.
- A DSH or pi-ai compatibility update normally increments the plugin patch prerelease.

The first published version is `0.1.0-alpha.0`. Release-candidate notes and package metadata may
exist before a later publication, but a tag or staged registry artifact is created only after every
publication prerequisite is complete. ADR 0014 records the post-bootstrap dist-tag policy.

## Initial publication record

The first public package completed these prerequisites:

- keep the selected MIT license and copyright notice in the candidate;
- confirm that the intended npm package name remains available immediately before publishing;
- prepare a maintainer npm account with two-factor authentication and recovery access (confirmed);
- enable GitHub branch protection;
- configure security reporting;
- verify third-party licenses and notices;
- pass packed-install and manual smoke gates.

The complete `0.1.0-alpha.0` artifact was published on 2026-08-19 after the release workflow and
manual real-account smoke passed. ADR 0011 records the accepted bootstrap and its one-version
provenance exception. The registry artifact matched the workflow candidate SHA-256 and passed a
fresh packed install. npm ownership, the matching GitHub prerelease, the trusted publisher, and
token restrictions are now established.

Trusted-publisher administration and publishing require npm CLI `11.15.0` or a separately reviewed
later version and Node 22.14 or newer. The release workflow pins and verifies `11.15.0` in its
staging job. A maintainer workstation with an older npm CLI cannot administer trust or approve a
staged release even when its Node version is supported.

Use the [real-account smoke record](alpha-smoke-record.md) for maintainer-controlled gates and the
[Alpha release record](releases/0.1.0-alpha.0.md) for the first publication evidence. A future
release still requires explicit staged-package approval; documentation alone never authorizes it.

## Release workflow

Blocking CI mirrors the release artifact topology: one Ubuntu/Node 24 job builds and uploads the
candidate, then all six Linux/macOS and Node cells verify and install that artifact without
repacking. This keeps the cross-platform artifact handoff executable before and after release
workflow activation. The release-state check rejects a missing matrix cell or a consumer that
builds or packs.

The repository contains the manually dispatched `.github/workflows/release.yml`. Its source checks,
one clean tarball construction, SHA-256 generation, and Linux/macOS verification all run before
registry access. The workflow builds the candidate once; every packed-install job downloads,
validates, and installs the same bytes without repacking. The candidate-ready job verifies that
artifact again before the only OIDC-capable job may stage those exact bytes. See ADR 0013.

The workflow uses one repository-specific concurrency group with cancellation disabled. A second
manual dispatch waits for the in-progress release instead of cancelling it or racing another
candidate through staging. The workflow contract rejects a missing, renamed, duplicated, nested,
flow-style, or cancellation-enabled concurrency declaration.

The workflow-level permission remains `contents: read`. Only `stage-publish` receives
`id-token: write`. npm trusts this repository and the exact `release.yml` filename, and grants that
relationship only `createStagedPackage`. The job installs and verifies npm `11.15.0`, downloads and
verifies the existing artifact, and runs `npm stage publish` with the explicit public registry,
public access, and `alpha` tag. It cannot run `npm publish`, approve or reject a staged package, use
a repository token, rebuild, or repack. A maintainer inspects and approves the staged package with
2FA outside GitHub Actions.

The verification workflow accepts manual dispatch only from `refs/heads/main`. A dedicated
`release-ref` job always runs and fails explicitly for any other branch or tag; candidate
construction depends on that job rather than using a skippable job condition. Every third-party
GitHub Action is pinned to a reviewed full commit SHA.

Candidate validation limits the compressed tarball to 16 MiB and also reads every allowlisted file
through bounded extraction. A normal entry is limited to 2 MiB, each README to 512 KiB,
`package.json` to 64 KiB, and aggregate file contents to 8 MiB. Relative README links may point only
to files included in the package; links to repository-only documentation use canonical HTTPS
GitHub URLs so the npm-rendered and extracted READMEs do not lead to missing files.

The release sequence for every later Alpha is:

1. create a release metadata branch and open a PR to protected `main`;
2. confirm the committed MIT license and accepted release decisions;
3. update version, changelog, and limitations while preserving verified compatibility
   metadata;
4. confirm that `publishConfig` forces the public npm registry, public access, and the `alpha`
   dist-tag;
5. run `pnpm install --frozen-lockfile` and the complete check matrix, then merge the reviewed
   metadata commit into protected `main`;
6. dispatch the release workflow from that exact `main` commit so it builds one tarball, records its
   SHA-256, and verifies those same bytes
   on Linux and macOS across every supported Node line;
7. let the final job stage that exact artifact through OIDC after every matrix cell passes;
8. inspect the staged package, checksum, tag, version, and provenance candidate;
9. tag the exact commit after inspection and before public approval;
10. approve the staged package interactively with two-factor authentication;
11. create a matching GitHub prerelease;
12. fetch the registry artifact into a clean profile, compare its checksum, and repeat the
    signed-out packed-install checks;
13. record the final provenance and release evidence.

Before and after approval, inspect the registry dist-tags. For an Alpha, only `alpha` may move to
the new version; `latest` remains on `0.1.0-alpha.0`. The first stable release may move `latest`
after its own review and release gates. Do not delete, overwrite, or republish an existing version
to alter this policy.

The staging job must depend on the candidate-install boundary and download its workflow artifact.
Rebuilding or repacking after verification invalidates the release evidence. Approval remains
outside the workflow so a compromised repository writer cannot make a staged package public
without maintainer proof-of-presence.

No workflow may publish from an unreviewed dependency-update branch.

The release commit must also pass the repository's protected `main` checks, and suspected security
defects must use the private process in `SECURITY.md`. Support and security reports never require a
credential, authorization URL or code, account identifier, local path, environment dump, or model
conversation.

The first alpha supports Linux and macOS on the Node lines recorded in `compatibility.json`.
Windows publication is blocked until owner-only credential ACL verification and a blocking packed
install job exist.

## Support posture

Until DSH leaves developer preview, support one verified DSH release at a time unless maintaining a
second line proves inexpensive. Unsupported versions receive a clear compatibility response rather
than speculative patches.
