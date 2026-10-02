> 本番反映済み（2026/10/02）：DBバックアップ後に0017を適用し、Version d5190c37-eaaf-4e73-ba10-7a668bcaf413をデプロイ。詳細は docs/invite-passkey.md の本番反映記録を参照。

# 招待履歴・制作物Version・Approvalの修正

本番未反映。今回の実装・検証はローカルのみ。本番データのDELETE、既存Assetの統合、本番migration適用は行っていない。
この仕様は0016時点のReviewer/Approver方針を更新する。今後の判断は案件の5Roleで管理する。

## 変更ファイル

- `migrations/0017_asset_versions_approval.sql`
- `api/src/creator.ts`：論理制作物名、採番トランザクション、最新Version/ファイル情報、同一取得時点の詳細取得。
- `api/src/operations.ts`：5Roleの認可、Approvalコメント、Role付き履歴、個別Approver設定API終了。
- `api/src/project-invites.ts`：limit・PENDING絞り込み。
- `api/src/auth.ts`：ヘッダーRoleを案件の5Roleへ統一。
- `api/src/bot-reviews.ts`：VIEWERのPOSTを拒否。GET履歴閲覧は維持。
- `web/src/main.ts`：新規制作物/修正版UI、制作物名/最新版情報、承認コメント、Role履歴、招待履歴3件。
- `api/test/version-approval.spec.ts`、`api/test/asset-version-migration.spec.ts`：追加検証。
- `api/test/operations.spec.ts`、`api/test/reviewer-comments.spec.ts`、`api/test/reviewer-migration.spec.ts`、`api/test/member-migration.spec.ts`：最新仕様と追加カラムに合わせ更新。
- `e2e/invite-history.spec.ts`：最新3件と全履歴保持。
- `e2e/creator.spec.ts`、`e2e/reviewer-comments.spec.ts`：制作物名、修正版、MANAGER/REVIEWER判断、OWNER限定FINAL。
- この文書と `docs/reviewer-comments.md` の仕様更新案内。

## DB migration

追加型の0017。既存の業務テーブルは作り直さない。

- `assets.name` を追加。旧Assetの値はNULLのままとし、表示時に既存filenameへフォールバックする。勝手な命名・統合をしない。
- `asset_version_counters(asset_id,next_version)` を追加。初期値は既存の各Assetの最大Version+1。
- 新Assetにカウンターを用意。既存クライアントによるVersion追加でもカウンターが後退しないようDBトリガーで同期。
- `asset_version_state_history.actor_role`、`approvals.approver_role` を追加。今後の操作時にRoleを保存。過去のRoleは推測して補完せず「当時のRole未確認」と表示。
- 状態変更の認可トリガーを新権限へ更新。FINALはACTIVE OWNERのみ。APPROVED/REJECTEDはACTIVE OWNER/MANAGER/REVIEWERのみ。
- 今後のVERSION_CREATED/SUBMITTED/APPROVED/REJECTED/FINALIZEDイベントにasset_id・asset_version_id・version・actor_roleを記録。
- 既存のVersion/Approval/Proof/Auditの不変性・削除防止、UNIQUE(asset_id,version)を維持する。

## AssetとVersion・自動採番

Assetは論理的な制作物。新画面で入力した制作物名を `assets.name` に保存する。ファイル名、SHA-256、MIME、サイズは各 `asset_versions` の情報。内部の関連付けはasset_idだけで行い、ファイル名や制作物名をIDにしない。

案件の「新しい制作物を登録」は新AssetとVersion 1を作成。制作物詳細の「修正版を登録」は同じasset_idへ次Versionを追加。ユーザーにVersion番号を入力させない。旧APIクライアントのname省略時はfilenameを名称として保存し、互換性を維持する。

Version追加はD1 batchトランザクション内で、カウンターを1増加→割り当て番号で新Version INSERT→Proof/外部保存先 INSERTを実行する。競合する登録もトランザクション単位で順番に処理される。途中失敗は採番・Version・Proof・監査もロールバック。UNIQUE制約で番号重複を二重に防止する。

旧VersionをUPDATE/DELETEしない。FINALからの修正も新Version追加。DRAFTのファイル内容の修正も既存の不変Version設計に従い新Versionとして追加する。

一覧は制作物名を主表示し、最新Versionと最新版ファイルを併記。詳細はVersion DESC。ページングしても全Version中の最大番号だけを最新版として扱う。詳細の制作物情報とVersion一覧は同じDB batchで取得する。

## 権限

| Role | 新規/修正版登録・Submit | Approve/Reject | Finalize | 案件運用/招待 | メンバー取消 |
| --- | --- | --- | --- | --- | --- |
| OWNER | 可 | 可 | 可 | 可 | 可 |
| MANAGER | 可 | 可 | 不可 | 可 | 不可 |
| CREATOR | 自分の制作物 | 不可 | 不可 | 不可 | 不可 |
| REVIEWER | 不可 | 可 | 不可 | 不可 | 不可 |
| VIEWER | 不可 | 不可 | 不可 | 不可 | 不可 |

