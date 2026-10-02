# UI・ページング・Version証跡の修正（2026-10-02）

## 1. 変更ファイル

- `web/src/main.ts`: グローバルヘッダー、共通ページング、担当者入力フォーム削除、制作物登録アンカー、Version詳細での証跡表示・再確認。
- `web/src/style.css`: 制作物登録セクションのscroll-margin-top。
- `api/src/pagination.ts`: ページ番号・limitの正規化、limit+1の結果からhasNextを判定する共通処理。
- `api/src/creator.ts`: 案件・制作物・案件内制作物・Version履歴にページングメタデータを追加。Proof詳細の補完結果を返す。
- `api/src/timestamps.ts`: 保存済みOTSのupgrade処理を共通化し、複数Calendarを確認。旧確認済みProofの再確認でもupgradeする。
- `api/src/proof-view.ts`: Proof自身の成功履歴から不足ブロック情報を表示時に補完。last_checked_at、failure_stage、最新attemptと最新成功履歴を返す。
- `api/test/pagination.spec.ts`: 一覧の0件・1件・limitちょうど・次ページ・最終ページ、OWNER自動登録、担当者データとメンバーの分離。
- `api/test/operations.spec.ts`: 同一AssetのVersion 1/2の独立性、FINAL旧Version、既存OTS upgrade、404待機、複数Calendar、旧確認済みProofの情報補完、OTSなし旧Versionの新規作成日時。
- `e2e/pagination-version-proof.spec.ts`: 案件・制作物のページング、ヘッダー、担当者フォーム非表示、アンカー、Versionごとの表示とPOST先。
- `e2e/creator.spec.ts`: 削除したフォームへの依存を除き、既存担当者データの表示・制作履歴・納品・照合を検証。
- `e2e/reviewer-comments.spec.ts`: 案件Roleをグローバルヘッダーに表示しない仕様へ更新。
- 本書。

## 2. ヘッダー

表示は `ログイン中：表示名 / ADMIN`（管理者）または `ログイン中：表示名`（一般ユーザー）。案件名、案件Role、所属案件の列挙をヘッダーから除いた。案件詳細には「この案件でのRole」を表示する。ログアウト、案件・制作物・問い合わせ（管理者）・認証設定へのナビゲーションを維持する。

## 3–4. 案件・制作物ページング

共通の方式で、絞り込み・メンバー認可・アーカイブ除外後のSQLに `LIMIT limit+1 OFFSET (page-1)*limit` を適用する。追加の1件が存在するときだけhasNext=trueとし、表示するitemsはlimit件へ切り詰める。現在件数がlimitと同じだけでは次ページありと判定しない。

Webは `/api/projects?pagination=1` と `/api/assets?pagination=1` を使用し、`{items,page,limit,hasNext}` を受け取る。既存APIクライアント向けにはpagination=1を指定しない配列レスポンスを維持する。

案件内制作物にもassets_pagination、制作物のVersion履歴にもversions_paginationを追加した。Version履歴の次ページ確認用の追加fetchは不要になった。

UIはAPIで正規化されたpageを使用し、page=1なら前へ非表示、page>1なら前へ表示、hasNext=trueの場合だけ次へを表示する。0件・1件で次ページがなければページングnav自体を作らない。リンクは現在URLのqueryを引き継ぎ、pageだけ変更するため、qやlimitも保持される。既存ボタンサイズとgap=0.5emを使う。

## 5. 担当者入力領域

「担当者・制作者を登録」フォームと氏名・メール・担当役割の入力を削除した。既存creatorsは削除せず、「過去の担当者・制作者」の折りたたみ表示と既存Versionの担当者情報に残す。案件メンバー一覧、招待フォーム、招待中一覧、招待履歴、過去メンバー表示は維持する。

既存creators APIは互換性のため維持しているが、このデータはproject_membersではなく、APIから担当者データを追加しても案件参加にはならない。今回の指定どおり、UIから新規手入力登録できなくする変更であり、既存データのDELETEはない。

## 6. 案件メンバー追加の正式フロー

案件作成時、既存DB triggerで作成者がOWNERとして自動登録される。他の参加者はOWNER/MANAGERによるメンバー招待、招待URL、本人の表示名設定、Passkey登録またはログイン、招待受諾を経てproject_membersへ参加する。OWNERの招待追加は禁止されたまま。招待・受諾・取消・再参加・過去履歴の既存処理を変更していない。

