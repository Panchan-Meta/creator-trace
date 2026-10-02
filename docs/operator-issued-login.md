# 運営発行アカウントでの利用（2026-10-03）

## 変更内容

- トップページの「無料で試す」→「ログイン」。遷移先は既存の `/login`。
- `/login` の見出しは「ログイン」、説明は「説明会のあと、渡したアカウントで入ります。」。既存の「パスキーでログイン」ボタンとWebAuthn認証を使用する。
- `/signup` の一般自己登録フォームを廃止し、`location.replace('/login')` で転送する。表示名・最初の案件名・登録ボタンはない。
- `POST /api/auth/signup` はHTTP 410。環境変数 `SIGNUP_ENABLED=true` が残っていても、一般登録はできない。ユーザー・登録token・案件を作らない。
- 過去の自己登録用 `ct_enrollment` と登録途中の認証チャレンジも、options/verifyで招待登録に紐づかない場合は410にする。既存のユーザー・Passkey・登録履歴は削除しない。
- Passkey登録完了時の自己登録向け「最初の案件の自動作成」処理を除去した。ログイン済みユーザーによる通常の案件作成は維持する。
- 招待URLのpreview、招待からの表示名設定・Passkey登録・受諾、既存ユーザーの招待ログインは維持する。`SIGNUP_ENABLED` は従来の招待新規登録の可否に使用し、今回値を変更していない。
- 初期設定 `/setup`、運営向け `scripts/create-owner.cjs`、認証済みユーザーの追加Passkey登録は維持する。新しいパスワード方式・公開のアカウント発行機能は追加しない。
- 導入相談 `/business` と、無料の導入前確認・導入パック121,500円・任意保守32,000円の文言を維持する。

## 変更ファイル

実装：`web/src/main.ts`、`api/src/auth.ts`。

テスト：`api/test/passkey.spec.ts`、`api/test/operations.spec.ts`、`api/test/inquiries.spec.ts`、`e2e/signup.spec.ts`、`e2e/inquiries.spec.ts`。

資料：`docs/operator-issued-login.md`。

DB migration・既存データ削除はない。

## 検証結果

- API：全16ファイル148テスト成功。
- ブラウザー：`signup.spec.ts`、`navigation-invites.spec.ts`、`inquiries.spec.ts` の9テスト成功。
- トップのログインリンク・料金維持、旧signupの転送、一般登録APIの410、運営発行アカウントの初期設定・追加Passkey・実署名ログイン、招待からの登録と既存Passkeyログイン・参加・履歴保持、問い合わせ管理を確認。
- `npm run typecheck`、更新後のE2E型チェック、`npm run build` 成功。
- 2026-10-03に本番デプロイ完了。Version ID: `19d59e6b-f927-4c3d-9658-122f2b7dd114`。
- 本番トップ・ログイン・更新JSのHTTP 200、配信JSとビルドの一致、指定ログイン文言・料金維持を確認。一般登録APIは空のリクエストでHTTP 410と停止メッセージを確認。
- DB migration・既存データの削除や直接更新は実施していない。本番での認証付きログイン・招待参加は未実施（ローカルのブラウザーテストで検証済み）。

## 手動確認

1. トップページ下部が「ログイン」「導入について相談する」の2リンクであること。料金枠が変わっていないこと。
2. 「ログイン」を押して `/login` を開き、指定の見出しと説明、Passkeyログインボタンを確認する。表示名・最初の案件名・自己登録フォームがないこと。
3. 古い `/signup` を直接開いても `/login` へ移動すること。
4. 既存Passkeyでログインして案件一覧へ移動すること。認証設定で追加Passkeyを登録できること。
5. 有効な `/invite/{token}` から、新規利用者は表示名設定・Passkey登録後に既存案件へ参加できること。新しい案件は自動作成されないこと。
6. 既存利用者は招待URLからログインし、同じ招待へ戻って参加できること。
7. 自サイトOrigin付きの `/api/auth/signup` POSTが410になり、一般登録でユーザー・案件が増えないこと。
8. `/business` の問い合わせ送信と管理者の問い合わせ管理が引き続き動作すること。

## 本番反映

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

一般登録の停止はAPIコードで強制する。`SIGNUP_ENABLED=false` への変更だけで停止しようとすると招待からの新規Passkey登録も停止するため、今回この設定値は変更しない。
