# Release policy

## Distribution

Planned supported distribution forms after the publication prerequisites are resolved:

1. npm prerelease with built artifacts;
2. locally generated `pnpm pack` tarball.

Direct GitHub dependency installation is not supported initially. It requires an install-time
`prepare` script and user build permission, which increases supply-chain and support surface.

## Versioning

- Start at `0.1.0-alpha.0`.
- Use the npm `alpha` dist-tag.
- Plugin versions are independent of DSH versions.
- Every release notes the exact verified DSH/pi-ai combination.
- A DSH or pi-ai compatibility update normally increments the plugin patch prerelease.

The first candidate is therefore `0.1.0-alpha.0`. Release-candidate notes and package metadata may
exist before publication, but a tag or registry artifact is created only after every publication
prerequisite is complete.

## Publication prerequisites

Before the first public package:

- keep the selected MIT license and copyright notice in the candidate;
- confirm that the intended npm package name remains available immediately before publishing;
- prepare a maintainer npm account with two-factor authentication and recovery access (confirmed);
- enable GitHub branch protection;
- configure security reporting;
- verify third-party licenses and notices;
- pass packed-install and manual smoke gates.

Current automated evidence includes the Milestone 7 release gates, the project license is MIT, and
the initial npm publishing decision is accepted in ADR 0011. Registry lookup currently finds no
public package named `dsh-codex-sub`, but absence does not establish ownership or reserve the name.
npm creates a new unscoped package through its first real publish; there is no separate
package-registration step to perform now.

npm trusted publishing cannot be configured until the package exists. ADR 0011 records the
accepted bootstrap: publish the complete first Alpha interactively with two-factor authentication,
then immediately configure OIDC-backed trusted publishing for every later version. Acceptance does
not authorize publication before exact-artifact verification, manual smoke, and final approval.

Trusted-publisher administration and publishing require npm CLI `11.15.0` or a separately reviewed
later version and Node 22.14 or newer. The release workflow pins `11.15.0` for the future publishing
job. A maintainer workstation with an older npm CLI is preparation-incomplete even when its Node
version is supported; do not authenticate or publish until the CLI requirement is met.

Use the [real-account smoke record](alpha-smoke-record.md) for the maintainer-controlled gate and
the [Alpha release-candidate notes](releases/0.1.0-alpha.0.md) for release metadata. Neither
document authorizes publication.

## Release workflow

Blocking CI mirrors the release artifact topology: one Ubuntu/Node 24 job builds and uploads the
candidate, then all six Linux/macOS and Node cells verify and install that artifact without
repacking. This keeps the cross-platform artifact handoff executable before and after release
workflow activation. The release-state check rejects a missing matrix cell or a consumer that
builds or packs.

The repository contains the manually dispatched `.github/workflows/release.yml`. It contains no
registry authentication, OIDC permission, or publish command. Its scope is limited to source
checks, one clean tarball construction, a SHA-256 file, and Linux/macOS verification of that exact
unpublished workflow artifact. The workflow builds the
candidate once; every packed-install job downloads, validates, and installs the same bytes without
repacking. Its final candidate-ready job is the boundary before manual approval and still never
publishes. See ADR 0013.

The verification workflow accepts manual dispatch only from `refs/heads/main`. A dedicated
`release-ref` job always runs and fails explicitly for any other branch or tag; candidate
construction depends on that job rather than using a skippable job condition. Every third-party
GitHub Action is pinned to a reviewed full commit SHA.

Candidate validation limits the compressed tarball to 16 MiB and also reads every allowlisted file
through bounded extraction. A normal entry is limited to 2 MiB, each README to 512 KiB,
`package.json` to 64 KiB, and aggregate file contents to 8 MiB. Relative README links may point only
to files included in the package; links to repository-only documentation use canonical HTTPS
GitHub URLs so the npm-rendered and extracted READMEs do not lead to missing files.

Keep the enabled workflow limited to verification and artifact construction: do not add npm
authentication, `id-token: write`, or a publish command until the first package exists and its
trusted publisher can be configured.

The intended release sequence is:

1. create a release metadata branch and open a PR to protected `main`;
2. confirm the committed MIT license and accepted ADR 0011;
3. enable the reviewed `.github/workflows/release.yml` gate without adding a publish command;
4. update version, `private`, changelog, and limitations while preserving verified compatibility
   metadata;
5. confirm that `publishConfig` forces the public npm registry, public access, and the `alpha`
   dist-tag;
6. run `pnpm install --frozen-lockfile` and the complete check matrix, then merge the reviewed
   metadata commit into protected `main`;
7. dispatch the release gate from that exact `main` commit so it builds one tarball, records its
   SHA-256, and verifies those same bytes
   on Linux and macOS across every supported Node line;
8. download that workflow artifact and install the exact tarball into a clean DSH profile;
9. complete required manual smoke against that tarball and record its SHA-256;
10. tag the exact commit;
11. for the first package only, install npm CLI `11.15.0`, verify the candidate checksum again, and
    publish that exact tarball interactively with two-factor authentication;
12. install the exact published artifact into a clean profile and record the bootstrap provenance
    exception;
13. configure trusted publishing for the exact release workflow immediately after the package
    exists;
14. add reviewed OIDC publishing for every later version and verify its provenance.

A publish or approval job added later must depend on the candidate-install jobs and download their
workflow artifact. Rebuilding or repacking after verification invalidates the release evidence.

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