## 7. 制作物登録アンカー

制作物登録権限があるOWNER/MANAGER/CREATORには、案件名の直下に `href="#new-asset"` の「新しい制作物を登録」リンクを表示する。同じページ内の `<section id="new-asset">` に登録フォームを置き、scroll-margin-top=2remを設定する。登録権限がないRoleには、移動先フォームもリンクも出さない。

## 8. 古いVersionでブロック情報がなかった原因

本番の該当Version 1を読み取り専用で調査した。

- asset_version_id: `3dbd40c7-0ae2-4573-a96f-a4eba4f4ea93`
- proof_id: `6d43416b-24cc-4a07-849a-cc8ea51d8a90`
- timestamp_created_at: `2026-10-02T02:46:47.385Z`（11:46:47 JST）
- 状態: WAITING_BITCOIN / PENDING
- 保存済みOTS: Bitcoin attestation 0件、Calendar pending 1件
- 保存されたAlice Calendarの `/timestamp/{commitment}`: HTTP 404

この404はまだそのOTSのBitcoin情報が取得可能になっていない状態であり、Version 2の成功とは独立している。OTS再作成やFAILED扱いは不要。調査時、本番Version 2は969477でCONFIRMEDだった。既存APIがVersion 1のProofを最新版へ置換する実装は見つからなかった。

UI面ではVersion詳細にBitcoinブロック情報・再確認操作を直接表示しておらず、証跡詳細への移動が必要だったため、Version詳細にも表示・操作を追加した。また既存upgradeは最初のCalendarだけを確認し、旧確認済みProofではupgradeを経由しなかった。これらを修正した。

確認済み旧Proofのブロック情報がnullの場合、保護triggerにより元行への上書きはできない。そこで、そのProof自身の新しい成功attemptから不足情報だけを表示時に補完する。元OTS、初回確認日時、既存ブロック情報、過去の確認済み状態を変更しない。

## 9. VersionとProofの紐付け

`asset_versions.id → proofs.asset_version_id（UNIQUE）→ proofs.id → 保存済みOTS → Bitcoin` を使用する。

単独Version APIはasset_idとversion_idの両方で検索する。Version画面は返されたv.proof_idでProofを取得し、そのProof IDでPOSTする。`POST /api/proofs/{proofId}/bitcoin-recheck`はそのProofのasset_version_idから案件を特定して認可し、processProofも同じproofIdだけを更新する。latest_versionを検証対象の選択に使用しない。

Version 1/2再確認後の相手Proof全列、SHA-256、OTS、日時が不変であることを統合テストで確認した。FINALのファイル情報とSHA-256も不変。

## 10. OTS upgrade・Bitcoin再確認

既存OTSがあれば、新規stampの `/digest` は呼ばず、そのOTSのpending Calendarを最大3件まで確認する。404は待機として扱い、別Calendarも確認する。1件の障害があっても別Calendarが応答すれば処理を継続する。保存済み証跡に対応する許可済みCalendar以外へは接続しない。

Bitcoin attestationを取得後、高さ・Merkle rootを解析し、既存のmainnet、block hash、raw header、block情報・採掘日時、canonical所属、確認数、hash再取得の検証を行う。成功時だけブロック情報を保存する。失敗時は元OTSを上書きしない。upgrade成功時も元のtimestamp_created_atを保持する。

OTSなしの旧Versionには「証跡を作成 / 再確認」を表示する。新規OTSを作成した場合は実際の現在日時をtimestamp_created_atへ保存し、Version登録日時を流用しない。同じSHA-256の既存証跡を再利用する既存動作では、その証跡の実際の作成日時を引き継ぐ。

Version詳細では外部証跡、Bitcoin状態、高さ・hash・採掘日時・初回確認日時・最終チェック日時を共通表示し、OWNER/MANAGERには「証跡を作成 / 再確認」「Bitcoinを再確認」を必要に応じて表示する。FINAL済みでも再確認できる。60秒のcooldownとleaseは維持する。

Proof APIはasset_version_id、sha256、timestamp_created_at、bitcoin_status、block情報、bitcoin_confirmed_atに加えlast_checked_atとfailure_stageを返す。最新失敗があっても、そのProof自身の過去の成功情報を表示できる。

