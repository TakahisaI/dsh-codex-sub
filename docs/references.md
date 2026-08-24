# Allowed upstream references

The implementation should prefer the exact pinned tag/commit and published package declarations.

## DeepSeek Harness

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Candidate commit: https://github.com/deepseek-ai/deepseek-harness/commit/528c682e061696f5a160f363f236ecbf53cbd006
- Architecture: https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/architecture.md
- LLM adapter cookbook: https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/cookbook/adding-an-llm-adapter.md
- Plugin packaging: https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/user/develop/basic/publish.md
- pi-ai adapter package: https://github.com/deepseek-ai/deepseek-harness/tree/528c682e061696f5a160f363f236ecbf53cbd006/packages/llm/llm-pi-ai
- Cordis package: https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/vendor/cordis

## pi-ai

- Repository: https://github.com/earendil-works/pi
- Baseline tag: https://github.com/earendil-works/pi/tree/v0.82.1
- AI package: https://github.com/earendil-works/pi/tree/v0.82.1/packages/ai
- Published package: https://www.npmjs.com/package/@earendil-works/pi-ai

## OpenAI / Codex

- Authentication: https://developers.openai.com/codex/auth
- CLI reference: https://developers.openai.com/codex/cli/reference
- App Server: https://developers.openai.com/codex/app-server

OpenAI documentation confirms ChatGPT subscription sign-in for Codex clients. It does not make this
plugin an official OpenAI integration or turn ChatGPT credentials into an OpenAI Platform API key.
Before public release, re-check current terms, product documentation, and authentication behavior.
