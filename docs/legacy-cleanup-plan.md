# 旧Punka Proof資産の整理計画

2026-10-01調査。今回、旧資産の削除・旧データの移行・R2削除は行わない。

| 分類 | 対象 | 方針 |
|---|---|---|
| KEEP | `api/src/auth.ts`, `domain.ts`, `store.ts`, `proof.ts` | 現行認証、共通処理、OTS解析、Bitcoin RPC検証に再利用 |
| KEEP | users, sessions, webauthn_credentials, auth_challenges, enrollment_tokens, rate_limits | 現行認証基盤。既存ユーザーとPasskeyを維持 |
| KEEP | migrations/0001〜0005 | 適用履歴と新規環境構築に必要。0004の認証トリガー置換も維持 |
| KEEP | `api/wrangler.jsonc`, `web`, 現行テスト・ローカル起動スクリプト | 現行アプリ |
| ARCHIVE | `api/src/service.ts`, `mcp.ts`, `mcp-policy.ts` | 旧証明書・Bot/MCP。index.tsから現行HTTPルートには接続しない |
| ARCHIVE | `scripts/proofs.py`, `proofs.cjs`, `ops.cjs`, `test_proofs.py`, `lint-mcp.cjs`, `requirements.txt` | 旧証明書用運用。旧内部APIは410。旧ジョブを再起動しない |
| ARCHIVE | `api/test/legacy/*`, `e2e/legacy/*`, `examples/completions.csv`, `grok-bots/*`, `docs/grok-mcp.md`, `docs/legacy/*` | 旧動作・手順の保存用 |
| ARCHIVE | certificates, timestamp_proofs, issuers, courses, issuance_batches, issuance_rows, notifications, bot_bindings, bot_reviews, workflow_runs, audit_logs | 本番D1で存在を確認済み。参照・監査・保管期間を決めるまで保持 |
| ARCHIVE | R2 `creator-trace-proofs` とPROOFS binding | 旧証跡保管用。新ProofはD1保存でR2へ書き込まない。内容・件数は今回未取得 |
| ARCHIVE | MIDO_MCP_TOKEN, MIZUKI_MCP_TOKEN, SANADA_MCP_TOKEN, SHIRAISHI_MCP_TOKEN, TACHIBANA_MCP_TOKEN | 本番secret名を確認済み。現行Workerは参照しない。撤去前に旧ジョブ利用確認が必要 |
| REMOVE候補 | 本番の用途不明なsecret、旧PUNKA_APPROVAL_TOKEN / PROOF_VERIFIER_TOKEN / Bot関連設定 | 用途不明のsecretが1件ある。値は取得していない。名前を含め秘密値として慎重に扱い、所有者確認後に計画を更新 |
| REMOVE候補 | `web/src/counter.ts`, Vite/TypeScript初期画像、空のapps/packages、Pythonキャッシュ | 未使用を確認した後にローカル整理可能。今回保持 |
| 要追加調査 | Cloudflareの他Worker、Cron、Queues、R2 object inventory、外部実行ジョブ | 設定ファイル外の全アカウント資産は未棚卸し。削除判断不可 |

本番D1は当初0003まで適用済みで、Creator Traceのprojects/assets/proofsは未作成だった。旧証明書のテーブルや認証基盤を削除せず、0004以降を追加適用する。

将来削除する場合は、参照コード・外部ジョブ・保管要件を確認し、D1/R2のバックアップ、復元確認、具体的対象を記したユーザー承認を先に取得する。DROP TABLE、大量DELETE、R2削除、Cloudflare resource削除は本作業に含まない。
