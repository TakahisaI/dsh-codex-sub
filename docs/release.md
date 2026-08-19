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

The first candidate is therefore `0.1.0-alpha.0`. Draft notes may exist before the package metadata
is changed, but a version, tag, or registry artifact is created only after every publication
prerequisite is complete.

## Publication prerequisites

Before the first public package:

- choose and commit a license;
- confirm that the intended npm package name remains available immediately before publishing;
- prepare a maintainer npm account with two-factor authentication and recovery access;
- enable GitHub branch protection;
- configure security reporting;
- verify third-party licenses and notices;
- pass packed-install and manual smoke gates.

Current automated evidence is complete through Milestone 6. The project license and initial npm
publishing decision remain maintainer gates. Registry lookup currently finds no public package
named `dsh-codex-sub`, but absence does not establish ownership or reserve the name. npm creates a
new unscoped package through its first real publish; there is no separate package-registration step
to perform now.

npm trusted publishing cannot be configured until the package exists. ADR 0011 records the
proposed bootstrap: publish the complete first Alpha interactively with two-factor authentication,
then immediately configure OIDC-backed trusted publishing for every later version. The maintainer
must accept that first-version provenance exception, or choose to defer publication, before the
release workflow is enabled.

Use the [real-account smoke record](alpha-smoke-record.md) for the maintainer-controlled gate and
the [draft Alpha notes](releases/0.1.0-alpha.0.md) for release metadata. Neither document authorizes
publication.

## Release workflow

The repository contains `.github/workflows/release.yml.disabled`. GitHub does not load it as a
workflow, and it contains no registry authentication or publish command. If enabled later, its
current scope is limited to the full checks, packed installs, tarball construction, a SHA-256 file,
and an unpublished workflow artifact.

Do not rename or extend that file until the maintainer has selected the license, accepted or
replaced ADR 0011's bootstrap decision, and completed the first package publish.

After those decisions, the intended release sequence is:

1. create a release branch;
2. update version, compatibility data, changelog, and limitations;
3. run `pnpm install --frozen-lockfile`;
4. run the complete check matrix;
5. build and inspect the tarball;
6. install the exact tarball into a clean DSH profile;
7. complete required manual smoke;
8. tag the exact commit;
9. for the first package only, publish interactively with two-factor authentication and the
   `alpha` dist-tag;
10. configure trusted publishing immediately after the package exists;
11. install the exact published artifact into a clean profile and record the bootstrap provenance
    exception;
12. publish every later version through the reviewed OIDC workflow and verify its provenance.

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
