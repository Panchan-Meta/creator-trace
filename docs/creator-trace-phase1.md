# Creator Trace Phase1 実装報告

## 1. 変更ファイル一覧

| ファイル | 内容 |
| --- | --- |
| `api/src/index.ts` | Creator Traceルーティング、旧API停止、Origin検査、サイズ制限、レート制限、レスポンス保護 |
| `api/src/creator.ts` | 案件・参加者・制作物・版・証跡・公開Verify API |
| `api/src/store.ts` | 旧サービスから独立したDB接続・認証監査 |
| `api/src/auth.ts` | Passkey再利用、旧招待登録停止、Creator Trace名称へ変更 |
| `migrations/0005_creator_trace.sql` | 新しい6テーブル、索引、参照・一意制約、履歴保護 |
| `web/src/main.ts` | 全画面変更、SHA-256計算、ファイル照合 |
| `web/src/style.css` | 制作管理向けレスポンシブUI |
| `web/index.html` | サイト名・説明 |
| `package.json` | 初期アカウント作成コマンド追加、旧運用コマンド除外 |
| `scripts/setup-local.cjs` | Creator Trace管理者トークンだけを生成 |
| `scripts/create-owner.cjs` | ローカル・本番の案件所有者アカウント作成 |
| `scripts/e2e-server.cjs` | 独立テストDBに初期ユーザーを投入 |
| `api/test/creator.spec.ts` | 登録・認可・公開情報・競合・改ざん防止テスト |
| `e2e/creator.spec.ts` | ブラウザで案件から版登録・匿名Verify・一致/不一致照合まで検証 |
| `api/test/legacy/*.disabled` | 旧index / MCP / Passkeyテストを隔離 |
| `e2e/legacy/proof.spec.ts.disabled` | 旧修了証E2Eを隔離 |
| `README.md` | Creator Trace向け起動・検証手順 |
| `docs/legacy/certificate-service.md` | 旧READMEを保存 |
| `docs/creator-trace-phase1.md` | 本報告 |

## 2. 停止した修了証関連機能

修了証・受講証明書の発行、CSV講座/受講者登録、受取招待、招待によるPasskey登録、自分の修了証画面、証明書Verify、失効・通知・旧OTS運用API、旧Bot MCP経路を停止しました。旧API/MCPは410を返します。旧画面はルートに存在しません。

Passkeyログイン、ログアウト、ログイン中のPasskey追加、ユーザー・セッション・監査テーブルは再利用します。旧データの削除・新制作物への自動変換は行っていません。旧サービスソースは現行Workerの実行経路から外しています。

## 3. 追加した機能

- 案件名、クライアント名、制作期間、所有者を記録。
- 案件ごとに担当者・制作者の氏名、任意メール、役割を記録。
- ファイル種別を問わずブラウザでSHA-256を計算。Phase1のブラウザ上限は256 MiB。
- ファイル名、サイズ、MIME、制作者、登録日時、コメントを版ごとに保存。
- 最大版番号を最新として表示し、修正版を同じ制作物へ追加。
- 版と証跡をD1 batchでまとめて登録。版番号はDBで採番し、重複を一意制約で防止。競合時は409で再登録を案内。
- 公開URLでハッシュ・登録日時・外部証明状態を確認。手元ファイルの一致/不一致をブラウザで検証。
- 案件所有者に限定した閲覧・登録。別所有者には404。公開APIは許可したフィールドだけ返却。
- 将来の現状診断31,000円・導入パック95,000円をトップに掲載。

ファイル本体、ウォレット、NFT、トークン、Ethereumは使用しません。料金は表示のみで、申込み・決済は未実装です。

## 4. DB migration

`0005_creator_trace.sql` は追加型です。既存の0001〜0004と旧データを保ったまま適用します。

| テーブル | 主な項目 |
| --- | --- |
| projects | id, name, client_name, owner_id, start_date, end_date, created_at |
| creators | id, project_id, name, email, role, created_at |
| assets | id, project_id, creator_id, filename, mime_type, size, created_at |
| asset_versions | id, asset_id, version, sha256, status, comment, created_by, creator_id, filename, mime_type, size, created_at |
| proofs | id, asset_version_id, sha256, timestamp_status, ots_proof, bitcoin_status, timestamp, created_at |
| approvals | id, asset_version_id, approver_id, status, comment, created_at |

制作期間と、修正版で変わるファイル情報を追加しています。assetsのファイル情報は初版の値、asset_versionsが各版の正確な情報です。最新判断には版番号を使用してください。

