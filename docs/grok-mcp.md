# Punka Proof / Grok Remote MCP

既存npm / TypeScript / Cloudflare Worker / D1 / Passkey / Bearer認証を再利用。
MCPは既存Worker内に追加。外部サービスへの送信・新しいOTS / Bitcoin / R2機能は追加しない。
既存証明の状態をD1から参照するだけ。

## Migration

`migrations/0003_grok_mcp.sql` は追加型。bot_bindings（5人をseed）、workflow_runs、bot_reviewsを追加。
既存audit_logsを再利用。credential_key_idはSecretの名前でありtokenではない。
Bot role照合と有効状態はアプリ層・DB triggerの両方で検査。
レビューは変更・削除不可、同一batch / Botで1件。最初の提出でworkflowを作り、5 roleの提出でCOMPLETED。
COMPLETEDはレビュー回収完了であり、証明書承認ではない。再審査workflowは未実装。

```bash
npm run migrate:local
```

本番migrationは未適用。バックアップと適用履歴を確認後、運用担当者が実行:

```bash
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
```

## Endpoint / Secret / Bot description

| URL path | internal_agent_id | role | Secret | Description |
|---|---|---|---|---|
| /mcp/tachibana | tachibana_pm | PM | MCP_TACHIBANA_TOKEN | grok-bots/tachibana.md |
| /mcp/sanada | sanada_engineering | Engineering | MCP_SANADA_TOKEN | grok-bots/sanada.md |
| /mcp/mido | mido_security | Security | MCP_MIDO_TOKEN | grok-bots/mido.md |
| /mcp/shiraishi | shiraishi_compliance | Compliance | MCP_SHIRAISHI_TOKEN | grok-bots/shiraishi.md |
| /mcp/mizuki | mizuki_customer | Customer | MCP_MIZUKI_TOKEN | grok-bots/mizuki.md |

各Grok BotのCustom MCPへ `https://YOUR_WORKER_HOST/mcp/<path>` を設定し、対応するBearer tokenだけを設定。
各mdの「Grok Bot Description」をコピー。Grokの設定UIと実アカウントの接続は未確認。
Bearer credential入力をサポートするクライアントが必要。OAuth discovery / OAuth authorization serverは未実装。

## Secret設定

5つの異なる十分長いランダムtokenを生成し、秘密管理ツールに保管。
管理者・operator・verifier tokenと使い回さない。使い回しは拒否する。
コード、Git、wrangler.jsoncのvarsにはtokenを書かない。

```bash
npx wrangler secret put MCP_TACHIBANA_TOKEN --config api/wrangler.jsonc
npx wrangler secret put MCP_SANADA_TOKEN --config api/wrangler.jsonc
npx wrangler secret put MCP_MIDO_TOKEN --config api/wrangler.jsonc
npx wrangler secret put MCP_SHIRAISHI_TOKEN --config api/wrangler.jsonc
npx wrangler secret put MCP_MIZUKI_TOKEN --config api/wrangler.jsonc
```

ローカルはGit除外済みのapi/.dev.varsへ同じ変数名で保存。実tokenは生成・保存していない。
本番は既存APP_ORIGINを実HTTPS origin、RP_IDをhostnameに設定。既存のorigin検査を維持。
有効なOriginヘッダはAPP_ORIGINのみ。サーバー間クライアントはOrigin省略可。
bot_bindings.enabled=0で無効化。Secretを交換してローテーション。

## Tools / allowed tools

全Bot共通: get_batch_summary, get_batch_status, get_validation_summary, get_certificate_status, get_proof_status。

| Bot | 追加tools |
|---|---|
| 橘 司 | get_all_reviews, get_workflow_status, submit_pm_review |
| 真田 蓮 | get_technical_summary, get_certificate_proof_status, submit_engineering_review |
| 御堂 玲 | get_security_summary, check_duplicate_summary, get_auth_security_status, submit_security_review |
| 白石 律 | get_compliance_summary, get_consent_summary, get_pii_exposure_summary, submit_compliance_review |
| 水城 澪 | get_notification_summary, get_verify_preview, submit_customer_review |

証明書系4 toolsはcertificate_id（公開UUID）、それ以外のRead toolsはbatch_id（UUID）を引数にする。
submit toolsの厳密JSON schemaはtools/listと各Bot定義に記載。agent_id / roleをクライアントが指定することは不可。
summaryとissuesは固定語彙のみ。自由記述によるPII伝播を防ぐ。
model / prompt_versionは監査用識別子（英数字等）であり、Read toolsには返さない。
通知はstatus別件数だけ。Verifyプレビューは公開ID・状態・日時・hashとproof状態だけ。講座名・発行者名も返さない。
同意は既存のPasskey登録時consent_atを集計。未登録者の同意はunknown。法律判断や同意の真正性検証ではない。
認証安全性・PII露出summaryは現在の設定方針の説明。外部侵入診断を行うものではない。

禁止tools: approve_batch, issue_certificate, revoke_certificate, delete_certificate, delete_audit_log。
全Botから不可、tools/listにも含まれない。承認・発行・失効APIはPUNKA_APPROVAL_TOKENのみ。
従来operatorで実行したissueは403になる。ops issueはPunkaのtokenを使用するよう修正。
削除APIは追加しない。証明書・監査は既存DB triggerで削除不可。
Bot credentialで既存internal APIを利用することも拒否。

## Transport / Audit

JSON応答型のstateless Streamable HTTP。initialize / notifications/initialized / ping / tools/list / tools/callを実装。
対応protocol: 2025-11-25, 2025-06-18, 2025-03-26。GETは認証後405（任意SSE streamは提供しない）。
Acceptはapplication/jsonとtext/event-streamの両方が必要。POST上限16KiB、Botごとに240 requests/分。

既存audit_logsへMCP_AUTH_SUCCEEDED / MCP_AUTH_FAILED / MCP_TOOL_CALLED / MCP_TOOL_DENIED / BOT_REVIEW_SUBMITTED。
actor_idは検証済みinternal_agent_id。不明credentialの認証失敗はNULL（自己申告IDは信用しない）。
ログにtoken・引数・PIIは保存しない。拒否toolの名前も保存しない。レビュー保存と提出監査は一括transaction。
APIアクセスログ設定等を変更せず、アプリでconsoleへのtoken / PII出力は行わない。

## 起動・検証

```bash
npm run cf-typegen --prefix api
npm run typecheck
npm run lint
npm test
npm run build
npm run migrate:local
npm run dev
```

Workerはlocalhost:8787。MCPも同じorigin。public health: GET /api/health と GET /mcp/health。
本番deployとremote migration、Grokへの外部設定変更はこの作業では実行しない。

## curl疎通

MCP_MIDO_TOKENは安全に環境変数へ読み込み、実tokenをshell履歴に書かない。

```bash
curl http://localhost:8787/mcp/health
# tokenなしは401
curl -i http://localhost:8787/mcp/mido
curl http://localhost:8787/mcp/mido \
  -H "Authorization: Bearer $MCP_MIDO_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl http://localhost:8787/mcp/mido \
  -H "Authorization: Bearer $MCP_MIDO_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl http://localhost:8787/mcp/mido \
  -H "Authorization: Bearer $MCP_MIDO_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_security_summary","arguments":{"batch_id":"TARGET_BATCH_UUID"}}}'
```

## 未実装

Grok実環境への接続、OAuth、SSEサーバー通知、再審査workflow、モデル自動実行・定期処理、Bot管理UI、実token設定、本番migration/deploy。
レビュー提出はBotクライアントが実行。5人のレビュー完了を自動承認・発行には接続しない。
