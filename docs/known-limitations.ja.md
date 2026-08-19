# 既知の制約

## 検証済みの組み合わせ

最初の Alpha が対応するのは、次の組み合わせだけです。
新しいバージョンは、公開APIとpacked installを再検証するまで未対応です。

| 構成要素 | 検証済みの値 |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@earendil-works/pi-ai` | `0.82.1` |
| Node.js | `^22.19.0 || ^24.0.0 || ^26.0.0` |
| OS | LinuxとmacOS |

現在のvaultはWindowsでowner-only ACLを検証できないため、Windowsは未対応です。
奇数majorのNode.js、prerelease版、未検証の将来majorはcompatibility guardで拒否します。

## 認証とアカウントの利用資格

このpackageでは、ChatGPT/Codex OAuthへ個別にloginします。
Codex CLI、ChatGPT Desktop、別pluginの資格情報、OpenAI Platform API keyは読みません。

資格情報は `$DSH_HOME/dsh-codex-sub/auth.json` に平文で保存します。
対応するPOSIX環境では、directoryとfileの権限を現在のuserだけに制限します。
暗号化、administrator、同じuserで動く別process、侵害された依存package、terminal capture、memory inspectionに対する保護は提供しません。

modelが表示されても、そのaccountで利用できるとは限りません。
利用資格、model availability、quota、backend behavior、OAuth behaviorはupstreamが管理しており、このpackageとは独立して変わります。

## productの境界

Alphaには、Web account UI、複数account、usageまたはquotaの表示、search provider、image-fetching tool、Fast Mode、endpointまたはheaderの設定、MCP、Codex App Server、別のagent loopはありません。
ツール、承認、セッション、添付、compaction、永続化、復旧はDSHが所有します。

packageをuninstallしても資格情報fileは残ります。
資格情報も削除する場合は、uninstallの前に `logout` を実行します。
logoutが削除するのは `auth.json` だけで、無関係なfileは削除しません。

## supportの境界

`status` と `doctor` が示すのはlocal stateだけです。
upstream accountの有効性は検証せず、network requestも実行しません。
問い合わせには、正確なversionとsanitize済みの `doctor --json` だけを添付します。
credential、authorization data、account identifier、完全なenvironment dump、local path、model conversationは投稿しないでください。

このprojectは独立して保守されており、OpenAI、ChatGPT、Codex、DeepSeek、DeepSeek Harness、earendil-worksとの提携または承認関係はありません。
