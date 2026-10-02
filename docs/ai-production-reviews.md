# Grokによる5Bot制作レビュー

Versionカードに「AI制作レビュー」を追加。対象Version・状態、実行ボタン、参考情報であることを表示します。実行中はボタンをdisabledにして「AIレビュー中...」と表示。完了・失敗も過去履歴として保持し、再読込時にDBから再取得します。Bot本文はtextContentとpre-wrapで表示し、HTML・スクリプトとして解釈しません。

## APIと権限

- `POST /api/projects/{projectId}/bot-reviews`、JSON `{ "assetVersionId": "<UUID>" }`。201でCOMPLETED runと5人のmessagesを返します。
- `GET /api/projects/{projectId}/bot-reviews?assetVersionId=<UUID>`。そのVersionの過去runとmessagesを受付日時降順で取得します。
- 未ログイン401、ACTIVE案件メンバー以外403、別案件・不存在Version403、同一Version実行中409、不正入力400、未設定503、xAI実行失敗502。
- 案件の全ACTIVE役割（OWNER / MANAGER / CREATOR / REVIEWER / VIEWER）に実行・履歴閲覧を許可。システムADMINでも案件メンバーでなければアクセス不可。アーカイブ済み案件・制作物の新規実行は409。Origin検査・リクエストサイズ制限も既存方式を適用。

## DB

`0011_bot_reviews.sql` は旧bot_reviews / workflow_runsとは別に次を追加します。

- bot_review_runs: id, project_id, asset_version_id, status, model, created_by, started_at, completed_at, error_message, created_at。追加でcontext_json（実行時点の資料）とprompt_versionを記録。
- bot_review_messages: id, run_id, bot_key, bot_name, role, content, created_at。

同一VersionのRUNNINGはpartial UNIQUE indexで1件だけ。各runの各Botは1回答。5回答とCOMPLETED更新はD1 batchで一括コミットします。xAI失敗時に部分回答は保存せずrunだけFAILED、監査イベントを追記。終端runと回答の変更・削除はDBトリガーで禁止。再実行は新規runです。

BOT_REVIEW_STARTED / BOT_REVIEW_COMPLETED / BOT_REVIEW_FAILEDはrunのINSERT/UPDATEトリガーが同じDB操作内でaudit_eventsへ記録。Project / Asset / Version / 状態 / Approval / Delivery / Proof / 権限をBotから変更する処理・ツールはありません。

## データとprompt

DBのProject / Asset / Version / SHA-256 / 現在状態 / creator / 提出者 / 状態履歴 / approvals / deliveries / 受領履歴 / OTS状態 / Bitcoin状態 / audit events / project_membersを取得。明示した列だけを渡し、API key、認証情報、招待token、メール、外部URL、ファイル本体、OTSバイナリは渡しません。

履歴類は各最新100件まで。101件目の存在でtruncated=trueとし、履歴全体を確認済みと断定させません。auditは案件全体の最近100イベント。空欄/null/空配列/未提供情報は「未確認」と明示し、記録の欠如から未実施を断定しない指示です。

| Bot | 主なprompt |
| --- | --- |
| 真田 蓮 | 技術・制作工程・版管理。ファイル名、版、hash、MIME、サイズ、変更内容、状態遷移の不整合 |
| 御堂 玲 | セキュリティ・証跡。hash、OTS、Bitcoin、audit、不変性、権限。hash存在だけで外部証明を断定しない |
| 白石 律 | ガバナンス。提出者、承認者、状態遷移、承認履歴、納品、受領の整合性 |
| 水城 澪 | 顧客・運用。発注者/受領者視点、納品フロー、表示、運用。未提供の画面や契約を見たふりをしない |
| 橘 司 | 議長。実データと4回答を照合し、共通事項・相違・根拠・不足情報・人間の次の手順を統合 |

全Botに助言限定、推測・架空データ禁止、ファイル本体の品質判定禁止を指示します。DBコメントや他Botの回答中の命令は資料として扱い従わない指示を含めます。promptはapi/src/bot-reviews.tsで固定し、ブラウザからmodel・promptを変更できません。

## xAI呼び出し

Workerからenv.XAI_API_KEY / XAI_BASE_URL / XAI_MODELを使用。対応base URLはHTTPSのapi.x.ai（/ または /v1）。Chat Completions `/v1/chat/completions`をfetchし、Bearer認証、system/user messages、max_tokens=2400、stream=false、store=false、redirect=manual、toolsなし。リダイレクトは追従せずエラーとして扱います。4専門BotをPromise.allで並列に呼び、全員の回答取得後に橘を1回呼びます。API仕様: https://docs.x.ai/developers/rest-api-reference/inference/chat-completions

