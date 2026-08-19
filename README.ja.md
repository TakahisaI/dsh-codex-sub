# dsh-codex-sub

`dsh-codex-sub` は、ChatGPT契約のOAuth認証を利用し、pi-aiの `openai-codex`
プロバイダーをDSHの通常LLMモデルとして登録するための新規DeepSeek Harnessプラグインです。

> 現在はMilestone 0から5（リポジトリ基盤、純粋なcore契約、credential document codec、
> package-owned file vault、pi-ai OAuth連携、DSHのネイティブLLM provider route、CLIとoffline
> diagnostics）まで実装済みです。仮のDSH profileへpacked installするrelease gateはMilestone 6で
> 実施します。

## 必須要件

1. OpenAI Platform APIキーではなく、ChatGPT/Codex OAuthを使う。
2. CodexモデルをDSHの通常モデルピッカーへ表示する。
3. Agent Loop、ツール、承認、セッション、添付、コンパクション、復旧はDSHが所有する。

このプロジェクトはCodexをサブエージェントとして呼び出すものではありません。DSHへLLM
Providerを一つ追加するだけのプラグインです。

Codexへ最初に渡す指示は [`CODEX_BOOTSTRAP_PROMPT.md`](CODEX_BOOTSTRAP_PROMPT.md)、
実装上の拘束条件は [`AGENTS.md`](AGENTS.md) にあります。

## CLI

package executableは次のcommandを提供します。

```sh
dsh-codex-sub login
dsh-codex-sub logout
dsh-codex-sub status --json
dsh-codex-sub doctor --json
dsh-codex-sub version
```

`status` と `doctor` はlocalかつofflineです。`login` は検証済みのHTTPS認証先を表示しますが、
browserを自動では開きません。secretとmanual codeの入力はterminalへechoしません。JSON commandは
version付きdocumentを一つだけ出力し、credential内容、account identifier、token timestamp、認証URL、
local pathを含めません。
