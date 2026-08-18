# ADR 0001: Minimal provider-only core

- Status: accepted
- Date: 2026-08-18

## Context

The project must combine ChatGPT subscription authentication, DSH model selection, and DSH ownership
of the agent loop. Optional features would increase the number of DSH surfaces and upstream
protocols the maintainer must track.

## Decision

The core package provides only OAuth credential lifecycle and one `openai-codex` LLM provider route.
It has no Web UI, search, image-fetching tools, usage API, Fast Mode, default-model mutation, or
subagent runtime.

## Consequences

- The first release is small and Host-only.
- Login is performed through the package CLI.
- Future capabilities require a separate ADR and preferably a separate package.
- Users configure their default model through DSH, not this plugin.
