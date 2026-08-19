# dsh-codex-sub

`dsh-codex-sub` は、pi-ai の `openai-codex` プロバイダーを DeepSeek Harness（DSH）の通常のモデル経路として登録するプラグインです。
認証には OpenAI Platform API キーではなく、ChatGPT 契約の OAuth を使います。

> 現在は Milestone 0 から 6 まで実装済みで、Milestone 7のAlpha公開準備を進めています。
> リポジトリ基盤、core契約、資格情報文書、package-owned file vault、pi-ai OAuth連携、DSHのLLM provider route、CLI、offline diagnostics、packed-install release gateが含まれます。
> packageはまだ公開しておらず、公開には末尾に記載したmaintainerの判断が残っています。

## プラグインが担う範囲

このプラグインは、次の三つの要件を同時に満たします。

1. ChatGPT/Codex OAuth を使って認証する。
2. Codex モデルを DSH の通常のモデルピッカーへ表示する。
3. Agent Loop、ツール、承認、セッション、添付、コンパクション、復旧を DSH に任せる。

このプロジェクトは Codex をサブエージェントとして呼び出す bridge ではありません。
DSH へ LLM provider route を一つ追加します。

実装上の拘束条件は [`AGENTS.md`](https://github.com/TakahisaI/dsh-codex-sub/blob/main/AGENTS.md) にあります。
Codex へ最初に渡す指示は [`CODEX_BOOTSTRAP_PROMPT.md`](https://github.com/TakahisaI/dsh-codex-sub/blob/main/CODEX_BOOTSTRAP_PROMPT.md) にあります。

## 検証済みの組み合わせ

| 構成要素 | 検証済みの値 |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@earendil-works/pi-ai` | `0.82.1` |
| Node.js | `^22.19.0 || ^24.0.0 || ^26.0.0` |
| OS | LinuxとmacOS |

最初のAlphaにおけるaccount、storage、platform、productの境界は、[既知の制約](https://github.com/TakahisaI/dsh-codex-sub/blob/main/docs/known-limitations.ja.md)にまとめています。

## ローカル tarball の導入

package はまだ private です。
ローカルで生成した tarball を試す場合は、次の手順で build、pack、DSH Web profile への追加を行います。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm pack
dsh plugin --profile web add ./dsh-codex-sub-0.0.0-development.tgz \
  --save-exact \
  --allow-build=@google/genai \
  --allow-build=protobufjs
dsh plugin --profile web exec dsh-codex-sub login
dsh web
```

二つの build approval は、この package ではなく、固定した DSH Web の依存関係に必要です。
導入後、DSH のモデルピッカーには **OpenAI Codex (ChatGPT)** の配下に provider-owned catalog が表示されます。
このプラグインは profile の default model と global search route を変更しません。

サインインせずに導入状態を確認する場合は、次の command を実行します。

```sh
dsh plugin --profile web exec dsh-codex-sub status --json
dsh plugin --profile web exec dsh-codex-sub doctor --json
```

## logout と uninstall

uninstall は `$DSH_HOME/dsh-codex-sub/auth.json` を残します。
package を入れ直すと、保存済みの資格情報を再利用します。

資格情報も削除する場合は、uninstall より先に logout を実行します。

```sh
dsh plugin --profile web exec dsh-codex-sub logout
dsh plugin --profile web remove dsh-codex-sub
```

logout が削除するのは `auth.json` だけです。
package-owned directory にある別の file は削除しません。

## CLI

package executable は次の command を提供します。

```sh
dsh-codex-sub login
dsh-codex-sub logout
dsh-codex-sub status --json
dsh-codex-sub doctor --json
dsh-codex-sub version
```

`status` と `doctor` は local かつ offline です。
`login` は検証済みの HTTPS 認証先を表示しますが、browser を自動では開きません。
secret と manual code の入力は terminal へ echo しません。
JSON command は version 付き document を一つだけ出力し、credential 内容、account identifier、token timestamp、認証 URL、local path を含めません。

## upstream の制約

ChatGPT の利用資格、model availability、quota、backend behavior、OAuth behavior は upstream が管理しており、変更される可能性があります。
ChatGPT 契約の資格情報は OpenAI Platform API key ではありません。

このプロジェクトは OpenAI、ChatGPT、Codex、DeepSeek、DeepSeek Harness、earendil-works の公式プロジェクトではなく、各組織の承認を受けたものでもありません。

## supportとsecurity

installまたは動作の問題は、repositoryのIssue formから報告してください。
添付する情報は、正確なversionとsanitize済みの `doctor --json` だけです。
credential、authorization URLまたはcode、account identifier、完全なenvironment dump、local path、model conversationは投稿しないでください。

脆弱性の疑いは、[`SECURITY.md`](https://github.com/TakahisaI/dsh-codex-sub/blob/main/SECURITY.md) に記載した非公開窓口から報告してください。

## 公開前に残る判断

このprojectは [MIT License](LICENSE) で公開します。
公開前に、最初のnpm公開をどのようにbootstrapするかをmaintainerが決める必要があります。
npm package nameには独立した予約手続きがなく、最初の実releaseのpublishによって所有権が成立します。
packageが存在するまでOIDC trusted publishingを設定できないため、ADR 0011に初回だけの例外案を記録しています。
この判断と残りのrelease gateが完了するまでは `private: true` を維持します。
release workflow は無効な file として置かれており、publish step を含みません。
Alphaのdraft release notesは [`docs/releases/`](https://github.com/TakahisaI/dsh-codex-sub/tree/main/docs/releases) にあります。
実account試験では、[`docs/alpha-smoke-record.md`](https://github.com/TakahisaI/dsh-codex-sub/blob/main/docs/alpha-smoke-record.md) を使って秘密を含まないpass/failだけを記録します。