## 11. 自動テスト結果

- API全体: 16ファイル144件成功。その後、OTSなし旧Versionの実作成日時を検証する1件を追加し、変更に関係する3ファイル46件が成功。計145件を検証した。
- ブラウザ: 関連7ファイル15件成功。案件・制作物ページング、アンカー、VersionごとのProof IDと表示、既存担当者履歴、制作物・修正版・納品・照合、招待参加・再招待・履歴、Reviewerの権限、Bitcoin表示を確認。
- 型チェック: API本体、APIテスト、Web、E2E成功。
- 最終ビルド: WebとWorker dry-run成功。
- Bitcoinのブラウザ表示・POST先テストはUI用モック。OTS upgradeと独立したDB保存はAPI統合テストで確認した。
- 既存の実Calendarブラウザテストも、隔離されたローカルD1で実OTSを取得し、再確認後に元のVersion情報が不変であることを確認した。本番データは更新していない。

## 12. DB migration

今回の変更に新しいmigrationはない。既存0019までのschemaを使用する。保護triggerを解除・変更せず、既存案件、メンバー、制作物、Version、Proof、SHA-256、OTS、承認、納品、Audit Log、招待履歴を削除しない。本番調査はSELECTと外部Calendar GETだけであり、調査時点では本番再確認・本番デプロイは実施していない。その後のデプロイ結果は末尾に記録する。

## 13. 本番デプロイコマンド

リポジトリルートで:

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

この変更のためのmigration applyやwrangler typesは不要。0019未適用の別環境へ反映する場合は、既存のBitcoin修正の適用手順を先に確認する。

## 14. 本番手動確認

1. 案件一覧と制作物一覧で、ヘッダーに表示名とADMIN（管理者のみ）が表示され、案件名・案件Roleが表示されないこと。
2. 0件・1件・limitちょうどの一覧で次へがないこと。`?limit=1`で複数件ある条件を選び、1ページ目は次へのみ、途中は前へ/次へ、最終ページは前へのみ。qがある場合、前へ・次へでqとlimitが残ること。
3. 案件詳細の手入力担当者フォームがなく、メンバー一覧・招待フォーム・招待中・履歴・過去メンバーが残ること。過去の担当者データがある案件では折りたたみ表示も確認する。
4. 案件詳細上部の「新しい制作物を登録」で同じページの登録フォームへスクロールすること。閲覧Roleに登録リンクが出ないこと。
5. 同じAssetのVersion 1を開き、外部証跡とBitcoin項目を確認する。「Bitcoinを再確認」のPOST先がVersion 1のproof_idであること。OTS未作成なら「証跡を作成 / 再確認」を使う。
6. 既存OTSのCalendarがまだ404ならWAITING_BITCOINを維持し、元の11:46:47などの作成日時が変わらないこと。アンカーが取得可能になった後は、そのOTSのupgradeで高さ・hash・採掘日時が表示されること。
7. Version 2を開いて同様に確認し、POST先がVersion 2のproof_idであること。Version 1/2のSHA-256、Proof ID、元OTS作成日時、確認済み情報が混ざらないこと。
8. FINAL済みVersionでも再確認でき、FINALのファイル情報・SHA-256・承認/納品履歴を編集していないこと。
9. 再確認失敗時にはfailure_stageと最新attemptを確認し、過去の成功記録・OTSダウンロード・Audit Logが残っていること。

## 本番デプロイ結果（2026-10-02）

- `npx wrangler deploy --config api/wrangler.jsonc` 成功。
- 本番URL: https://creator-trace-api.punkaproof.workers.dev
- Version ID: `3a2d3a3a-c576-43d9-a5e3-58995617f9eb`。
- トップページと`/api/health`はHTTP 200。HTMLが修正版JavaScript/CSSを参照し、両ファイルの本番配信SHA-256が検証済みローカルビルドと一致した。
- 未ログインの案件APIは401、OriginなしのBitcoin再確認POSTは403で拒否された。
- 今回migration適用・既存データ削除・手動の本番Bitcoin再確認は行っていない。ログインセッションがないため、認証後の本番UI操作とVersion再確認は上記手順で確認する。
- Cronは引き続き毎時17分。
