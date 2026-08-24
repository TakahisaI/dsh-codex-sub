# pi-ai 0.83.0 compatibility spike

- Status: concluded
- Date: 2026-08-23
- Decision: **B — structurally incompatible until DSH updates its pi-ai integration**

## Evaluation rounds

The evaluation was executed twice against the same candidate so that the recorded evidence
matches the implementation this repository actually ships:

| Round | Date | Project base | Node | Test suite |
| --- | --- | --- | --- | --- |
| Initial full evaluation | 2026-08-20 | `43179cc8d555300248aacd29a4d5c1ed55632772` | 24.14.0 | 26 files / 292 tests |
| Re-execution after the DSH 0.1.1-rc.1 spikes | 2026-08-24 | this branch (base `8226467` plus this report and the probe hardening described below) | 24.19.0 | 28 files / 316 tests |

Between the rounds, PRs #46/#49/#54/#55 changed the evaluated boundary itself: the production
adapter gained fail-closed `auth` injection, a `maxRequestImageBytes` profile field, and
candidate-lane adapter-option construction (`src/dsh/adapter.ts`, `src/piai/auth-injection.ts`).
Every candidate-state number below is therefore quoted from the 2026-08-24 re-execution; the
initial round reached the same decision and is retained as history only.

The re-review of the first landing attempt also hardened the packed-install probe itself:
it now resolves pi-ai from the Host adapter's package root (the adapter declares pi-ai as a
regular dependency, so it can resolve a copy that neither the Host root nor the plugin sees),
censuses every physical pi-ai identity visible to the installed profile, rejects pi-ai
overrides/resolutions, and records all observed resolutions in its JSON report. Supported-line
runs keep every assertion; compatibility spikes may run it in a report-only topology mode so a
candidate the supported line does not declare yet can be documented without weakening the gate.

## Candidate identity

| Field | Baseline | Candidate |
| --- | --- | --- |
| DSH | `0.1.0-rc.7` | unchanged |
| DSH repository commit | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` | unchanged |
| Cordis | `4.0.1` | unchanged |
| pi-ai | `0.82.1` | `0.83.0` |
| pi-ai Git tag | `v0.82.1` = `b4f293684bba718d59cc1157679bcf6157b3a7f5` | [`v0.83.0`](https://github.com/earendil-works/pi/releases/tag/v0.83.0) = `845d6ff1f6643aba440341cce877ce1c43ebbc39` |
| pi-ai npm integrity | `sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==` | `sha512-m3IZD4g3er0V8TC9+Vpgw/sjTKqcJlkcIBy/JvsgRubuuik3tAVzyugUg4rVrShIkkOT69mEd34NEqKUIsl6JQ==` |

Lockfile and artifact identity for the 2026-08-24 candidate state (local macOS 15.6.1,
Node 24.19.0, pnpm 11.7.0):

- supported lockfile (restored after evaluation), SHA-256
  `f9a3ffabc1d1f5bc2518ee1e7334267ef16d0d32d05cb28d1aa1bde0e83f35ac`;
- temporary candidate graph lockfile, SHA-256
  `b054341b81d71d7cfbc452e5336d3ec5eb8cd057501b04a854438236aa472ece`
  (byte-identical across every candidate install);
- candidate packed tarball used for the probe below, SHA-256
  `0e0409996acadacb5d0964e2663af002d6b9c8bfa4119dc35d259ff2768a88ae`.

The candidate source was the official `v0.83.0` release and the exact
[`@earendil-works/pi-ai@0.83.0` npm artifact](https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.83.0).
No third-party integration source was inspected.

The pinned DSH adapter package,
[`@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-pi-ai/v/0.1.0-rc.7),
declares pi-ai `^0.82.1`. For a zero-major dependency that range excludes `0.83.0`.

