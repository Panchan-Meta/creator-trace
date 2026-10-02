# ナビゲーションと案件メンバー招待

## 画面

Proof `/proof/{proofId}` のasset_id / asset_version_id / version / project_idから明示的な戻りURLを生成します。`← Version N に戻る`は `/assets/{assetId}/versions/{versionId}` へ戻ります。ブラウザ履歴や一覧ページの表示位置に依存しません。

単独Version詳細にファイル情報・既存操作・AIレビュー・証跡リンクを表示。制作物の各カードにも「Version詳細」を追加。案件詳細・制作物詳細・単独Version詳細・証跡詳細で共通パンくずを利用し、Proofは「案件 ＞ 制作物 ＞ Version N ＞ 証跡詳細」。匿名 `/verify/{proofId}` は案件や内部Version情報を表示しません。

案件メンバーを表で表示（表示名、Role、状態、参加日時）。表示名がない場合は受諾済み招待のメールを利用し、それもなければ表示名未設定とします。案件メンバーにはACTIVEの参加済みユーザーだけを表示し、OWNER/MANAGERにはPENDINGを別の「招待中」セクションに表示して、招待履歴に全状態と作成日時・期限を表示します。

招待ボタンは「メンバーを招待する」。送信中は「招待作成中...」にしてdisabledと再送防止ガードを適用します。201のid・urlだけでも「招待を作成しました」と招待URLを表示し、フォームをクリアして一覧を更新します。コピーは「招待URLをコピー」、成功時は「コピーしました」を表示。Roleの初期値CREATOR、候補MANAGER / CREATOR / REVIEWER / VIEWER。既存の案件作成者OWNERは招待で追加できません。

## API

- `GET /api/assets/{assetId}/versions/{versionId}`: 単独Version。所属案件の認可を行い、制作物とVersionの組み合わせも検証。
- `GET /api/projects/{projectId}/members`: 既存APIにjoined_at（案件参加日時）を追加。
- `POST /api/projects/{projectId}/invites`: `{email,role}`。201でid、email、role、PENDING、created_at、expires_atとurlを返す。URLを取得できるのは作成時だけ。
- `GET /api/projects/{projectId}/invites`: 管理者用履歴。token / token_hash / urlを返さない。
- `POST /api/projects/{projectId}/invites/{inviteId}/revoke`: 未使用・有効な招待を取消しREVOKEDと監査記録を保存。
- `POST /api/project-invites/preview`: `{token}`。ログイン前からtokenで案件名・招待先・Role・状態・作成日時・期限を確認。
- `POST /api/project-invites/accept`: `{token}`。Passkey登録済みユーザーを追加し、`{project_id,status:'ACCEPTED'}`を返す。

招待作成・一覧・取消はOWNER/MANAGERだけ。CREATOR / REVIEWER / VIEWERはAPIでも403。招待tokenによる案件名・招待先・Roleのプレビューはログイン前も可能。参加確定は本人の認証が必要で未ログイン401。期限切れは参加410、取消・使用済みは参加400、既存ACTIVEメンバーは409。既存メンバーの権限を招待で上書きしません。アーカイブ案件への参加・新規招待は拒否し、管理者は招待履歴の閲覧を継続できます。

## 招待の安全性とメール

メール自動送信機能はありません。作成後、管理者がreadonlyの「招待URL」欄と「招待URLをコピー」ボタンから取得して共有します。コピー不可の環境ではURLを選択し手動コピーできます。URLはその画面でのみ保持し、再読み込み後に一覧へ復元しません。招待作成者のURLはlocalStorage/sessionStorageへ保存しません。招待先は招待専用登録URLとログインURLのroute stateで復帰先を維持し、localStorage/sessionStorageには依存しません。

招待tokenはcrypto.getRandomValuesによる32bytes（256bits）、有効期限7日、DBへSHA-256 hashのみ保存。リンクを持つログイン済みユーザーが利用する方式を維持し、招待メールの所有確認・メール配送は行いません。Passkeyでの本人確認とメール所有確認は別概念です。

