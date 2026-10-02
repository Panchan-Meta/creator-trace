# Creator Trace Phase2・Phase3・運用実装報告

## 1. 現行構成

Cloudflare Workers / D1、Vite / TypeScript、SimpleWebAuthn、ブラウザWorker内SHA-256。原本は端末・外部ストレージに置く。Creator TraceにはメタデータとOTSを保存する。既存R2は旧証跡保持用。Wallet、NFT、暗号資産機能なし。

案件 → 制作物 → 版 → 提出 → 承認 → FINAL → 納品 → 受領 → 証跡 → 公開Verify。

## 2. 変更ファイル

- API: `api/src/creator.ts`, `index.ts`, `auth.ts`, `store.ts`, `proof.ts`
- 新APIモジュール: `operations.ts`, `timestamps.ts`, `public-api.ts`
- 設定: `api/wrangler.jsonc`, `api/worker-configuration.d.ts`
- 画面: `web/src/main.ts`, `hash.ts`, `hash.worker.ts`, `web/public/_headers`
- 依存: `web/package.json`, `web/package-lock.json`（@noble/hashes）
- migration: 0006〜0009
- テスト: `api/test/creator.spec.ts`, `operations.spec.ts`, `passkey.spec.ts`, `e2e/creator.spec.ts`, `signup.spec.ts`, `large-file.spec.ts`, `e2e/wrangler.jsonc`
- 文書: 本報告、`legacy-cleanup-plan.md`、README

## 3. Migration

| Migration | 内容 |
|---|---|
| 0006_workflow.sql | 現在状態・追記履歴・監査、旧版状態のバックフィル、承認履歴保護 |
| 0007_operations.sql | メンバー、招待、キー、納品、問い合わせ、原本URL、archive、Proof状態・再試行列、Passkey名 |
| 0008_registration_guards.sql | 初期登録、SHA単位lease、Proof監査・Confirmed保護、納品の履歴・監査トリガー |
| 0009_invitation_atomic.sql | 招待消費とメンバー追加・監査の原子的実行 |

既存asset_versionsの変更・削除禁止トリガーはそのまま。DROP TABLEはない。旧DB/R2データの削除なし。本番未適用の0004・0005も前提として適用が必要。

## 4. 追加テーブル

asset_version_states、asset_version_state_history、audit_events、project_members、project_invites、api_keys、version_sources、deliveries、delivery_history、business_inquiries、signup_enrollments、timestamp_leases。

## 5. 追加API

| Method | Path | 内容 |
|---|---|---|
| POST | /api/asset-versions/{id}/submit, approve, reject, finalize | 状態遷移。reasonを受け付ける |
| GET | /api/asset-versions/{id}/history | 状態履歴・承認履歴 |
| GET / POST | /api/asset-versions/{id}/deliveries | 納品一覧・FINAL版納品 |
| POST | /api/deliveries/{id}/receive, reject | 指定受領者による一度だけの受領・差戻し |
| POST | /api/proofs/{id}/retry | 明示的OTS作成・更新。Confirmedは再処理しない |
| GET | /api/proofs/{id}/ots | 案件メンバー向け.ots download |
| GET | /api/projects/{id}/members, audit | メンバー一覧・最近100監査イベント |
| POST | /api/projects/{id}/invites | email（連絡先）、role指定。招待URLを一度返す |
| POST | /api/project-invites/accept | token + ログイン + Passkey必須 |
| POST | /api/projects/{id}/edit, archive | name/client_name/description編集・archive |
| POST | /api/assets/{id}/archive | 制作物archive |
| GET / POST | /api/api-keys | キー一覧・作成 |
| POST | /api/api-keys/{id}/revoke | キー失効 |
| GET | /api/v1/projects, /projects/{id}, /assets/{id}, /assets/{id}/versions, /proofs/{id}, /verify/{id} | Bearerキー + scope + メンバー権限 |
| POST | /api/auth/signup | 表示名・初期案件名。初期登録Cookieを発行 |
| POST | /api/auth/passkeys/{credentialId}/remove | 自分のcredentialのみ削除。最後の1件禁止 |
| POST | /api/business/inquiries | 問い合わせ受付、D1保存 |

既存 /api/projects、/api/assets、/api/assets/{id}/versionsに?page=1&limit=50&q=...を追加。limitは最大100。案件詳細内の制作物一覧もページング。既存一覧レスポンス配列は維持。qは案件名・クライアント名、またはファイル名・制作者名・hashを検索。

## 6. 画面

/signup、/invite/{token}、/settings/api-keys、/businessを追加。既存案件・制作物・版・Proof・Verify・セキュリティ画面に操作を接続。権限をUIとAPIで確認。案件監査ログ、状態履歴、原本URL、納品受領、Passkey名・削除、検索・前後ページを追加。

## 7. OpenTimestamps

