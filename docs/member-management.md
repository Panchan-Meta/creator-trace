# 表示名と案件メンバー取消

招待専用登録の表示名は必須、前後空白trim後1〜50文字。users.display_nameへ保存します。同名を許可し、内部識別・権限判定はuser_idのみを使います。既存ユーザーも受諾画面で表示名を確認・変更でき、その変更はアカウント全体に適用されます。通常オンボーディングの既存設定は維持します。画面はtextContent/入力valueで描画し、名前に含まれるHTMLやscriptを実行しません。

招待URL → 招待案件・メール・Role確認 → 表示名とPasskey登録、またはログイン → 表示名確認 → 受諾 → 案件名・表示名・Roleの完了画面 → 「案件を開く」。登録tokenとinvite_idのサーバー側関連付け、専用URLによる復帰を維持。メール所有確認は既存仕様にないため追加していません。

## API

- POST /api/auth/invite-signup: nameを1〜50文字に制限。
- GET /api/auth/session: 認証済みの場合display_nameを追加。
- POST /api/project-invites/accept: tokenと任意のdisplay_name。省略時も既存表示名を検証。表示名保存、招待消費、メンバー追加を同一D1 batch/DBトリガーで確定。失敗・再利用で表示名を変更しない。
- POST /api/projects/{projectId}/members/{memberId}/remove: bodyは{}。認証済みかつ当該案件のACTIVE OWNERのみ。MANAGER/CREATOR/REVIEWER/VIEWERは403、OWNER対象/既に取消済みは409、別案件のmember_idは404。Origin検査は既存Worker共通処理。
- GET /api/projects/{projectId}/members: removed_at、removed_by、removed_by_nameと追記型historyを追加。joined_atは既存created_atの別名。

取消はstatus=REMOVED、removed_at、removed_byをUPDATEします。メンバーや制作履歴を物理DELETEしません。確認ダイアログで取消範囲と履歴保持を説明し、キャンセルできます。ACTIVE一覧のOWNER以外にだけ操作を表示します。過去メンバー・取消履歴は折りたたみ表示。Version登録者、状態変更・承認・納品・受領の当事者は、現在非メンバーの場合にその旨を表示します。

## migration 0015_member_removal.sql

既存project_membersの全行・ID・Role・状態・参加日時をコピーしてCHECKへREMOVEDを追加します。旧REVOKEDは互換性のため保持。削除禁止・ID変更禁止・OWNER取消禁止・OWNERによる取消条件のDBガードを追加。既存ユーザー、Passkey、Version、承認、納品、Proof、Audit Logを削除・変更しません。migration前後で既存メンバー・制作履歴の一致を自動検証。

project_member_historyを追加し、既存メンバーの初期スナップショット、参加、取消、再参加を追記します。UPDATE/DELETE禁止。過去REVOKEDの取消時刻・取消者はデータが存在しないため「未確認」と表示し、推測しません。

再招待の受諾は同じ(project_id,user_id)のmembershipを再ACTIVE化。現在のremoved_at/removed_byをクリアし、最新joined_at・Roleを更新。以前の参加・取消日時・取消者はproject_member_historyとaudit_eventsに保持します。

## 認可と監査

access()は毎回DBでmembershipとstatusを確認し、REMOVED/REVOKEDは403。案件、Asset、Version、提出、承認、納品、受領、非公開Proof、APIキーによる案件アクセスに共通適用。Botレビューも毎回ACTIVEを確認。セッションは他案件のため維持します。案件/Asset一覧はACTIVE案件だけを返します。既存の匿名公開Verifyは公開された証跡の確認用として維持します。

MEMBER_INVITED、MEMBER_JOINEDを維持。MEMBER_REMOVEDにはproject_id/member_user_id/removed_by/role/timestampを記録。取消と監査はDBトリガーで原子的に確定。MEMBER_REINVITEDは、再招待を受諾した本人のuser_idが取消済みメンバーと一致した時に記録します。メールや表示名から本人を推測しません。token平文は監査に保存しません。

## 変更ファイル

- web/src/main.ts
- api/src/display-name.ts
- api/src/auth.ts
- api/src/operations.ts
- api/src/project-invites.ts
- migrations/0015_member_removal.sql
- api/test/member-management.spec.ts
- api/test/member-migration.spec.ts
- api/test/operations.spec.ts
- api/test/navigation-invites.spec.ts
- api/test/inquiries.spec.ts
- api/test/passkey.spec.ts
- e2e/navigation-invites.spec.ts
- docs/member-management.md
- docs/navigation-invites.md

既存テストのメンバーINSERTを列名指定へ変更し、追加列との互換性を維持します。

## 本番反映手順

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-member-removal.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc
```

この変更は本番未反映です。

## 手動確認

1. OWNERでCREATOR招待。未登録ブラウザから表示名を入力しPasskey登録。空欄・空白のみ・51文字は不可。受諾画面にも表示名が残ることを確認。
2. 既存ユーザーの招待では表示名が事前入力され、変更がアカウント全体に反映される説明を確認。
3. 受諾し、完了画面の案件・表示名・Roleと案件メンバー一覧のACTIVE・参加日時を確認。PENDINGは招待中だけに表示。
4. OWNERで「メンバーを外す」。キャンセル時はアクセス維持。確定後はACTIVE一覧から消え、過去メンバーに取消日時・Punkaを表示。
5. 取消されたブラウザの既存セッションで案件/Asset/Version/承認/納品/受領/Botレビューへアクセスし403を確認。MANAGER等の取消APIも403、OWNER自身は409。
6. OWNER側でVersion・承認・納品・Proofが残り、過去の当事者に「現在は案件メンバーではありません」と表示されることを確認。
7. OWNERで再招待し本人が受諾。再ACTIVE、指定Role、以前の取消日時・取消者・監査が残ることを確認。
8. 表示名にHTML/script文字列を入力しても通常のテキストとして表示され、実行されないことを確認。

最終検証結果: 型チェック・Webビルド/Worker dry-run・APIテスト74件（9ファイル）・全ブラウザテスト11件が成功。migration前後のデータ一致、全Roleの取消可否、既存セッション/APIキーの403、取消・再参加履歴、表示名の必須/trim/長さ/同名/XSS、CSRFと他案件member_id拒否を検証しました。