フロー: 招待URL → 案件名・Role・招待先確認 → 招待専用Passkey登録またはログイン → 招待内容確認 → 「案件へ参加する」 → メンバー追加と招待消費を原子的に確定 → 案件名・Role・「案件への参加が完了しました」と「案件を開く」を表示 → 対象案件。

## migration

`0012_invite_lifecycle.sql`: project_invites.revoked_at追加、既存invite_joinトリガーを更新。consumed_atからACCEPTED、revoked_atからREVOKED、期限からEXPIRED、それ以外PENDINGを導出します。既存ユーザー・招待・メンバー・Passkeyは削除しません。消費時のDBトリガーでメンバー追加と監査記録を確定し、再消費・取消後の消費・期限切れ・既存ACTIVEメンバー追加を拒否。REVOKEDの旧メンバーは新しい招待で復帰できます。

## 手動テスト

1. ログインしてProofを直接開き、戻りリンクとパンくずを確認。「← Version N に戻る」で対象Versionへ戻り、案件・制作物にも移動。
2. OWNER/MANAGERの案件詳細で招待メール・Roleを入力し「メンバーを招待する」。招待先、Role、PENDING、日時とURLを確認してコピー。
3. ページ再読み込み後、招待中の表示が残り、秘密URLが表示されないことを確認。
4. 別ブラウザで招待URLを開きPasskey登録またはログイン。案件・招待先・Roleを確認して参加。
5. 管理者画面でメンバーの表示名・Role・参加日時と招待ACCEPTEDを確認。再利用は参加できないことを確認。
6. CREATOR/REVIEWER/VIEWERで招待UI非表示と招待API403を確認。
7. 管理者で別の招待を取り消し、REVOKED表示と参加不可を確認。テスト環境では期限を過去にしてEXPIREDも確認。

本番反映時はバックアップ後に未適用の0012・0013を適用してビルド・Workerデプロイします。この実装作業では本番変更を行っていません。

## 招待結果UIの追加修正

`0013_invite_feedback.sql`を追加。expired_atによる監査済み管理とINVITE_EXPIREDのDBトリガー、projectとメール（大文字小文字・前後空白を正規化）が一致する有効PENDING招待を拒否するINSERTトリガー・検索indexを追加します。既存招待の削除はしません。期限切れ・取消・受諾後の再招待は可能です。同時POSTにもDB制約を適用し409を返します。

期限切れは既存の毎時cron、および招待一覧・作成・プレビュー・受諾処理で確定し、INVITE_EXPIREDを1回だけ記録します。MEMBER_INVITED、MEMBER_JOINED、INVITE_REVOKEDも引き続き記録し、監査にtokenは保存しません。

案件詳細に「招待中」の表（email、Role、PENDING日本語表示、created_at）と全状態の招待履歴を表示。REVOKEDは「無効」と表記します。400・403・409・410・500は招待フォーム内で具体的な日本語エラーを表示します。

追加手動確認:
- 作成中にボタンがdisabledで「招待作成中...」になり、二重クリックで招待が増えない。
- 201のレスポンスにid/urlのみでも成功メッセージ・招待ID・コピー可能URLを表示する。
- 同じメール（大文字小文字を変更しても）のPENDING招待作成で409と重複メッセージ。既存URLは一覧に復元しない。
- 招待先ブラウザではログイン前に案件・Role・招待先を確認できる。参加後は対象案件で完了メッセージを確認する。
- 期限切れの受諾APIは410。一覧を繰り返し表示してもINVITE_EXPIREDの監査が増殖しない。

検証結果: 型チェック、Webビルド・Worker dry-run、APIテスト60件、招待UIブラウザテスト6件が通過。実xAI呼び出し・本番変更はこの作業に含めません。

## 招待専用オンボーディング

原因: 招待の「Passkey登録」が通常の/signupへリンクし、通常登録APIとsignup_enrollmentsを使っていたため、Passkey検証成功時に最初の案件を新規作成していました。

