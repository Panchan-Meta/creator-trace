# ADMIN発行による本番利用開始

2026-10-03に本番migration・デプロイ完了。Worker Version ID: `0ed53243-970a-4a19-aebe-24e340aa8d08`。

本番確認：トップと更新JSはHTTP 200、配信JSと確認済みビルドが一致。未ログインの`/admin/users`と利用者管理APIは401、一般登録APIは410、無効activationは410。migration前のバックアップを取得し、既存主要12テーブルの件数が反映後も一致することを確認した。実ユーザーでの本番Passkey登録・ログインは未実施（実署名ブラウザーテストで検証済み）。

## 変更ファイル

- `migrations/0020_account_activations.sql`
- `api/src/account-activations.ts`
- `api/src/auth.ts`
- `api/src/admin.ts`
- `api/src/index.ts`
- `web/src/main.ts`
- `web/src/style.css`（ADMINナビの折り返し）
- `api/test/account-activations.spec.ts`
- `api/test/account-activation-migration.spec.ts`
- `api/test/passkey.spec.ts`
- `e2e/account-activation.spec.ts`
- `e2e/inquiries.spec.ts`（ADMINナビ期待値）
- この文書

## DBとtoken

0020は新規テーブル・インデックス・トリガーの追加のみ。既存テーブルの削除・再作成・既存行の変更はない。

`account_activations` はemail、SHA-256 token_hash、状態、期限、登録日時、利用者ID、発行ADMIN、取消ADMINを保持する。状態はPENDING / ACTIVATED / EXPIRED / REVOKED。256bitの暗号学的乱数tokenを使用し、期限は発行から7日間。PENDINGは同じ正規化メールにつき1件。取消・期限切れ後は新しいtokenで再発行できる。

token付きURLは発行成功レスポンスと画面の発行結果だけに表示する。一覧・監査にURLや平文tokenを残さない。メール送信は実装せず、運営者がコピーして手動で渡す。既存メールの利用者は新しいアカウントへ勝手に紐付けず、発行を409で拒否して既存Passkeyの利用を案内する。

`account_activation_registrations` は5分間のWebAuthnチャレンジとactivation ID、表示名、予約user ID、ブラウザーnonceのハッシュを結ぶ。ユーザーはこの段階では作成しない。nonceはHttpOnly / SameSite=StrictのCookieで保持し、HTTPS本番ではSecureを付ける。チャレンジとブラウザーcontextを照合し、登録途中の期限切れ・取消も拒否する。

Passkeyの署名・RP ID・Origin・user verificationの確認後、D1 batchでユーザー・公開鍵credential・activationのACTIVATED化・監査を確定する。DBトリガーが状態と期限を再確認し、同時登録で失敗したbatchはロールバックされる。秘密鍵は保存しない。成功後は通常のログインsession Cookieを発行する。

URLを所持した人が登録する方式で、メール本人確認は追加していない。ログイン中の別アカウントでのactivation操作は409で拒否し、ログアウトしてから開始する。指定顧客へURLを直接渡す運用とする。

期限はpreview・options・verify・ADMIN一覧表示の際に確認し、既存の毎時ジョブでもEXPIREDへ更新する。登録用一時contextは期限後に掃除する。activation履歴は削除しない。

## API

- `GET /api/admin/users`：ADMIN限定。利用者一覧とactivation履歴。token_hash・URLを返さない。
- `POST /api/admin/account-activations`：ADMIN限定。`{email}`。作成直後のみ`{id,url,expires_at}`を返す。
- `POST /api/admin/account-activations/{id}/revoke`：ADMIN限定。`{}`。PENDINGをREVOKEDにする。
- `POST /api/auth/account-activation/preview`：`{token}`。登録先と有効状態を確認する。無効・期限切れ・使用済み・取消済みは410。
- `POST /api/auth/passkey/register/options`：`{activationToken,display_name}`。既存WebAuthn登録実装を利用する。
- `POST /api/auth/passkey/register/verify`：`{response}`。HttpOnlyチャレンジ・activation Cookieからcontextを復元する。

全POSTは既存の同一Origin確認と64KBの入力制限を通る。認証APIはIP単位30回/分、その他APIは240回/分の既存レート制限を継続する。利用者管理の未ログインは401、非ADMINは403。HTMLは動的値をtextContentで表示する。既存CSPとno-referrerを継続する。

## 役割と案件

システムADMINは`site_admins`、案件Roleは`project_members`。顧客登録は`site_admins`を作成しない。OWNERでも利用者管理・問い合わせ管理は403。他社案件は既存の情報保護仕様により404となる。

