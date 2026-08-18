# ADR 0005: CLI-first authentication

- Status: accepted
- Date: 2026-08-18

## Context

A Web account card would require DSH Client packaging, Host routes, browser trust rules, localization,
and additional compatibility testing. None is required to satisfy the three core product
requirements.

## Decision

The first release performs login and logout through the package executable. The DSH runtime only
reads and refreshes the package-owned credential.

## Consequences

- The plugin is usable in Web and headless profiles without a client bundle.
- Remote DSH users run login on the machine that owns `$DSH_HOME`.
- A future Web account surface must call semantic account operations and may never receive raw
  tokens.
