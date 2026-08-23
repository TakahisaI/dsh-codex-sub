# pi-ai 0.83.0 compatibility spike

- Status: concluded
- Date: 2026-08-20
- Decision: **B — structurally incompatible until DSH updates its pi-ai integration**

## Candidate identity

The verified baseline was frozen before changing the candidate:

| Field | Baseline | Candidate |
| --- | --- | --- |
| Project commit | `43179cc8d555300248aacd29a4d5c1ed55632772` | same spike base |
| Project lockfile SHA-256 | `f9a3ffabc1d1f5bc2518ee1e7334267ef16d0d32d05cb28d1aa1bde0e83f35ac` | restored after evaluation |
| DSH | `0.1.0-rc.7` | unchanged |
| DSH repository commit | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` | unchanged |
| Cordis | `4.0.1` | unchanged |
| pi-ai | `0.82.1` | `0.83.0` |
| pi-ai Git commit | `b4f293684bba718d59cc1157679bcf6157b3a7f5` | [`845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/earendil-works/pi/commit/845d6ff1f6643aba440341cce877ce1c43ebbc39) |
| pi-ai npm integrity | `sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==` | `sha512-m3IZD4g3er0V8TC9+Vpgw/sjTKqcJlkcIBy/JvsgRubuuik3tAVzyugUg4rVrShIkkOT69mEd34NEqKUIsl6JQ==` |

