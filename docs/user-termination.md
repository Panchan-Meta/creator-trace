# ADMINによる利用者の契約終了

契約終了はアカウント削除ではなく、利用権の停止です。2026-10-03（日本時間）に本番Migration適用・Deployを完了しました。

## 本番反映結果

- `0021_user_termination.sql`を適用し、Worker Version `6fa6b6d6-d5bb-43ec-8235-277788e5789b`をDeployしました。
- 本番URL： https://creator-trace-api.punkaproof.workers.dev
- 反映前バックアップ：`/tmp/creator-trace-before-0021-20261003.sql`（権限0600）。反映後の比較用バックアップも0600で取得しました。
- 主要17テーブルについて全既存カラムの内容と件数が反映前後で一致しました。users 10、Passkey 9、projects 7、project_members 14、asset_versions 11、proofs 11、approvals 7、deliveries 3、audit_events 168を保持しています。Bot・レビュー・メンバー／納品履歴も一致しました。
- 全10ユーザーがACTIVE、失効Passkeyは0件です。実ユーザーの契約終了は実行していません。
- トップ・ログイン画面200、新しい契約終了UIの配信、未認証の管理画面・利用者一覧API・契約終了APIが401であることを確認しました。
- 本番でADMINのPasskeyを操作した契約終了テストは実施していません。確認・失効・履歴保持の全フローは実署名Passkeyを使うローカルE2Eで確認済みです。

## 変更ファイル

- `migrations/0021_user_termination.sql`：追加カラム、状態・ADMIN保護、原子的な失効／ARCHIVE／監査トリガー。
- `api/src/user-termination.ts`：ADMIN用契約終了処理。
- `api/src/user-status.ts`：ACTIVE利用者判定。
- `api/src/account-activations.ts`：契約終了API、一覧の利用者状態・終了日時・理由。
- `api/src/auth.ts`：Session・Passkey認証と登録の利用停止判定、有効Passkeyだけの一覧／最後のPasskeyガード。
- `api/src/public-api.ts`：利用停止ユーザーのAPI Key拒否。
- `api/src/creator.ts`：運営者初期設定Session発行とAPIアクセスにも状態判定。
- `api/src/operations.ts`：ARCHIVE済み案件の受領・差戻しにも既存更新禁止チェックを適用。未ARCHIVE案件の受領権限・動作は維持。
- `web/src/main.ts`、`web/src/style.css`：ADMIN利用者一覧、確認ダイアログ、契約終了日時・理由。
- `api/test/user-termination.spec.ts`、`api/test/user-termination-migration.spec.ts`、`api/test/passkey.spec.ts`：失効、実署名認証拒否、データ保持、Migration、原子的ロールバック。
- `api/test/account-activation-migration.spec.ts`、`api/test/asset-version-migration.spec.ts`、`api/test/reviewer-migration.spec.ts`：追加カラムに対応する既存履歴保持検証。
- `e2e/user-termination.spec.ts`：ブラウザーで確認／キャンセル／終了／再ログイン拒否／ARCHIVEと証跡保持。
- この文書。

## 状態・失効方法

`users`へ`status`（ACTIVE / TERMINATED）、`terminated_at`、`terminated_by_admin_id`、`termination_reason`を追加します。既存利用者はACTIVE、終了情報はNULLです。

`webauthn_credentials`へ`revoked_at`、`revoked_by_admin_id`を追加します。既存PasskeyはNULLで有効です。契約終了では全Passkeyを論理失効し、公開鍵の行を残します。通常操作の「最後の有効Passkeyは削除できない」制約は継続します。

`POST /api/admin/users/{userId}/terminate`へ`{"reason":"契約終了"}`を送ります。理由を省略すると「契約終了」、前後空白を除いて1～1000文字です。未認証401、非ADMIN403、自己終了・全site_admins対象・既に終了済みは409です。Punkaを含むADMINは終了対象にできません。ADMIN権限をOWNERから推測しません。

APIはACTIVE利用者の状態を1回のUPDATEで変更します。そのDBトリガー内で、対象利用者のSessionだけをDELETE、Passkeyの論理失効、API Keyのrevoked_at設定、未使用enrollmentの消費、認証challengeの破棄、関連PENDING activationのREVOKED化を実行します。activationのACTIVATED履歴は変更しません。既存の関連付けに従いuser_idまたは登録メールで未使用activationを特定します。存在しないrecovery機能は追加しません。

対象がACTIVE OWNERの案件を`archived_at = COALESCE(archived_at, terminated_at)`でARCHIVEします。以前のARCHIVE日時は維持し、他案件のCREATOR等としての参加はARCHIVE対象にしません。OWNER membershipのrole/statusを変更・削除せず、OWNER / ACTIVEの記録を維持します。既存メンバーは既存権限で閲覧できますが、更新できません。

