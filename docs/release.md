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

## Publication prerequisites

Before the first public package:

- choose and commit a license;
- confirm npm package-name ownership;
- configure npm trusted publishing/OIDC;
- enable GitHub branch protection;
- configure security reporting;
- verify third-party licenses and notices;
- pass packed-install and manual smoke gates.

## Release workflow

The repository contains `.github/workflows/release.yml.disabled`. GitHub does not load it as a
workflow, and it contains no registry authentication or publish command. If enabled later, its
current scope is limited to the full checks, packed installs, tarball construction, a SHA-256 file,
and an unpublished workflow artifact.

Do not rename or extend that file until the maintainer has selected the license, confirmed npm
package-name ownership, and chosen the trusted-publishing mechanism.

After those decisions, the intended release sequence is:

1. create a release branch;
2. update version, compatibility data, changelog, and limitations;
3. run `pnpm install --frozen-lockfile`;
4. run the complete check matrix;
5. build and inspect the tarball;
6. install the exact tarball into a clean DSH profile;
7. complete required manual smoke;
8. tag the exact commit;
9. publish through trusted publishing;
10. verify npm provenance and install the published artifact into a clean profile.

No workflow may publish from an unreviewed dependency-update branch.

The first alpha supports Linux and macOS on the Node lines recorded in `compatibility.json`.
Windows publication is blocked until owner-only credential ACL verification and a blocking packed
install job exist.

## Support posture

Until DSH leaves developer preview, support one verified DSH release at a time unless maintaining a
second line proves inexpensive. Unsupported versions receive a clear compatibility response rather
than speculative patches.