既存parseReceiptを拡張しpending calendar位置を抽出。SHA-256にランダム16byte nonceをappendしSHA-256したcommitmentだけを公式calendarへ送る。ファイル・個人情報は送らない。detached .otsを作成し、既存解析器で対象hash・構造を確認してからD1のots_proofへbase64保存する。download時はbinaryに戻す。

状態: PENDING → STAMPED → WAITING_BITCOIN → CONFIRMED。保存前失敗はFAILED、保存済みの更新・検証失敗はWAITING_BITCOINを維持してエラーを記録する。created_atは登録日時、timestamp_created_atはcalendar作成成功日時、bitcoin_confirmed_atはRPC検証成功日時。blockの採掘時刻とは異なる。

Proof単位とSHA-256単位のDB leaseで重複処理を防止する。既存同hashのOTSを再利用し、保存済みOTSは再stampせずupgradeする。再試行は最短60秒、retry_countとlast_retry_at、最終エラーを記録。Cronは毎時17分、1時間以上未処理の最大3件。FAILEDの自動再試行は10回まで、保存済み確認待ちは継続する。ネットワークtimeoutと応答サイズ制限あり。

## 8. Bitcoin確認

既存verifyBitcoinを再利用。信頼するBITCOIN_RPC_URLでgenesisがmainnetであること、getblockhash/getblockheaderで高さ・merkle root一致・6 confirmations以上を確認する。設定がないとConfirmedにしない。秘密値・RPC例外はレスポンスやログへ出さない。

## 9. 承認

DRAFT → SUBMITTED → APPROVED → FINAL、またはSUBMITTED → REJECTED。REJECTEDの修正は新しい版で登録する。asset_versions.statusは登録時スナップショットであり、現在状態はasset_version_states.status。現行APIは現在状態を返す。競合時は比較更新で409。履歴・承認・監査はトリガーで同じDBトランザクションに追記する。FINALからの状態変更や版hash・ファイル情報の変更は禁止。

## 10. 権限

| Role | 権限 |
|---|---|
| OWNER | 全操作 |
| MANAGER | 案件編集・招待・登録・提出・FINAL・納品 |
| CREATOR | 自分の制作物登録・追加版・提出、案件閲覧 |
| REVIEWER | 閲覧・承認・差戻し |
| VIEWER | 閲覧、本人が受領者の場合のみ受領操作 |

全APIで案件所属を検証する。APIキーは発行ユーザーの現在の案件所属を引き継ぐ。archive済み案件の新規操作は禁止。招待はランダムtokenのhashだけ保存し、7日有効・一度消費。emailは連絡先として保持し、現時点では招待URLの所持とPasskey認証で参加する（メール所有の検証・自動送信は未実装）。リンクは指定相手へ安全に共有する。

## 11. Passkey復旧

複数端末のPasskey登録を第一の復旧方式とする。名前を付けて追加・削除でき、DBトリガーで最後のPasskey削除を防止する。認証はRP ID/origin/challenge/userVerificationを検証し、challengeを一度だけ消費する。authenticatorAttachmentは固定しない。スマホQR経由を含む実端末テストは別途必要。秘密鍵は保持しない。全credential喪失後の復旧やrecovery codeは未実装。

初回登録は短命のHttpOnly enrollment Cookie → 実Passkey検証成功 → 初期案件と通常session発行。IPごと登録5回/時、auth30回/分、metadata body64KB、same-origin POST。SIGNUP_ENABLED=falseで登録を停止できる。

## 12. 大容量hash

保守されている@noble/hashesのincremental SHA-256を使用。Web Worker内でBlob.sliceを4 MiBずつ読み込み、updateする。ファイル全体をRAMへ載せず、UIへ進捗率を送る。1GB以上を扱える構造。従来の256 MiB制限を削除。ファイル本体はネットワークへ送らない。照合も同じ実装を利用する。

## 13. Audit

audit_eventsはproject_id・actor_user_id・event_type・target・metadata_json・created_atを保持し、UPDATE/DELETEをDBで禁止。案件作成・編集・archive、版作成・状態遷移、Proof作成、OTS作成・Bitcoin確認、招待・参加、納品・受領・差戻し、APIキー作成・失効、Passkey追加・削除を記録。旧audit_logsも保持し認証イベントに再利用する。

## 14. APIキー

ct_ + 高エントロピーtoken。SHA-256 hashのみDB保存。key_id・name・JSON scopes・user/project境界・作成/利用/失効日時。生キーは作成レスポンスだけ。projects:read/assets:read/proofs:read/verify:readを提供し、キーごと60回/分。書き込み公開API/assets:writeは未提供。

## 15. テスト

API・DBテスト: Phase1回帰、全5role、別案件、正規/不正状態遷移、承認/監査改変禁止、受領権限・再操作、招待正常/期限/使用済み/不正、キー正常/scope/失効/不正、OTS成功/失敗/retry/pending/download/mainnet RPC確認、Confirmed再処理禁止、Passkey実署名登録/認証/複数credential/削除/challenge再利用拒否を検証。

