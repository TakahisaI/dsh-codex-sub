# ADR 0010: Verify the packed Host topology before registration

- Status: accepted
- Date: 2026-08-19

## Context

DSH installs plugin bundles in a profile project while the DSH runtime packages live in the parent
Host project. Node can therefore resolve a plugin's peer dependencies from the Host, but a package
manager's profile-local peer report does not model that parent lookup. The packed package also owns
an exact pi-ai dependency, while DSH's pi-ai adapter owns its own pi-ai dependency. Two pi-ai module
copies are consequently normal in the verified installation.

Checking version metadata resolved from the plugin proves only the modules visible to the plugin.
The public `LlmRuntime` service does not expose its package version or another Host identity field,
so that check alone cannot prove that `ctx.llm` came from the verified DSH module. In addition, a
static import of an incompatible DSH export can fail while linking the package root, before a
runtime compatibility function can classify the failure safely.

The previous Node range, `^22.19.0 || >=24.0.0`, also claimed future major versions that CI had not
tested. The first alpha needs an explicit Node and operating-system boundary rather than an
optimistic forward-compatibility claim.

Adding the public DSH launcher as a development-only packed-test driver changes one known upstream
declaration diagnostic. Its dependency graph supplies Google GenAI's optional MCP package, so the
previous missing-package diagnostic disappears and TypeScript instead reaches the MCP SDK's use of
the browser `HeadersInit` global under this Node-only configuration. Project source still
type-checks strictly with the existing documented `skipLibCheck` boundary.

## Decision

Keep the six direct DSH and Cordis packages as exact peer dependencies and keep
`@earendil-works/pi-ai` as an exact package dependency. The packed-install gate must prove all of
the following in a fresh DSH Web profile:

- every direct DSH/Cordis peer resolves to the same physical package as the Host;
- no direct DSH/Cordis peer is installed as a profile-root dependency;
- the Host and plugin resolve two physical pi-ai copies at the same verified version;
- all eight peers declared by the Host's `@deepseek-ai/dsh-llm-pi-ai` package resolve from the Host;
- the bundle loads, exposes one route and a non-empty catalog, and returns
  `CODEX_AUTH_REQUIRED` before provider I/O while signed out.

After checking package metadata, require `ctx.llm` to have the exact published `LlmRuntime`
constructor identity resolved by the plugin. A different module identity fails closed with
`CODEX_INCOMPATIBLE_RUNTIME`, even if another package copy reports the same version. Public Host
errors still cross the boundary structurally: duplicate-route translation reads only an own,
enumerable `code` data property and does not rely on `Error` class identity.

Split the emitted library into a small package root and `runtime.mjs`. The root dynamically imports
the runtime module from a fixed sibling URL. Static DSH export failures then become a safe
`CODEX_INCOMPATIBLE_RUNTIME` error instead of escaping during root-module linking. Both emitted
files remain required tarball contents.

Support the tested Node lines `^22.19.0`, `^24.0.0`, and `^26.0.0`; reject odd majors,
prereleases, and later untested majors. The first alpha supports Linux and macOS. Windows remains
unsupported because the package cannot verify owner-only credential ACLs there. Package metadata
enforces the OS boundary, Ubuntu runs the packed test on every Node line, and macOS runs it on Node
24.

Pin the declaration audit to the newly reachable MCP SDK `HeadersInit` diagnostic together with the
existing documented upstream diagnostics. Any further change still fails the audit and requires a
fresh contract review.

## Consequences

- Profile-local peer-check warnings are not used as release evidence; the packed gate checks the
  actual parent Host resolution instead.
- Multiple pi-ai copies are accepted because the verified adapter boundary is structural and the
  packed signed-out request traverses it successfully without a provider `fetch`.
- A second physical DSH LLM runtime is rejected even when its version string matches.
- Adding a supported Node major or operating system requires CI evidence and an update to
  `compatibility.json`, package metadata, and this decision or a successor ADR.
- `release.yml.disabled` can build and checksum an artifact but cannot run as a GitHub workflow or
  publish anything until the maintainer resolves the license, package-name ownership, and trusted
  publishing decisions.
