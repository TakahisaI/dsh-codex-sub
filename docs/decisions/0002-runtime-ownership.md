# ADR 0002: DSH owns the agent runtime

- Status: accepted
- Date: 2026-08-18

## Context

Codex can be integrated as an agent through App Server, SDK, CLI, or MCP, or as a model provider
inside another harness. The product requirement is to preserve DSH tools, approvals, session log,
compaction, and recovery.

## Decision

Register the Codex subscription transport behind DSH's `ctx.llm` seam and use DSH's public
`PiAiAdapter`. Do not run a Codex agent loop inside the core plugin.

## Consequences

- DSH remains the source of model-visible history and tool behavior.
- The plugin does not expose Codex threads or Codex sandbox approvals.
- App Server/MCP integrations, if ever built, are separate products.
- DSH `PiAiAdapter` becomes a compatibility dependency covered by contract tests.