版の上書き・削除、証跡の削除・識別子/ハッシュ/登録日時変更はDBトリガーで禁止。証跡ハッシュは対象版と一致する必要があります。案件をまたぐ制作者指定は禁止します。

DRAFT / SUBMITTED / APPROVED / FINALをDBで定義し、Phase1の登録APIはDRAFT / SUBMITTEDのみ許可します。承認の履歴・状態遷移はPhase2です。proofsの外部証明状態はNOT_REQUESTED、外部timestamp / ots_proofはNULLから開始します。

## 5. API一覧

通常の管理APIはPasskeyセッション必須、POSTは同一Origin必須です。リクエストは64,000 bytes以下のJSONメタデータに限定します。

| Method | URL | 内容 |
| --- | --- | --- |
| GET | /api/health | 稼働状態、サービス名、Phase |
| GET / POST | /api/projects | 自分の案件一覧 / 案件登録 |
| GET | /api/projects/{id} | 案件・参加者・制作物 |
| POST | /api/projects/{id}/creators | 担当者・制作者登録 |
| POST | /api/projects/{id}/assets | 制作物・初版・証跡登録 |
| GET | /api/assets | 自分の制作物一覧 |
| GET | /api/assets/{id} | 制作物・全版履歴 |
| POST | /api/assets/{id}/versions | 修正版・証跡登録 |
| GET | /api/proofs/{id} | 所有者向け証跡詳細 |
| GET | /api/verify/{proofId} | 匿名公開Verify |
| GET | /api/auth/session | ログイン状態 |
| GET | /api/auth/passkeys | 登録済みPasskeyの登録日時 |
| POST | /api/auth/passkey/login/options | 認証開始 |
| POST | /api/auth/passkey/login/verify | 認証検証 |
| POST | /api/auth/passkey/register/options | ログイン中のPasskey追加開始 |
| POST | /api/auth/passkey/register/verify | Passkey追加検証 |
| POST | /api/auth/logout | セッション削除 |
| POST | /api/auth/owner-session | 初期設定用。OPERATOR_TOKENのBearer認証＋既存ユーザーID必須 |

公開VerifyのJSONは id / sha256 / created_at / timestamp_status / bitcoin_status / timestamp の6項目だけです。ファイル名・案件名・制作者・メール・コメント・ユーザーIDは含めません。証跡IDを知る人はログインせず参照できます。

例：制作物登録

```json
{"filename":"mix.wav","mime_type":"audio/wav","size":1024,"sha256":"64桁の小文字hex","creator_id":null,"comment":"初稿","status":"SUBMITTED"}
```

ハッシュはブラウザが申告した値です。サービスは原本を受信しないため、実際の内容や著作権、納品先による受領を保証しません。第三者は原本とのハッシュ照合で内容を確認します。

## 6. 画面一覧

| URL | 画面 |
| --- | --- |
| / | コンセプト、Punka制作例、運用支援商品の案内 |
| /projects | 案件一覧・案件作成 |
| /projects/{id} | 案件詳細・参加者登録・制作物登録 |
| /assets | 制作物一覧・最新の版番号 |
| /assets/{id} | 全版の履歴・修正版登録 |
| /proof/{id} | 所有者向け証跡詳細・公開Verify URL |
| /verify/{proofId} | ログイン不要の確認・ローカルファイル照合 |
| /login | Passkeyログイン |
| /settings/security | Passkey追加・ログアウト |
| /setup | 管理者による初回セッション設定 |

## 7. Phase1 MVP完成範囲

案件登録、ファイル登録、ブラウザSHA-256、版管理、Verifyページを実装済みです。参加者登録・所有者による保護・証跡詳細・ファイル照合も含みます。

Timestamp / Bitcoinは「未取得・未確認（Phase2）」です。サーバー登録日時を外部Timestampと同一視しません。承認済み・最終版にする操作は提供していません。

## 8. 本番デプロイ手順

本作業では本番DB・Workerは変更していません。

1. Cloudflareの対象アカウント、`api/wrangler.jsonc` のdatabase_id、APP_ORIGIN、RP_IDを確認。APP_ORIGINは実際の公開HTTPS Origin、RP_IDはそのホスト名。既存Passkeyを維持するならOrigin / RP_IDを変更しない。
2. 依存関係を導入し、型チェック・テスト・ビルドを実行。
3. DBをエクスポートしてバックアップ。
4. migrationsを本番へ適用し、Workerをデプロイ。
5. 必要なら所有者を作成し、OPERATOR_TOKENを設定。
6. /setupで初期設定し、/settings/securityでPasskeyを登録。ログアウト後、Passkeyログインを確認。
7. 案件・制作物を登録し、匿名Verifyを別ブラウザで確認。旧APIの410も確認。

