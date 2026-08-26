# dsh-codex-sub

`dsh-codex-sub` は、pi-ai の `openai-codex` プロバイダーを DeepSeek Harness（DSH）の通常のモデル経路として登録するプラグインです。
認証には OpenAI Platform API キーではなく、ChatGPT 契約の OAuth を使います。

> このworktreeには、未公開の `0.1.0-alpha.2` release candidateがあります。まだpublishまたはstageしておらず、公開サポートとして検証済みとは扱いません。
> 最後に公開した `0.1.0-alpha.1` の記録は履歴として保持し、このcandidateではDSHの互換性を `0.1.1-rc.1`、pi-aiを `0.82.1` に固定しています。

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
| DeepSeek Harness | `0.1.1-rc.1`（未公開candidate） |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@earendil-works/pi-ai` | `0.82.1` |
| Node.js | `^22.19.0 || ^24.0.0 || ^26.0.0` |
| OS | LinuxとmacOS |

最初のAlphaにおけるaccount、storage、platform、productの境界は、[既知の制約](https://github.com/TakahisaI/dsh-codex-sub/blob/main/docs/known-limitations.ja.md)にまとめています。

## 公開済みAlphaの導入

npmで公開済みのAlphaをDSH Web profileへ追加します。未公開candidateは導入手順や公開サポートの対象ではありません。

```sh
dsh plugin --profile web add dsh-codex-sub@alpha \
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
`login` は検証済みの HTTPS 認証先を表示し、Enter の明示確認後に OS の default browser を開きます。
browser 起動は macOS では絶対パス `/usr/bin/open`、Linux では `/usr/bin/xdg-open` だけを使い、
shell interpolation は行いません。Linux に渡す環境は固定の `/usr/bin:/bin` と検証済みの local
desktop/session 値だけで、ambient な browser、loader、shell startup、Node injection の値は継承しません。
起動できない場合、検証済みの local GUI route がない場合、または失敗した場合は、安全な案内を表示して URL の手動入力へ戻ります。
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

## releaseの安全性

このprojectは [MIT License](https://github.com/TakahisaI/dsh-codex-sub/blob/main/LICENSE) で公開しています。
最初のnpm公開だけはADR 0011に記録した対話bootstrapを使いました。
以後のreleaseでは、このrepositoryの `release.yml` だけに限定したstage-onlyのnpm Trusted Publisherを使います。
GitHub ActionsはLinux/macOSの全matrixを通過した一つのartifactをstageできますが、直接publishはできません。
従来型のpublishing tokenは禁止済みで、maintainerが内容を確認して2FAで承認するまで公開されません。
Alphaのrelease recordは [`docs/releases/`](https://github.com/TakahisaI/dsh-codex-sub/tree/main/docs/releases) にあります。
実account試験では、[`docs/alpha-smoke-record.md`](https://github.com/TakahisaI/dsh-codex-sub/blob/main/docs/alpha-smoke-record.md) を使って秘密を含まないpass/failだけを記録します。
release runは直列化し、進行中のcandidateをcancelしません。
prerelease中は、明示的な `alpha` tagだけを承認済みの最新Alphaへ進め、npm bootstrapで作られた `latest` tagは `0.1.0-alpha.0` に残します。
そのため、導入手順では常に `@alpha` を指定します。