状態更新・全失効・案件ARCHIVE・監査は一つのSQLite文として原子的に確定します。途中で例外が起きれば全変更がロールバックされます。競合する二重終了は一度だけ成功します。再開機能は追加しません。

Session、Passkeyログイン、API Key認証でもusers.statusを確認します。Session削除を免れた過去Sessionや失効カラムが未設定のAPI Keyがあっても利用停止ユーザーを認証しません。登録・Session・API Key発行にはDBのACTIVEガードも適用します。Passkey秘密鍵を保存しません。

利用者名・メール・user_idは保持します。usersの物理DELETEをDBでも拒否します。projects、project_members／history、assets、asset_versions、approvals、deliveries／history、review_comments、proofs、OTS、Bitcoin情報、Bot履歴、audit_eventsを削除しません。SHA-256・Version・証跡生成仕様、一般メンバー取消、OWNER通常REMOVE禁止は維持します。

## 画面とセキュリティ

ADMINの`/admin/users`で非ADMINかつACTIVEの利用者だけに「契約を終了する」を表示します。クリック時は対象名・メール・6項目の影響・理由入力の確認ダイアログを開きます。キャンセルを初期フォーカスにし、実行中の二重送信を抑止します。終了済み利用者は「契約終了済み」と終了日時・理由を表示し、終了ボタンを表示しません。

既存Origin検査、SameSite=Strict Cookie、API rate limit、本文サイズ制限を継続します。表示名・メール・理由はtextContentで描画し、HTMLとして挿入しません。

監査は`USER_TERMINATED`、`SESSION_REVOKED`、`PASSKEY_REVOKED`、`API_KEYS_REVOKED`、新しくARCHIVEした案件ごとの`PROJECT_ARCHIVED_BY_TERMINATION`を追加します。対象ID、実行ADMIN、理由、終了日時、件数を記録します。関連activationには既存REVOKED監査も発生します。Passkey credential本体、公開鍵、Session token、activation token、API Key本体をmetadataへ保存しません。

## 検証結果

- API：20ファイル、164テスト成功。ADMIN成功、未認証401、非ADMIN403、自己／他ADMIN保護、二重終了、途中失敗の全ロールバックを確認。
- 認証：実署名Passkeyの終了後ログイン拒否、Session・API Key失効、残存Session・未失効KeyでもTERMINATEDを拒否することを確認。
- データ：OWNER / ACTIVE、Version・Proof・OTS・Bitcoin・承認・納品・レビュー・Bot・既存監査の内容一致、他利用者の認証と他案件の保持を確認。
- Migration：既存カラムの値と行数が一致し、追加カラムだけACTIVE／NULLになることを確認。
- E2E：既存の利用開始・招待・通常ログイン・公開signup停止10テストと、新規契約終了1テストが成功。PC幅1440・スマホ幅390で確認ダイアログの横はみ出しなし。
- API／Web／E2E型チェック、Web本番ビルド、Worker deploy dry-run成功。本番実ユーザー停止は実行していません。

## 本番Migration・Deploy手順

リポジトリ直下で実行します。0021は追加Migrationで既存行を終了・ARCHIVEしません。先にMigration、その後アプリをDeployします。

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e -- e2e/user-termination.spec.ts e2e/account-activation.spec.ts e2e/navigation-invites.spec.ts e2e/signup.spec.ts
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-0021.sql
chmod 600 /tmp/creator-trace-before-0021.sql
npx wrangler d1 migrations list creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc
```

バックアップには利用者・認証情報が含まれるため非公開で保管します。適用前後で既存主要テーブルの件数、既存ADMIN、既存Passkey、案件・Version・Proofが保持されていることを確認します。予期しない未適用Migrationが一覧にある場合は適用範囲を確認してください。

## 本番手動確認

1. Punkaの既存Passkeyでログインし、利用者管理を開きます。Punka／他ADMINに終了ボタンがないことを確認します。
2. 終了対象として了承されたテスト利用者を選び、対象名・メールと影響を確認します。一度キャンセルし、まだ通常利用できることを確認します。
3. 理由を入力し確認ボタンで終了します。TERMINATED、終了日時、理由、終了済み表示を確認します。
4. 対象の既存Session、既存Passkey、API Keyでアクセスできないことを確認します。対象以外のアカウントが通常利用できることも確認します。
5. 別の有効な案件メンバーで対象OWNERの案件を直接開き、ARCHIVE状態と更新拒否を確認します。OWNER / ACTIVEの履歴、過去Version・SHA-256・Proof・OTS・Bitcoin情報・承認・納品・Bot履歴を確認します。
6. 監査で実行ADMIN、理由、対象、失効件数とARCHIVE案件を確認します。平文秘密情報が含まれていないことを確認します。
7. 通常のOWNERメンバー取消と最後の有効Passkey削除が引き続き拒否されることを確認します。非ADMIN403、未認証401も確認します。

契約終了は実行後の再開UIがありません。手動確認には実在顧客を無断で停止せず、専用のテスト利用者を使います。
