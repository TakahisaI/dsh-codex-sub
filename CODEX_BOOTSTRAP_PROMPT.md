# Initial Codex prompt

Use the following text as the first task given to Codex in this repository.

---

You are implementing `dsh-codex-sub` from a completely empty repository.

Read `AGENTS.md` first and treat it as binding. Then read, in order:

1. `README.md`
2. `docs/architecture.md`
3. `docs/api-contracts.md`
4. `docs/security.md`
5. `docs/testing.md`
6. `docs/compatibility.md`
7. `docs/implementation-plan.md`
8. every ADR under `docs/decisions/`

Obey the source policy. Use only the upstream public contracts and documentation allowed by
`AGENTS.md`.

Work only on **Milestone 0 and Milestone 1** from `docs/implementation-plan.md` in the first PR:

- establish the TypeScript package and build/test/lint configuration;
- implement pure core contracts, error taxonomy, JSON-safe validation, and redaction helpers;
- implement the versioned credential document codec with comprehensive unit tests;
- do not implement OAuth network behavior, DSH integration, or the CLI yet.

Before editing:

- inspect the supported DSH and pi-ai public package declarations at the exact versions in
  `compatibility.json`;
- record any mismatch between the design and published declarations in a new ADR rather than
  silently changing the design;
- produce a short implementation plan tied to acceptance tests.

Constraints for the first PR:

- no runtime dependency beyond those already approved in the design;
- no access-token parsing;
- no model IDs hard-coded;
- no browser or DSH Web code;
- no real credentials or network tests;
- no source files imported from upstream repositories;
- `pnpm run check` must pass;
- include a PR-ready summary of changed files, tests, and unresolved contract questions.

Stop after Milestone 1 is complete. Do not proceed to OAuth or DSH integration in the same PR.