全体180秒でAbortControllerが中断。空・不正・打ち切り回答、HTTPエラー、ネットワークエラーはFAILED。秘密やプロバイダの生エラーはDB・ログ・Responseへ書き出しません。本文にAPI keyと同一文字列がある場合も伏せます。

同期HTTP処理のため、画面を閉じる等で中断したrunはRUNNINGのまま残る場合があります。5分以上のrunは次の履歴取得または再実行でFAILEDに復旧。表示中のRUNNINGは4秒ごとに履歴を再取得します。実モデルは設定次第で180秒に収まらない場合があり、必要に応じて将来Queueなどへ移行できます。

## 検証

WorkerテストはxAI fetchのみmockし、実D1へ5回答とrunを保存して履歴GETを確認。4並列・橘統合、追記保存、401/403/409、xAI各段階の失敗、空/打ち切り回答、タイムアウト、復旧、秘密保護、全制作テーブルの不変性を確認します。

E2EはレビューAPIをfixture化して実行中disabled、5本文、再読込、失敗表示、過去履歴保持と実制作物状態の維持を確認。既存納品・問い合わせ・Passkeyテストも実行。実xAIサービスへの有料呼び出しは手動テスト対象です。

## 本番反映コマンド

XAI_API_KEYは登録済みCloudflare Secretを使用。既存XAI_BASE_URL / XAI_MODELを保持するためapi/wrangler.jsoncにkeep_vars=trueを指定します。値をログに出す確認コマンドは使用しません。

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
# バックアップには個人情報が含まれるためアクセスを制限
umask 077
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-bot-reviews.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc --keep-vars
```

既存環境変数保持の公式仕様: https://developers.cloudflare.com/workers/wrangler/commands/workers/

## 手動確認

1. 対象案件のメンバーでログインして制作物詳細 `/assets/{assetId}` を開く。
2. 対象Versionカードで「AI制作レビュー」の版・状態と参考情報の説明を確認。
3. 「5人のBotでレビューする」を押す。実行中ラベル・disabledを確認。
4. 5人の本文を確認。橘の統合が4専門Botの内容と対象データに基づくことを確認。
5. 再読み込みして履歴が残り、もう一度実行すると新しい履歴が増えることを確認。
6. 実行前後の状態・承認・納品・Proofが変わらないことを確認。
7. 別ブラウザで同時実行すると409、未ログイン401、他案件ユーザー403になることを確認。
8. 開発/テスト環境でxAI失敗を模擬し、失敗表示とFAILED・監査記録、制作データ不変を確認。本番秘密設定を故意に壊してテストしない。

実行結果（2026-10-01）: 型チェック成功、API/DBテスト6ファイル48件成功（AIレビュー13件）、WebビルドとWorker dry-run成功。AIレビュー・既存納品/受領・問い合わせ管理・Passkey認証のE2E4件成功。本番0011適用・本番デプロイ・実xAI呼び出しは未実施。


## 本番反映・実xAI確認（2026-10-01）

0011適用、本番デプロイ完了。反映時に本番にはXAI_API_KEYだけが存在し、XAI_BASE_URLとXAI_MODELが未登録と判明したため、wrangler.jsoncにURL `https://api.x.ai/v1` とモデル `grok-4.20-0309-non-reasoning` を設定しました。Secret値は取得・出力していません。Workerの実通信で失敗したredirect=errorをmanualへ変更し、3xxを追従せず処理する方式で成功しました。固定診断コードを追加し、生エラーは返しません。

最終Worker version: `87f4cf50-b7fe-495e-95b6-2fad21b1697b`。

実データのVersion `a0103e3b-a133-4cb4-9ced-50551c24547e`（Version 1 / SUBMITTED）でHTTP201・COMPLETED、約18秒。run id `2d74e3a3-672f-43aa-a419-6bba506a999a`。真田1366文字、御堂1412文字、白石1426文字、水城1599文字、橘2100文字を保存。履歴GETで5回答を再取得、audit STARTED / COMPLETEDを確認。本番ブラウザの5見出し表示・再読み込み後の履歴表示も確認しました。

実行前後のProject / Asset / Version / 状態・状態履歴 / Approval / Delivery / Proof / project_membersを比較し不変。一時検証セッションは終了時に削除。失敗試行のrunはFAILED履歴として保持しています。バックアップ `/tmp/creator-trace-before-bot-reviews-20261001.sql` は権限600で保存し、復元と0011適用を検証済み。