DSH subsequently published
[`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8),
whose `@deepseek-ai/dsh-llm-pi-ai` still declares pi-ai `^0.82.1`; the current `0.1.1` line
(`0.1.1-rc.2`, re-checked in public npm metadata on 2026-08-23) declares `^0.82.1` as well. No
published DSH release satisfies the trigger for repeating this spike with pi-ai `0.83.0`. The
rc.8/0.1.1 lines are evaluated separately with exact pi-ai `0.82.1`.

## Baseline evidence

The unchanged `0.82.1` line on the re-execution base passed:

- `pnpm run check`: lint, typecheck, pinned upstream declaration audit, 28 test files /
  316 tests, boundary checks, build, emitted-entry and CLI smoke checks, compatibility,
  license, release-state, and package allowlist gates;
- provider identity `openai-codex` with the ten public own keys (`auth`, `baseUrl`,
  `filterModels`, `getModels`, `headers`, `id`, `name`, `refreshModels`, `stream`,
  `streamSimple`) re-asserted by the own-key suites;
- seven public catalog IDs: `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
  `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`. These values are compatibility evidence,
  not a runtime model allowlist; production discovers the catalog from pi-ai.

The supported baseline combination itself remains covered by the blocking Ubuntu/macOS matrix
that admitted commit `8226467` (#55), and the hardened packed-install probe described above
passes on the supported combination (2026-08-24): one shared Host copy plus one plugin copy,
both at `0.82.1`, with no additional store identities. The candidate was not submitted to that
matrix because its public type contract fails locally, as shown below.

## Public declaration and runtime drift

Method: byte-level diff of every published `.d.ts` file in the two npm artifacts, plus the
published `package.json` fields. Exactly three real declaration files differ
(`types.d.ts`, `auth/resolve.d.ts`, `auth/oauth/openrouter.d.ts`); no file was added or removed.

| Surface | Classification | Evidence | Plugin impact |
| --- | --- | --- | --- |
| Package exports and ESM loading | unchanged | export map (`./`, `./compat`, `./providers/*`, `./api/*`, `./oauth`, `./bedrock-provider`, `./bun-oauth`), `"type": "module"`, and engines (`>=22.19.0`) identical | all entry points used by the plugin load during the packed probe boot; unused subpaths are not exercised by this evidence |
| `Provider` interface and own-key surface | unchanged | `types.d.ts` `Provider` block untouched; ten own keys re-asserted by passing suites in both states | wrapper keeps its preservation guarantees |
| `streamSimple` call signature | changed (additive optional) | the shared stream-options interface gains optional `fetch?: FetchFunction`; nothing else in the signature moved | none; the package never passes `fetch`, and additive optional fields preserve assignability |
| Request auth projection (`{ apiKey }`) and bearer handling | unchanged | `apiKey?: string` and surrounding option fields untouched; request-auth suites pass in the candidate state | exact `{ apiKey }` projection contract holds |
| OAuth surface (`CredentialStore`, `OAuthCredential`, `OAuthAuth`, `AuthContext`, `AuthInteraction`) | unchanged | `auth/types.d.ts`, `auth/credential-store.d.ts`, `models.d.ts`, and `auth/oauth/openai-codex.d.ts` are byte-identical | package-owned persistence, conversion, refresh, and logout contracts unaffected |
| Generic stored-credential resolver | changed (additive optional) | `auth/resolve.d.ts`: `minOAuthValidityMs?: number` (five-minute default) | none; the package does not use pi-ai's generic resolver and keeps its own 30-second pre-expiry refresh policy |
| Cancellation / `AbortSignal` | unchanged | `signal?: AbortSignal` declarations untouched; cancellation suites pass in the candidate state | abort propagation contracts hold |
| Replay and provider metadata types | unchanged | no replay-related exported type differs (all diffs are inside the three files classified above) | replay conversion suites pass in the candidate state |
| Image/input capability metadata | changed (additive optional) | `ImagesOptions` gains optional `fetch?: FetchFunction`; capability fields themselves unchanged | none; the package declares no image inputs, and `maxRequestImageBytes` remains an adapter-owned budget independent of pi-ai |
| Model runtime and catalog APIs | unchanged | `model-catalog.d.ts`, `models*.d.ts`, and `providers/openai-codex.models.d.ts` are byte-identical; the seven catalog IDs above are stable | discovery, uniqueness, and exact-resolution suites pass in the candidate state |
| Stop reasons and assistant-message shape | changed | `StopReason` gains `"pending"`; `AssistantMessage` gains optional `rawStopReason?: string` | none inside the plugin (it consumes no `stopReason`); noted because DSH owns conversion and must tolerate the wider union when it adopts a newer pi-ai |
| Codex response runtime behavior | changed (internal hardening) | observed in the `0.83.0` artifact: partial outputs initialize as `pending`, a terminal stream without a successful stop reason is rejected, and an injected `fetch` is used when supplied | exercised by the offline suites and the packed probe below; no plugin-owned contract moved |
| OpenRouter login flow | runtime changed; public declaration comment changed | upstream changelog records manual redirect-URL / authorization-code entry for OpenRouter OAuth; the published declaration diff is a doc comment describing it | none — OpenRouter OAuth is not used by this package |

The candidate also bumped its dependency `typebox` from `1.1.38` to `1.3.7`, whose removed
deprecated aliases are documented upstream as breaking. The package does
not depend on `typebox` directly and imports none of the removed aliases through pi-ai's public
surface.

## DSH boundary result

Changing only the plugin-owned dependency to exactly `0.83.0`, while leaving DSH rc.7 and the
public compatibility claim untouched, fails project typecheck and the pinned upstream
declaration audit on the current implementation (exit codes 2 and 1 respectively). The failing
diagnostics cover `src/dsh/adapter.ts` and the candidate-lane entry construction, and they cross
the two-copy boundary:

- DSH rc.7's `ResolvedPiAiProviderProfile` is declared against pi-ai `0.82.1`;
- the plugin provider is declared against pi-ai `0.83.0`;
- their `AssistantMessageEventStream` results have separate private `queue` declarations;
- the generic provider stream from one package identity is therefore not assignable to the other,
  including for the profile objects that carry the newer `maxRequestImageBytes` field.

This occurs even though the relevant emitted declaration text of the surfaces the plugin uses is
unchanged. Matching exact package identity let the baseline type graph unify; changing the plugin
copy alone makes the private class nominal across versions. A cast would hide an unsupported DSH
contract rather than prove it.

## Offline and packed behavior

With the production compatibility document still claiming `0.82.1` (only the dependency changed):

- 315 of 316 tests passed;
- the single failure was the intentional runtime compatibility guard
  (`tests/runtime-compatibility.test.ts` recognizes the installed runtime through package
  metadata and pins the pi-ai version);
- every other OAuth, credential conversion, refresh, cancellation, catalog, adapter, retry,
  replay, attachment, stream, and secret-sentinel suite passed;
- typecheck remained a release-blocking failure as described above.

For diagnosis only, the compatibility document and the four version-constant test files were
temporarily aligned to `0.83.0` and restored immediately afterward. Under that temporary
experimental claim, on the current base (2026-08-24):

- all 28 test files / 316 tests passed;
- the fresh packed DSH rc.7 web-profile probe passed against the explicit candidate tarball
  SHA-256 `0e040999…88ae`: direct DSH/Cordis peers still resolve from the Host (six shared
  peers), eight transitive Host peer resolutions hold, the catalog reports seven unique models
  with correct display metadata and resolution identity, duplicate registration is rejected
  while the route survives, signed-out streaming fails with `CODEX_AUTH_REQUIRED` before
  provider I/O, packaged `status`/`doctor` agree with the Host, uninstall preserves
  package-owned credentials, logout removes only the credential document, and network attempts
  remain at zero.

The hardened probe recorded the actual pi-ai topology of that experiment instead of assuming it.
Because DSH rc.7's adapter declares pi-ai as a regular dependency pinned by its own resolution,
the candidate state does **not** collapse into two copies at the plugin's version — semver-wise
`^0.82.1` excludes `0.83.0`, so the adapter keeps resolving `0.82.1`. The observed topology was:

| Consumer | Resolved version | Physical copy |
| --- | --- | --- |
| Host root | `0.83.0` | development checkout virtual store (`@earendil-works+pi-ai@0.83.0…`) |
| Host adapter (`@deepseek-ai/dsh-llm-pi-ai`) | **`0.82.1`** | separate store entry (`@earendil-works+pi-ai@0.82.1…`) |
| Plugin profile | `0.83.0` | fresh profile directory (`profiles/web/node_modules/@earendil-works/pi-ai`) |

That is three physical copies across mixed versions; no pi-ai override or resolution was present,
and the census listed no additional identities beyond those copies. This experiment therefore
proves something narrower than the first draft of this report claimed: the exercised runtime
paths interoperate across this mixed three-copy topology, which is stronger evidence for
structural interoperability than a uniform-version install would be — but it does not repair the
published TypeScript contract, does not put `0.83.0` inside any DSH-declared range, and does not
describe what a production install would resolve. The supported-line probe continues to assert
exactly one shared Host copy plus the plugin copy at the supported version.

No product source or vitest suite was added or changed. The only code change is the
packed-install probe hardening described above (verification infrastructure), and the
candidate-specific version graph was removed after the conclusion so it cannot silently become
a supported CI combination.

## Decision

Choose **B**. Keep the supported and published line on pi-ai `0.82.1`. Do not add a cast,
vendored type bridge, broad version range, compatibility override, or new package adapter merely
to accept `0.83.0` with DSH rc.7.

DSH must first publish an integration whose pi-ai dependency and `ResolvedPiAiProviderProfile`
types align with `0.83.0` or a later reviewed version. No released DSH line does so today
(rc.8 and `0.1.1-rc.2` still declare `^0.82.1`, verified on 2026-08-23). After such a release
exists, rerun the full declaration, offline, packed, platform-matrix, and real-account decision
gates against one exact combination.

No real-account smoke was performed for this candidate, in either round. The offline type
boundary already blocks a release, and the temporary packed experiment found no runtime-only
question that justified using a real credential.

No Alpha is justified from this spike, and no implementation/release issue should be opened until
DSH publishes a compatible integration. When that happens, the scheduled public-contract drift
detector should report the new DSH candidate.