利用開始時には案件を作成しない。成功画面の「Creator Traceを開く」から案件一覧へ進む。案件がない場合は「まだ案件がありません。」「最初の案件を作成」を表示する。案件作成は既存`POST /api/projects`を使用し、既存トリガーで作成者をOWNER / ACTIVEにする。参加日時は既存の`project_members.created_at`に案件作成日時を保存し、メンバーAPIでは`joined_at`として返す。

`/activate/{token}` は新しい利用者アカウントの開始専用。`/invite/{token}` は既存案件への参加専用で、MANAGER / CREATOR / REVIEWER / VIEWERを扱う。既存の招待からのPasskey登録・参加を維持し、OWNER招待や移譲は追加しない。

一般の`/signup`はログインへ転送し、`/api/auth/signup`は410のまま。公開トップからの自己登録は復活しない。既存Punka・Passkey・案件・メンバー・証跡には変更を加えない。既存`/setup`とoperator-tokenによる運営者初期設定も保持する。

## Audit Log

新しいDBトリガーでACCOUNT_ACTIVATION_CREATED / ACCOUNT_ACTIVATED / ACCOUNT_ACTIVATION_REVOKED / ACCOUNT_ACTIVATION_EXPIRED / OWNER_ASSIGNEDを`audit_events`に記録する。PROJECT_CREATEDは既存トリガーを継続する。metadataはactivation_id、user_id、project_id、actor_user_id等のみ。平文tokenを含めない。既存Passkey・ログイン監査も継続する。

## 自動テスト結果

- API：18ファイル158テスト成功。実署名によるactivation登録・通常ログイン、2ブラウザー同時登録の一回性、登録途中の期限切れ・取消、CSRF・権限注入・ブラウザーcontext・レート制限を確認。
- migration：既存ADMIN・公開鍵credential・session・案件・メンバー・Version・OTS・招待・監査等の全行が0020適用前後で一致することを確認。
- ブラウザー：利用開始、旧signup停止、既存ログイン、招待、問い合わせの11種類のテスト成功（10テストの実行と、最終変更後の利用開始2＋問い合わせ1の実行）。credentials.create / credentials.getの使い分けと、登録直後の案件なし・案件作成後のOWNER / ACTIVEを確認。
- PC 1440px・スマホ390pxの利用者管理、スマホのactivation画面で横はみ出しなし。
- 全体の型チェック・フロントエンドビルド・Worker deploy dry-run成功。

## 本番デプロイ手順

プロジェクトのルートで実行する。DBの追加migrationを先に適用してからWorkerを更新する。

```sh
npm run typecheck
npm test
npm run build
npx wrangler d1 migrations list creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc
```

今回の本番反映では未適用migrationが0020だけであることを確認し、適用した。今後実行する場合も、他の未適用migrationがないか確認する。

## 初回顧客OWNER登録・手動確認

1. Punkaの既存Passkeyでログインする。ADMINナビの「利用者管理」を開く。
2. 顧客のメールを入力し「利用開始URLを発行」を押す。URLをコピーし、説明会後に顧客へ直接渡す。更新後の一覧にはURLが残らずPENDINGと有効期限が見えることを確認する。
3. 顧客はログアウト状態のブラウザーで`/activate/{token}`を開く。登録先メールを確認し、1〜50文字の表示名を入力する。前後空白はtrimされる。
4. 「Passkeyを登録して利用開始」で端末のPasskeyを新規登録する（credentials.create）。完了画面の表示名を確認し「Creator Traceを開く」を押す。
5. 案件一覧で「まだ案件がありません。」「最初の案件を作成」が見え、登録時に案件が勝手に作成されていないことを確認する。
6. 案件を作成する。その案件のメンバーが自分のOWNER / ACTIVEとなり、制作物登録・メンバー招待等を利用できることを確認する。
7. 顧客側に「問い合わせ」「利用者管理」が表示されないことを確認する。`/admin/users`や管理APIを直接開いても403で、他社案件も閲覧できないことを確認する。
8. ログアウトし、通常の`/login`から既存Passkeyでログインする（credentials.get）。
9. 使用済みURLは410で再登録できないこと、ADMINの履歴がACTIVATEDになり利用者一覧がACTIVEとなることを確認する。
10. 別の未使用URLを発行して取り消し、古いURLが410になることを確認する。同じメールで新しいURLを発行し、古いURLが復活しないことを確認する。期限切れは「この利用開始URLは期限切れです。」となる。
11. 既存の案件招待から、新規Passkey登録・既存ユーザー参加・履歴保持が動くことを確認する。
12. PC・スマホでADMINナビ・利用者管理・顧客登録の文章が横にはみ出さないことを確認する。
