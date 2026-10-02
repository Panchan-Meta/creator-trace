# Reviewerコメント・ログインユーザー表示

この文書は0016時点の仕様です。準備中の0017で承認権限が更新されます。[最新の変更仕様](asset-version-approval.md)を参照してください。

2026/10/02 本番反映済み。migration `0016_reviewer_comments.sql` 適用済み。デプロイID：`174df0c1-1319-438f-90a4-32b648d2e75a`。

## 変更ファイル

- `api/src/operations.ts`：コメントAPI、承認担当管理API、案件認可、承認・差戻し・FINAL化の権限変更。
- `api/src/auth.ts`：session情報に案件別Role・案件名・ADMIN判定を追加。
- `web/src/main.ts`：制作物単位のコメント、Reviewer最終判断ボタン非表示、承認担当指定、共通ヘッダー。
- `web/src/style.css`：ヘッダー折り返し・スマホ表示・コメント入力欄。
- `migrations/0016_reviewer_comments.sql`：追加テーブル・追記制約・監査イベント・今後の最終判断認可。
- `api/test/reviewer-comments.spec.ts`：コメント・権限・承認担当・取消・再参加の検証。
- `api/test/reviewer-migration.spec.ts`：旧Reviewer判断履歴の完全保持。
- `api/test/member-migration.spec.ts`：移行前データ準備を新APIに依存しない方式に変更。
- `api/test/operations.spec.ts`、`api/test/member-management.spec.ts`：新仕様の承認担当へ更新。
- `e2e/reviewer-comments.spec.ts`：実Passkey、画面・API・時系列・XSS・PC/スマホ・ログアウト。
- このドキュメント。

## DBと保存仕様

`review_comments` は `artifact_id`（既存の `assets.id`）、`version_id`、`reviewer_id`、投稿時点の `reviewer_name`、`comment`、`created_at` を保存する。制作物IDで全Versionのコメントを取得し、時刻順、同時刻は挿入順で表示する。投稿時点の名前を保存するため、表示名変更後も過去の証跡は変わらない。

本文は前後をtrimし1〜4000文字。APIでユーザーID・名前・日時を決定し、本文はtextContentで表示する。HTMLを実行しない。コメントUPDATE/DELETEは禁止。投稿時のVersionと制作物の一致、ACTIVE Reviewer、案件/制作物の未アーカイブ状態をAPIとDBで確認する。

`project_approvers` は案件別の明示的な承認担当付与と取消を保持する。既存の案件ロールやメンバーIDを変更しない。OWNERは参加済みVIEWERを承認担当に指定できる。API・画面は有効な付与をAPPROVERとして扱う。REVIEWERへの付与は拒否する。

メンバー取消時は承認担当を自動失効する。再参加しても復活せず、OWNERの再指定が必要。付与・取消の記録を物理削除しない。

## API

- `GET /api/assets/{assetId}/review-comments`：ACTIVE案件メンバー向け。制作物単位で全コメント取得。Version番号、現在のReviewer所属状況も返す。
- `POST /api/assets/{assetId}/review-comments`：REVIEWERのみ。`{"version_id":"...","comment":"..."}`、成功201。
- `POST /api/projects/{projectId}/members/{memberId}/approver`：OWNERのみ。`{"enabled":true}`で付与、falseで取消。別案件のmemberIdは404。
- `GET /api/auth/session`：既存項目に `memberships`（project_id、project_name、role）と `is_admin` を追加。
- 既存のapprove/reject/finalize API：OWNERまたはAPPROVERのみ。REVIEWERは403。

書き込みは既存のOrigin検証とSameSite/HttpOnlyセッションを使用し、毎回ACTIVE所属と操作権限を確認する。ADMINは案件の最終判断権限とは別で、ADMINだけでは承認できない。

## 権限

| Role | 閲覧・コメント履歴 | 制作物/Version登録・再提出 | Reviewerコメント追加 | 承認/差戻し/FINAL化 | 案件管理/招待 | 承認担当指定 |
| --- | --- | --- | --- | --- | --- | --- |
| OWNER | 可 | 可 | — | 可 | 可 | 可 |
| APPROVER | 可 | — | — | 可 | — | — |
| MANAGER | 可 | 可 | — | — | 可 | — |
| CREATOR | 可 | 自分の制作物 | — | — | — | — |
| REVIEWER | 可 | — | 可 | — | — | — |
| VIEWER | 可 | — | — | — | — | — |

