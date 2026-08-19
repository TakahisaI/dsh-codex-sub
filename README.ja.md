# dsh-codex-sub

`dsh-codex-sub` は、ChatGPT契約のOAuth認証を利用し、pi-aiの `openai-codex`
プロバイダーをDSHの通常LLMモデルとして登録するための新規DeepSeek Harnessプラグインです。

> 現在はMilestone 0から4（リポジトリ基盤、純粋なcore契約、credential document codec、
> package-owned file vault、pi-ai OAuth連携、DSHのネイティブLLM provider route）まで実装済みです。
> CLIは未実装のため、account loginをpackage commandとして利用することはまだできません。

## 必須要件

1. OpenAI Platform APIキーではなく、ChatGPT/Codex OAuthを使う。
2. CodexモデルをDSHの通常モデルピッカーへ表示する。
3. Agent Loop、ツール、承認、セッション、添付、コンパクション、復旧はDSHが所有する。

このプロジェクトはCodexをサブエージェントとして呼び出すものではありません。DSHへLLM
Providerを一つ追加するだけのプラグインです。

Codexへ最初に渡す指示は [`CODEX_BOOTSTRAP_PROMPT.md`](CODEX_BOOTSTRAP_PROMPT.md)、
実装上の拘束条件は [`AGENTS.md`](AGENTS.md) にあります。