ブラウザ: 実ファイル初版・修正版・匿名Verify照合、初回登録・追加Passkey・ログアウト/再ログイン。最終実行結果とデプロイ情報は下記「実行記録」を参照。

## 16. 本番コマンド

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-phase2.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc
# 自分で管理するBitcoin mainnet RPCを安全に設定（値は対話入力）
npx wrangler secret put BITCOIN_RPC_URL --config api/wrangler.jsonc
```

バックアップSQLには個人情報・session等が含まれるため共有・コミットしない。DBを旧schemaへ戻す破壊的rollbackは行わず、Workerを戻す場合も追加テーブルを維持する。

## 17. Punka本番手動テスト

1. /signupからPasskey登録。「ボカロ新曲制作」を作成。
2. /settings/securityで別端末Passkeyを追加。Windows・iPhone・AndroidのQR登録/ログインも確認。
3. lyrics.txt / song.wav / master.wav / illustration.png / music_video.mp4の実ファイルをブラウザで選択。進捗を確認し、原本のHTTPS URLを記録する。1GB以上のMVも試す。
4. 制作者・レビュアー・発注者VIEWERを招待。各本人がPasskey登録して招待リンクを消費する。
5. DRAFT提出 → REVIEWER承認 → OWNER/MANAGER FINAL。差戻し時は新しい版を登録。
6. FINALでOTS処理開始。Proof詳細で登録日時・Timestamp作成日時を区別し.otsをdownload。既存OpenTimestampsクライアントで検証する。
7. 受領者メンバーIDを指定して納品。指定受領者で受領し、再受領が失敗することを確認。
8. RPC設定後、CronまたはretryでBitcoin確認。6確認以上でConfirmed/UTC時刻を確認。
9. ログアウトまたは別ブラウザでVerify。原本URL・個人情報が表示されず、同じファイルは一致・別ファイルは不一致。
10. APIキーを作り公開APIの読み取り・scope不足・失効後の拒否を確認。最後のPasskey削除失敗とauditを確認。
11. /businessの問い合わせを確認。初期運用では担当者がD1 business_inquiriesを確認し、相談・契約・請求を個別に進める。

実ファイルは今回提供されていないため、Punka本人の正式データや架空hashの本番登録は行っていない。is_demoはprojects/assetsに確保済み。ローカルテストデータを本番へimportしない。

## 18. 旧資産

[整理計画](legacy-cleanup-plan.md)にKEEP/ARCHIVE/REMOVE候補を記載。今回削除なし。

## 19. 未実装項目

メール所有の確認と招待自動送信、問い合わせメール通知/担当者用Inbox UI、recovery code、全Passkey喪失後の復旧、APIによる制作物書き込み、決済、メンバーrole変更・失効UI、全Cloudflareアカウント資産の棚卸し。

## 20. 残課題

Bitcoin RPCの運用設定、Punkaの実ファイル・実端末での手動検証、1GB以上の実ファイルの端末別性能計測、迷惑登録が増えた場合のTurnstile導入、問い合わせ対応担当と個人情報保持期間の決定。招待リンクを持つ人が参加する設計なのでメールアドレスとの厳密な紐付けが必要ならメール検証を追加する。

## 実行記録

- 2026-10-01: 型チェック成功。API・DBテスト23件成功。OTSの実pending URI、分岐merge、Bitcoin確認、同hash再利用を含む。
- ブラウザE2E3件成功。Phase1の登録・版・匿名Verify、実署名の初回登録・追加Passkey・ログイン、1,073,741,825 byteの実ファイル照合を確認。大容量テストは最終約19.8秒、UIタイマーが処理中も進むことを確認した。端末一般の性能保証ではない。
- Web build / Worker dry-run build成功。
- 本番D1バックアップ: `/tmp/creator-trace-before-phase2-20261001.sql`、権限600。メモリ内SQLiteへの復元、0004〜0009適用、integrity_check / foreign_key_check成功。旧主要テーブル件数が変わらないことを確認。
- 本番migration 0004〜0009適用成功。未適用migrationなし。旧資産削除なし。Punkaの正式ファイル・架空hashの本番登録なし。
- 毎時17分のCron登録済み。Bitcoin RPCは未設定なので、実mainnetのConfirmed到達確認は未実施。
- 本番URL: https://creator-trace-api.punkaproof.workers.dev 。最終version: `a8278c1e-8fed-41da-b9ad-7dd242813f4c`。
- 本番HTTP確認: health/session/signup/business/securityは200、未認証projects/v1 APIは401、不明Proofは404、旧証明書APIは410。APIと静的ページのCSP・nosniffを確認。CloudflareがPython標準User-Agentを拒否したため、通常ブラウザUser-Agentで検証した。

技術参照: [D1 batchのトランザクション](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[静的アセットヘッダー](https://developers.cloudflare.com/workers/static-assets/headers/)、[noble-hashes incremental API](https://github.com/paulmillr/noble-hashes)、[OpenTimestamps calendar実装](https://github.com/opentimestamps/python-opentimestamps/blob/master/opentimestamps/calendar.py)。