```bash
npm run typecheck
npm test
npm run build
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-phase1.sql
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npx wrangler secret put OPERATOR_TOKEN --config api/wrangler.jsonc
npm run deploy --prefix api
npm run account:create -- --remote
```

OPERATOR_TOKENは管理者だけが保持するランダムな秘密値を入力します。既存値がある場合はそれを利用できます。旧Bot・証明書運用の定期ジョブは停止してください。初期設定後、不要ならOPERATOR_TOKENを削除すると初期セッションAPIは利用不能になり、Passkeyログインは継続します。追加所有者の作成には再設定が必要です。

旧R2 bindingは既存証明データ保持のため構成に残ります。Phase1のCreator TraceはR2へ書き込みません。

D1 batchの原子性とmigration運用はCloudflare公式資料を確認しました：[D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Migrations](https://developers.cloudflare.com/d1/reference/migrations/)。

## 9. 手動テスト手順

1. READMEのローカル起動手順で新規所有者を設定し、Passkey追加・ログアウト・再ログイン。
2. 「Punka ボカロ楽曲制作」案件を作成。クライアント名と制作期間を入力。
3. 作詞、作曲、編曲、Mix、Mastering、イラスト、MVの担当者を登録。
4. 小さい実ファイルを選択して登録。原本がネットワークへ送信されず、SHA-256とメタデータだけが送信されることをブラウザ開発者ツールで確認。
5. Version 1の登録日時・ファイル情報・制作者・コメント・ハッシュを確認。
6. 同じ制作物に修正版を追加。Version 2が最新となり、Version 1が残ることを確認。
7. 証跡詳細から公開Verifyを開き、別の未ログインブラウザでも表示されることを確認。
8. 同じ内容のファイルは名称変更しても一致。内容を変えると不一致。公開画面・公開APIに氏名、メール、案件名、ファイル名が出ないことを確認。
9. Timestamp / Bitcoinが確認済みにならないことを確認。
10. 別の所有者でログインし、他人の案件・制作物・非公開証跡URLが404、一覧には自分のデータだけ出ることを確認。
11. 不正ハッシュ、FINAL状態、終了日が開始日より前、別案件のcreator_idをAPI送信して400を確認。未認証管理APIは401、異なるOriginのPOSTは403。
12. 旧 /api/issuance-batches、/api/certificates、/mcp/* が410、旧画面が存在しないことを確認。

## 10. 残課題

- Phase2：OpenTimestamps作成・保存・更新・再試行・Bitcoin検証、独立Timestamp日時、OTSダウンロード。既存のOTS解析/Bitcoin検証コードは将来再利用可能ですが新しいproofsとは未接続。
- Phase2：承認者と承認履歴、差戻し、DRAFT→SUBMITTED→APPROVED→FINAL状態遷移。履歴の不変性を維持するため、状態変更の別履歴設計またはトリガー変更が必要。
- Phase3：外注者招待、案件メンバー権限、APIキー・API公開。現在は所有者限定、担当者登録によるログイン権限付与はありません。
- 大容量ファイルのストリーミングハッシュ。現在はarrayBufferを使うため256 MiBで制限。
- ページング・検索・編集・アーカイブ、原本の外部保存先URL連携、納品先の受領記録。
- 初期設定を管理者操作からセルフサービスへ移行、Passkey喪失時の復旧、初回登録APIの本番端末テスト。
- Punkaの実ファイル投入・運用検証。架空ハッシュのサンプルデータを実際の証明として投入していません。
- 旧ソース・旧運用スクリプト・旧DB/R2の長期保管方針を決めた後の整理。
- 運用支援商品の問い合わせ先・申込み・決済導線。現在は価格・提供内容の紹介まで。

## 検証結果

- `npm run typecheck`：API / Web / E2Eの型チェック成功。
- `npm test`：13件成功。新しいCreator Trace APIと、将来利用するOTS解析の単体テストを含みます。
- `npm run build`：Webビルド・Worker deploy dry-run成功。最終UI変更後のWebビルドとWorker dry-runも成功。
- `npm run test:e2e`：Firefoxのモバイル相当390px幅で1件成功。初期設定、案件・制作者・初版・修正版、匿名Verify、ファイル一致・不一致を検証。
- テストDBで0001〜0005を適用。実際の本番migrationと本番デプロイは未実施。
- Passkey追加開始・ログイン開始のAPIは検証済み。実機によるPasskey登録/認証完了は手動テストで確認してください。