変更:
- `/invite/{token}/signup`は案件名・招待先・Roleと表示名だけを表示。「無料で試す」「最初の案件名」は表示しません。ボタンは「Passkeyを登録して案件へ参加する」。
- `POST /api/auth/invite-signup`は`{name,token}`のみ受け付け、招待を検証してユーザーと登録トークンを作成します。project_nameや任意roleは指定できません。
- `0014_invite_enrollments.sql`で登録token hashとinvite_idを関連付けます。既存のct_enrollment Cookie（HttpOnly、SameSite=Strict、本番Secure、有効10分）・auth_challengesがPasskey登録をユーザーへ結び付けます。招待専用登録はsignup_enrollmentsへ登録せず、Projectを作成しません。
- 招待tokenは専用登録URL・`/login?invite={token}`のroute stateで保持し、リロード後も招待内容を再取得。認証後は元の`/invite/{token}`へ戻ります。localStorage/sessionStorageには依存しません。
- Passkey登録だけでは招待をACCEPTEDへ変更しません。認証後の明示的な参加操作で既存accept APIとDBトリガーによりメンバー追加・招待消費・MEMBER_JOINEDを原子的に確定します。project_members.created_atをjoined_atとして既存APIが返します。
- acceptレスポンスにproject_name/roleを追加。完了画面の「案件を開く」から対象案件へ移動します。
- 既存ACTIVEメンバーは409。対象のPENDING招待は未消費のまま保ちます。invite.emailと履歴は保持。メール所有確認は既存仕様になく、新たなメール認証は追加していません。

本番反映コマンド（事前にD1バックアップ取得）:
```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc
```

手動確認:
1. OWNERで招待URLを作成。未登録ブラウザで開き、案件名・メール・CREATOR・PENDINGを確認。
2. Passkey登録へ進み「最初の案件名」がないことを確認。リロードしても案件・Roleが維持されることを確認。
3. 表示名RahabでPasskey登録。元の招待URLへ戻り、参加を確定。
4. 完了画面の案件名・CREATORを確認し「案件を開く」。招待元案件へ移動。
5. Punka側で参加済みRahab/CREATOR/参加日時、招待ACCEPTEDと招待先メールの履歴を確認。PENDINGは招待中セクションだけに表示。
6. Rahabの案件一覧に不要な新規案件が作られていないことを確認。
7. ログアウト後、別PENDING招待からログインしても元の招待へ戻ること、既存メンバー409で招待がPENDINGのままであることを確認。
8. 期限切れ・取消済み・使用済みは登録/参加不可。通常/signupでは従来どおり新規案件を作成できる。

このオンボーディング修正は2026-10-02に本番反映済みです。

今回の最終検証: APIテスト62件・全ブラウザテスト11件・型チェック・Webビルド/Worker dry-runが成功。ブラウザテストは共通fixtureでテストごとのクライアントアドレスと適切な画面待機時間を使用し、レート制限の干渉を回避。本番のレート制限は変更しません。

変更ファイル:
- web/src/main.ts
- api/src/auth.ts
- api/src/project-invites.ts
- migrations/0014_invite_enrollments.sql
- api/test/passkey.spec.ts
- api/test/navigation-invites.spec.ts
- e2e/navigation-invites.spec.ts
- e2e/fixtures.ts
- e2e/creator.spec.ts / inquiries.spec.ts / signup.spec.ts / bot-reviews.spec.ts / large-file.spec.ts（共通fixtureへのimport変更）
- docs/navigation-invites.md

既存機能の全体検証で/business画面のルート欠落も検出し、既存問い合わせAPIへ送信するフォームを復元しました。問い合わせの送信・管理画面・一般ユーザー403のE2Eも成功しています。

本番反映記録（2026-10-02）: D1バックアップ取得後に0014を適用し、Worker version `dcefcef8-14e5-427b-81d0-023901e40ad0`をデプロイ。本番HTML/JSのビルド一致、無効な招待の登録400、未認証受諾401、未適用migrationなしを確認。初回API確認は反映伝播中に旧版の404が返り、再確認で新APIの400を確認しました。既存本番招待の受諾と本人のPasskey登録は利用者の手動確認対象です。

表示名の確認・変更とOWNERによるメンバー取消（migration 0015）は[member-management.md](member-management.md)参照。招待用Passkey登録ボタンは「Passkeyを登録して参加する」。参加時の表示名はusers.display_name、必須trim後1〜50文字。再参加でも取消履歴を保持します。この追加修正は本番未反映です。