The candidate source was the official
[`v0.83.0` release](https://github.com/earendil-works/pi/releases/tag/v0.83.0) and the exact
[`@earendil-works/pi-ai@0.83.0` npm artifact](https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.83.0).
No third-party integration source was inspected.

The local evaluation used macOS `15.6.1`, Node `24.14.0`, and pnpm `11.7.0`. The packed baseline
had already passed the blocking Ubuntu and macOS matrix on Node `22.19.0`, `24`, and `26`; the
candidate was not submitted to that matrix because its public type contract failed locally.

The pinned DSH adapter package,
[`@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-pi-ai/v/0.1.0-rc.7),
declares pi-ai `^0.82.1`. For a zero-major dependency that range excludes `0.83.0`.

DSH subsequently published
[`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
at commit
[`141eb6fef83422698aef7a981029e843e8161534`](https://github.com/deepseek-ai/deepseek-harness/commit/141eb6fef83422698aef7a981029e843e8161534).
Its `@deepseek-ai/dsh-llm-pi-ai` package still declares pi-ai `^0.82.1`, so rc.8 does not satisfy the
trigger for repeating this spike with pi-ai `0.83.0`. The rc.8 line is evaluated separately with
exact pi-ai `0.82.1`; its required image-budget profile field does not change this decision.

## Baseline evidence

The unchanged `0.82.1` line passed:

- `pnpm run check`: 26 test files and 292 tests, plus typecheck, declaration audit, build,
  emitted-entry checks, compatibility, license, release-state, and package allowlist;
- packed installation with DSH `0.1.0-rc.7`: seven catalog models, six Host-shared direct
  DSH/Cordis peers, two physical pi-ai copies, eight transitive Host peer resolutions, and zero
  network attempts;
- provider identity `openai-codex`, ten public own keys, and seven public catalog IDs.

The own keys were `auth`, `baseUrl`, `filterModels`, `getModels`, `headers`, `id`, `name`,
`refreshModels`, `stream`, and `streamSimple`. The public catalog IDs were:

- `gpt-5.3-codex-spark`;
- `gpt-5.4`;
- `gpt-5.4-mini`;
- `gpt-5.5`;
- `gpt-5.6-luna`;
- `gpt-5.6-sol`;
- `gpt-5.6-terra`.

These values are compatibility evidence, not a runtime model allowlist. Production continues to
discover the catalog from pi-ai.

The sorted provider-own-key and model-ID snapshot SHA-256 was
`de9c3f9e87e319ed21b89678418623b00859f192b768a4b550b364af70cdeed7`.

## Public declaration and runtime drift

The following relevant declarations were unchanged between `0.82.1` and `0.83.0`:

- package export map and Node engine floor;
- `Provider`, provider own-key surface, and the `openai-codex` provider declaration;
- `CredentialStore`, `OAuthCredential`, `OAuthAuth`, `AuthContext`, and `AuthInteraction`;
- `AssistantMessageEventStream` and the Codex stream call signature;
- provider catalog contents and IDs.

The candidate added these public surfaces:

- optional per-request `fetch` injection for text and image transports;
- `pending` as a partial-message stop reason and `rawStopReason` on assistant messages;
- `minOAuthValidityMs` for the generic stored-credential resolver;
- TypeBox `1.3.7`, whose removed deprecated aliases are documented as a breaking change.

The Codex response runtime now initializes a partial output with `pending`, rejects a terminal
stream that never receives a successful stop reason, and uses an injected fetch implementation
when supplied. The project does not use pi-ai's generic credential resolver, so its new five-minute
minimum refresh window does not replace the package-owned 30-second refresh policy.

The candidate retained the same provider/catalog snapshot SHA-256 and model count as the baseline.

## DSH boundary result

Changing only the plugin-owned dependency to `0.83.0`, while leaving DSH rc.7 and the public
compatibility claim untouched, failed project typecheck and the pinned upstream declaration audit.

The failure crosses the two-copy boundary:

- DSH rc.7's `ResolvedPiAiProviderProfile` is declared against pi-ai `0.82.1`;
- the plugin provider is declared against pi-ai `0.83.0`;
- their `AssistantMessageEventStream` results have separate private `queue` declarations;
- the generic provider stream from one package identity is therefore not assignable to the other.

This occurs even though the relevant emitted declaration text is unchanged. Matching exact package
identity let the baseline type graph unify; changing the plugin copy alone makes the private class
nominal across versions. A cast would hide an unsupported DSH contract rather than prove it.

## Offline and packed behavior

With the production compatibility document still on `0.82.1`:

- 288 of 292 tests passed;
- the four failures were the intentional runtime compatibility guard and plugin-startup checks;
- every other OAuth, credential conversion, refresh, cancellation, catalog, adapter, retry,
  replay, attachment, stream, and secret-sentinel suite passed;
- the emitted package still built, but typecheck remained a release-blocking failure.

For diagnosis only, the compatibility document was temporarily aligned to `0.83.0` and restored
immediately afterward. Under that temporary experimental claim:

- 290 of 292 tests passed; the remaining two assertions intentionally contained the baseline
  compatibility constants;
- a fresh packed DSH rc.7 profile passed with the same two-copy topology, catalog count, route,
  signed-out auth failure, disposal behavior, and zero network attempts as the baseline.

This proves runtime structural interoperability for the exercised paths, but it does not repair the
published TypeScript contract or bring `0.83.0` into DSH rc.7's declared dependency range.

No product test was added or changed. The existing offline suites already exercised every relevant
project boundary, and the candidate-specific version graph was removed after the conclusion so it
cannot silently become a supported CI combination.

## Decision

Choose **B**. Keep the supported and published line on pi-ai `0.82.1`. Do not add a cast, vendored
type bridge, broad version range, compatibility override, or new package adapter merely to accept
`0.83.0` with DSH rc.7.

DSH must first publish an integration whose pi-ai dependency and `ResolvedPiAiProviderProfile`
types align with `0.83.0` or a later reviewed version. DSH rc.8 does not do so. After such a release
exists, rerun the full declaration, offline, packed, platform-matrix, and real-account decision
gates against one exact combination.

No real-account smoke was performed for this candidate. The offline type boundary already blocks a
release, and the temporary packed experiment found no runtime-only question that justified using a
real credential.

No Alpha is justified from this spike, and no implementation/release issue should be opened until
DSH publishes a compatible integration. When that happens, the scheduled public-contract drift
detector should report the new DSH candidate.
