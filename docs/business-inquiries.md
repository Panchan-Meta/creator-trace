# Business問い合わせ管理

管理画面: `/admin/inquiries`、詳細: `/admin/inquiries/{id}`。
ログイン中のユーザーが `site_admins` に登録されている場合だけ「問い合わせ」ナビを表示します。案件のOWNER/MANAGER権限、表示名Punka、新規登録では管理権限を取得できません。一般ユーザーの管理APIは403、未ログインは401です。管理画面URL自体もWorkerで認可し、未ログイン401・非ADMIN403・ADMIN200にします。`site_admins`の登録をシステム権限ADMINとして扱い、`/api/admin/access`は`{is_admin:true,system_role:"ADMIN"}`を返します。

API:
- `GET /api/admin/access`: 管理者判定。管理者だけ `{is_admin:true}`。
- `GET /api/admin/inquiries`: 非アーカイブ一覧。NEWを先頭、各グループ内はcreated_at DESC、同時刻はid DESC。
- `GET /api/admin/inquiries/{id}`: 非アーカイブ詳細。不存在・アーカイブは404。
- `PATCH /api/admin/inquiries/{id}/status`: `{ "status": "IN_PROGRESS" }`。NEW / IN_PROGRESS / COMPLETEDのみ許可し、他の入力キーは400。Origin検査とリクエストサイズ制限を適用。

0010マイグレーションはsite_adminsとarchived_at、一覧索引を追加します。既存の問い合わせ内容とstatusはそのまま保持。DBトリガーで受付内容・受付日時・IDの変更、物理DELETE、不正statusを禁止します。UIは未対応→対応中→完了、および未対応→完了に対応。APIは3状態間の変更を許可します。アーカイブ操作のUI/APIは今回追加していません。

## 管理者の登録

運用者が既存Punkaアカウントの内部user_idを確認して登録します。表示名だけで自動付与しません。

```bash
npm run migrate:local
node scripts/grant-site-admin.cjs --user-id=<Punkaの既存UUID>
```

本番反映時は、バックアップ後に0010を適用し、本人のuser_idを確認して権限を付与します。grantスクリプトは既存ユーザーを参照し、再実行しても重複を作りません。

```bash
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-inquiries.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
node scripts/grant-site-admin.cjs --remote --user-id=<Punkaの既存UUID>
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

バックアップには個人情報が含まれるためアクセス権を制限して保管してください。

## 手動確認

1. /businessで全項目を入力し「導入について問い合わせる」で送信。契約・料金についての説明と受付完了を確認。
2. 登録済み管理者でログイン。「問い合わせ」から一覧を開き、受付内容と未対応優先・日時降順を確認。
3. 氏名リンクから詳細を開き、全受付項目を確認。「対応を開始」→「完了にする」で表示が対応中→完了になることを確認。
4. 再読み込みして受付内容・受付日時が変わっていないことを確認。
5. 一般ユーザーで一覧・詳細へ直接移動し、権限エラーと内容非表示を確認。管理APIのGET/PATCHが403であることを確認。

自動テスト: api/test/inquiries.spec.ts、e2e/inquiries.spec.ts。E2Eの管理者権限は独立したテストDBにだけ登録します。

## ADMIN認可の修正

本番の既存アカウント `68faf0b8-06ce-4bec-8c3c-62208296ae04` は未登録のため拒否されていました。既存CLIでsite_adminsに1行追加します。users / sessions / webauthn_credentials / project_membersは変更しません。新規マイグレーションは不要です。ブラウザからADMINを付与するAPIや操作はありません。

```bash
node scripts/grant-site-admin.cjs --remote --user-id=68faf0b8-06ce-4bec-8c3c-62208296ae04
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

権限は毎回DBから照合するため、既存セッションの再発行は不要です。画面を再読み込みしてください。navは案件・制作物・問い合わせ・認証設定の順です。

本番反映記録（2026-10-01）: 上記既存IDへsite_adminsの1行を追加し、is_admin=1、既存Passkey件数1を確認。Worker version `7d361376-0d81-4d88-af24-044e56dfff5f` をデプロイ。APIテスト35件・問い合わせE2E1件・型チェック・ビルド成功。本番の管理画面一覧/詳細と管理APIは未ログイン401、新JSのSHA-256一致を確認。本人の本番Passkeyでのログイン・問い合わせステータス変更は手動確認対象です。