納品と証跡再確認は従来のOWNER/MANAGERにAPPROVERを追加。MANAGERのFINAL化は新仕様で禁止する。
修正・再提出は既存の不変Version設計に従い、新Versionの登録またはDRAFTの提出で行う。

## 画面

制作物詳細・Version詳細にReviewerコメントの履歴を表示する。制作物詳細では表示中Versionから投稿対象を選択し、Version詳細ではそのVersionを使う。古いVersionのコメントも全件表示。投稿者名、日時、v番号、本文を表示し、取り消し済み投稿者も履歴に残す。

REVIEWERに承認・差戻し・FINALボタンを表示しない。OWNER/APPROVERに最終判断ボタンを表示。OWNERの案件メンバー一覧に承認担当の指定・解除操作を表示する。

ログイン後の共通ヘッダーに表示名・Role・ログアウトを表示。案件/制作物/Version/私的Proofでは閲覧中案件のRoleを表示し、案件外では案件名とRoleの組み合わせを表示する。未参加の場合はその旨を表示する。ADMINは案件外で別表示する。スマホでは折り返す。

## 既存履歴への影響

追加型migration。既存users、Passkey、案件、制作物、Version、Proof、承認/差戻し、納品、Auditを削除・書き換えない。Reviewerによる過去の判断も残す。新しいDB認可トリガーは今後の状態変更だけに適用する。

追加監査イベント：`REVIEW_COMMENT_ADDED`、`APPROVER_GRANTED`、`APPROVER_REVOKED`。承認は従来のapprovalsとVERSION_APPROVED/VERSION_REJECTED、FINALはVERSION_FINALIZEDを使用する。

## 検証と手動確認

`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。

結果：型チェック・ビルド成功。APIは11ファイル86件成功。ブラウザ全体12件成功。招待受諾直後のヘッダー更新という最終変更後、関連7件を再実行してすべて成功。旧Reviewerによる承認/差戻し履歴の移行前後完全一致、今後の判断拒否、コメント全Version保持、XSS、CSRF、320/375/1280px表示を確認済み。

1. OWNERでReviewerとViewerを招待する。各参加者はPasskey登録/ログインして参加する。
2. Reviewerで制作物/Version詳細を開く。承認・差戻し・FINALが表示されないことを確認。
3. v1でコメントし、制作担当がv2を登録。v2詳細でもv1コメントが残ることを確認。
4. v2でコメントし、v1/v2のコメントが時系列に並び、再読み込みしても残ることを確認。
5. Reviewerからapprove/reject/finalizeを直接POSTし403を確認。
6. OWNERでViewerを「承認担当にする」。Approverの承認・差戻し・FINALを確認。
7. OWNERが承認担当を解除/メンバー取消し、既存セッションでも判断APIが拒否されることを確認。
8. ヘッダーをPC/375px/320px、トップ・案件・制作物・Version・Proof・設定で確認。ログアウト後は表示が消える。

## 本番反映

ユーザーのmigration適用・デプロイ依頼を受け、DBバックアップ、`0016_reviewer_comments.sql`適用、コードデプロイの順に行う。新コードは追加テーブルを必要とするため、migration前にコードだけをデプロイしない。

```sh
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-reviewer-comments.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

本番migration・デプロイ完了。バックアップ：`/tmp/creator-trace-before-reviewer-comments-20261002.sql`（権限600）。反映前後でユーザー・Passkey・メンバー・制作物・Version・承認・納品・Proof・Audit件数一致。本番HTML/JS/CSSがビルドと一致、health 200、未認証コメントAPI 401、PunkaのPasskey/ADMIN維持を確認。実アカウントでのコメント投稿や承認は本番では実行していない。
Approverを招待時から直接指定する方式は採用していない。まずViewerで参加し、OWNERが承認担当を指定する。