全Roleは案件内の制作物/Version/コメント履歴を閲覧できる。Reviewerの制作物単位のコメント機能も維持する。
VIEWERは案件内の更新を行えない。受領操作・Bot新規レビューも403とし、履歴閲覧は維持する。案件Roleは案件ごとの権限であり、別案件の権限やアカウント操作には影響しない。

過去のproject_approvers設定は削除しないが、今後の認可には使用しない。VIEWERへの旧設定が残っていても読み取り専用。旧個別設定APIはOWNERに410、その他に403を返し、設定を変更しない。

## Approvalコメント・Finalize

承認コメントは任意。差戻しコメントは必須。前後trim、最大4000文字。APIの `comment` を受け取り、旧 `reason` も互換性のため受け付ける。両者に異なる値を指定した場合は400。

既存approvalsテーブルに `approver_id`、`status`、`comment`、`created_at`、新規 `approver_role` を追記する。履歴APIは引き続き `approver_user_id`/`decision` の名前で返す。状態履歴にもRole・コメントを保存し、過去行を上書きしない。

UIは「承認コメント（任意）」「差戻しコメント」を表示。ボタンは「提出する」「承認する」「差し戻す」「FINALに確定」。FINALボタンはOWNERのみ。APIとDBでもOWNERを検証し、MANAGER/REVIEWER/CREATOR/VIEWERは403。OWNERでもAPPROVED以外からFINALは409。

## 招待履歴

案件詳細は `GET /api/projects/{projectId}/invites?limit=3` を使用。DBクエリはcreated_at DESC、id DESC、LIMIT 3。
「招待中」は別に `?status=PENDING` で全件取得するため、古い有効な招待も管理できる。
招待作成成功後は両方を再取得する。URLコピーへのフォーカスと秘密tokenの非再表示を維持する。
DBの全履歴と既存のパラメータなし一覧APIは保持する。全履歴専用画面は今回追加していない。

## 自動テスト

- 新Asset v1、同一Assetでv2/v3、異なるfilename、旧Version保持、番号重複拒否。
- 同時登録12件がすべて成功し、連番・Version/Proofの保持を確認。
- 途中失敗でカウンター/Version/Auditを巻き戻し。
- 5RoleのSubmit/Approve/Reject/Finalize、空コメント、Approval/状態Role、監査metadata、不変性。
- 3件だけ取得・表示し、PENDING/DB/全履歴APIには5件が残る。
- migration前後で、別Asset、FINAL、Proof/OTS/Bitcoin、Approval、Delivery、Reviewerコメント、Auditが完全一致。
- 既存招待・Passkey・Bot・Business問い合わせ・大容量ファイルを含むブラウザ回帰テスト。

検証結果：型チェック・本番ビルド成功。APIは13ファイル97件成功、ブラウザ全体13件成功。0017 migrationによる既存データ完全保持テスト成功。最終DB取得処理の関連ブラウザ3件を再実行し、すべて成功。

## 本番反映手順

ユーザー確認後にバックアップ→0017適用→コードデプロイを行う。新コードは追加カラム・カウンターを必要とするため先にmigrationを適用する。

```sh
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-version-approval.sql
chmod 600 /tmp/creator-trace-before-version-approval.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

今回は本番migration・本番デプロイを実行しない。

## 手動確認

1. OWNER/CREATORで案件詳細から制作物名を入力し、v1ファイルを「新しい制作物を登録」。Version 1を確認。
2. 同じ制作物詳細で別ファイル名のv2/v3を「修正版を登録」。URLのasset_id不変、番号自動増加、旧Version保持を確認。
3. 案件一覧で制作物名、最新Version、最新版ファイルを確認。`?limit=1&page=2` で旧Versionに最新版表示が付かないことも確認。
4. MANAGER/REVIEWERで承認コメントを入れて承認。別SUBMITTED版は差戻し理由を入力して差し戻す。空理由400を確認。
5. 状態・承認履歴で投稿者、当時Role、日時、コメントを確認。再読み込み後も保持。
6. MANAGER/REVIEWER/CREATOR/VIEWERでFINALボタンがないこと、直接APIで403になることを確認。
7. OWNERでAPPROVED版をFINALに確定。DRAFT/SUBMITTED/REJECTEDからは409を確認。
8. 招待を5件作成。履歴は最新3件、招待中には有効PENDING全件、既存全履歴APIには全件が残ることを確認。
9. 旧別Asset、Version、Proof、承認、納品、監査が引き続き閲覧でき、勝手に統合されていないことを確認。
