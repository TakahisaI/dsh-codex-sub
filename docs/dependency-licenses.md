# Dependency license audit

## Release-candidate baseline

The lockfile's production dependency graph was inspected with `pnpm licenses list --prod --json`
against the Milestone 6 verified versions. Every entry had a recognized permissive license:

| SPDX expression | Package count |
| --- | ---: |
| MIT | 111 |
| Apache-2.0 | 44 |
| BSD-3-Clause | 13 |
| ISC | 7 |
| BSD-2-Clause | 1 |
| 0BSD | 1 |

The direct pi-ai dependency and the direct DSH/Cordis peers declare MIT. No dependency in this
audit reported an unknown, unlicensed, copyleft, or non-commercial classification.
No `NOTICE`, `NOTICE.txt`, or `NOTICE.md` file was present in the installed dependency tree at this
baseline.

The package build keeps upstream packages as external imports. Its npm tarball does not copy their
source or license files; npm installs those packages as separate artifacts carrying their own
metadata. The project contains no code copied from a third-party DSH-Codex integration.

## Release procedure

Rerun the production license report after any lockfile or dependency change. Review new license
expressions, bundled assets, and upstream notice files before publication. The project itself is
licensed under MIT. It remains `private: true` until the separate publication and npm bootstrap
gates are complete.

`pnpm run check:licenses` enforces the reviewed SPDX-expression set. A new expression fails CI and
requires a fresh license and notice review rather than being accepted automatically.
