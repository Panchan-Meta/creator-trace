# Bitcoinチェーン検証（0018）

## 実装と検証方式

既存のBitcoin Core RPCを維持し、Esplora互換REST APIを追加した。APIはWorkerからのみ呼ぶ。OTSのSHA-256操作を解析し、Bitcoin attestationからblock heightとMerkle rootを得る。OTSの標準Bitcoin attestationにはblock hashや採掘日時は含まれないため、これらはチェーンAPIで取得する。

BITCOIN_API_BASE_URLがあればEsploraを優先し、なければ既存BITCOIN_RPC_URLを使う。両方未設定でもOTSは失敗扱いにせず、BITCOIN_ANCHOR_FOUNDを保存する。

Esplora検証：

1. GET /block-height/0 がBitcoin mainnetのgenesis hashと一致。
2. GET /block-height/{height} でブロックハッシュを取得。
3. GET /block/{hash}/header の80byteヘッダーをローカルSHA-256二重ハッシュし、block hashと一致することを確認。ヘッダー中のMerkle rootもOTSの操作結果と一致。
4. GET /block/{hash} のheight、hash、Merkle root、採掘時刻がヘッダー/対象と一致。
5. GET /block/{hash}/status のin_best_chain=trueを確認。
6. GET /blocks/tip/height から6確認以上を確認。
7. GET /block-height/{height} をもう一度取得し、読み取り中のreorgを検出。

API仕様：https://github.com/Blockstream/esplora/blob/master/API.md
初期接続先の例：https://blockstream.info/api

MVPは外部APIが返すcanonical chainとtipを信頼する方式。全BitcoinチェーンのPoW/難易度/コンセンサスを独立検証するフルノードではない。RPCの場合は既存のmainnet・height・Merkle root・6確認検証を維持しcanonical hashを再確認する。

APIに送るのはblock height/hashのみ。ファイル本体・ユーザー情報・OTS全体・対象ファイルのSHA-256は送らない。HTTPS必須（ローカル開発のみHTTP localhost可）、URL内資格情報/queryは禁止、redirectは禁止。各アンカーの検証全体に15秒のtimeout、応答上限16KiB、最大2アンカーを検証する。URLはリクエストbodyから受け取らず運営者の環境設定のみ。

## DBと状態

migration：migrations/0018_bitcoin_verification.sql（追加型、2026/10/02本番適用済み）。既存行をUPDATE/DELETEせず、既存の確認済みProof、Version、承認、納品、Audit Logを保持する。

proofs追加列：

- bitcoin_block_height：検証成功したブロック高さ。既存bitcoin_blockも互換用に同じ高さを保存。
- bitcoin_block_hash：検証成功したブロックハッシュ。
- bitcoin_block_time：ヘッダーの採掘日時をUTC ISO 8601で保存。
- bitcoin_verification_state：新しい検証段階。

既存bitcoin_confirmed_atはCreator Traceの初回検証成功時刻（UTC ISO 8601）。採掘時刻を代入しない。画面はすべてJST（UTC+09:00）。

bitcoin_verification_attemptsを追記型で追加。proof_id、actor_user_id、state、provider、block_height/hash/time、confirmations、error_code、checked_atを記録。UPDATE/DELETEはDB triggerで拒否。API URLや資格情報は保存しない。

| 段階 | 意味 |
| --- | --- |
| OTS_CREATED | OTSあり、Bitcoinアンカー未取得 |
| WAITING_BITCOIN | Calendarのpending証跡あり、Bitcoinアンカー取得待ち |
| BITCOIN_ANCHOR_FOUND | Bitcoin高さ/Merkle rootあり、チェーン検証未実施 |
| BITCOIN_VERIFIED | チェーン検証成功、bitcoin_status=CONFIRMED |
| VERIFY_FAILED | 検証/取得失敗。保存済みOTSと作成日時を保持 |

従来proof_statusのCHECK制約は変更せず維持。新段階はbitcoin_verification_stateとAPIのverification.stateで表す。既存OTSも解析してアンカー表示でき、API未設定は「Bitcoinアンカー情報あり・チェーン検証未実施」と表示する。設定の有無だけでCONFIRMEDにはしない。

確認済みProofの再検証は元のbitcoin_confirmed_at、OTS、ブロック情報、既存状態を上書きしない。成功・失敗は新しいattemptとAudit Logへ記録。最新attemptが失敗なら画面に「直近のBitcoin再確認は失敗しました」を別表示する。過去の確認済み状態を根拠なく無効化しない。旧確認済みProofの新しい列はnullのまま保持し、再検証で取得した情報はattemptに保存する。

Audit：BITCOIN_CONFIRMED、BITCOIN_REVERIFIED、BITCOIN_ANCHOR_FOUND、BITCOIN_VERIFY_FAILED、BITCOIN_VERIFICATION_PENDING。OTS_CREATEDも従来どおり保持。

## API・UI・Cron

POST /api/proofs/{proofId}/bitcoin-recheck を追加。OWNER/MANAGERかつACTIVE案件メンバーのみ。既存Origin検証を維持。未ログイン401、CREATOR/REVIEWER/VIEWER403。OTS未作成は409。既存retry APIも維持。実行結果は保存後に証跡詳細を読み直して確認する（200は検証済みという意味ではない）。

二重実行はProofとSHA-256のlease、60秒cooldownで制御。確認済みProofでも再検証時は409を返す。

GET /api/proofs/{id} と公開許可済みGET /api/verify/{id}にブロック高さ/hash/採掘時刻、検証サマリー、最新attemptを追加。匿名公開は既存PUBLIC_PROOF_IDSの明示許可のみで範囲を拡大しない。public responseにはactorや設定URL、資格情報を出さない。

画面：証跡詳細とファイル確認画面に「Bitcoinを再確認」。確認済みでもOWNER/MANAGERに表示。ブロック高さ、ハッシュ、採掘日時、Creator Trace検証日時を別項目にする。

既存Cron（毎時17分）を再利用。未確認は1時間以上あけて最大3件/回、確認済みは1日以上あけて同じ処理で再検証する。大量の未確認証跡がある場合は確認済み再検証が遅れる可能性がある。lease/cooldownをCronでも守る。

## 本番設定手順（2026/10/02実行済み）

お客様の本番デプロイ依頼を受け、以下のバックアップ・0018適用・環境設定・デプロイを実行した。

1. DBバックアップをアクセス制限された場所へ保存。

```sh
install -d -m 0700 /tmp/creator-trace-before-0018
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output /tmp/creator-trace-before-0018/production.sql
chmod 0600 /tmp/creator-trace-before-0018/production.sql
npx wrangler d1 migrations list creator-trace-db --remote --config api/wrangler.jsonc
```

2. 未適用が0018のみであることを確認してmigration適用。

```sh
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
```

3. api/wrangler.jsoncのvarsへ以下を追加。接続先は運営者が選択。

```json
"BITCOIN_API_BASE_URL": "https://blockstream.info/api"
```

既存RPCを使う場合はBITCOIN_RPC_URLをCloudflare Secretで設定する。新しいEsplora設定を削除すればRPCへ戻せる。どちらも未設定ならアンカー検出のみ。環境設定を変更したら以下を実行。

```sh
npx wrangler types --config api/wrangler.jsonc
npm run typecheck
npm test
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

migration後の旧Worker稼働は追加型なので可能。新Workerは0018の列/tableが必要なので、migration適用前にデプロイしない。

4. OWNER/MANAGERでログインし、案件→制作物→Version→「証跡詳細」→「Bitcoinを再確認」。元の制作物・承認操作は不要。

## 手動確認

- APIなし：Bitcoinアンカーのある既存証跡を開く。「Bitcoinアンカー情報あり・チェーン検証未実施」、OTS作成日時、ブロック高さを確認。「未確認（検証設定が必要）」とは表示しない。
- API設定後：「Bitcoinを再確認」→「確認済み」、Creator Trace確認日時、ブロック高さ/hash、採掘日時が別表示。OTS作成日時が変わらない。
- 二重押下：送信中ボタンdisabled。60秒以内の再試行は409。
- 60秒以上後に確認済みを再検証：初回Creator Trace確認日時・OTSを保持し、最新チェック日時が更新される。
- テスト環境でAPI障害：保存済みOTSはダウンロード可能なまま。未確認はVERIFY_FAILED、過去に確認済みならその状態を保持し最新失敗の説明を表示。
- CREATOR/REVIEWER/VIEWER：ボタンなし、APIを直接POSTしても403。
- 手元のファイル照合は別機能。「ファイルと証跡を確認する」→ファイル選択→「ファイルを照合する」。Bitcoin確認とファイル一致を混同しない。

## 実外部APIの読み取り専用検証

2026/10/02 10:06:55 JSTに、既存の安全なDBバックアップから取得したOTSを解析し、新実装から https://blockstream.info/api を実際に呼び出した。

- OTSアンカー高さ：969477。
- 検証したhash：000000000000000000016fa7af55cec7db322c8b6702bfe9695d7d892a454a0b。
- ヘッダー二重SHA-256・Merkle root・mainnet・canonical所属・再取得hash一致：成功。
- 確認数：37（検証時点）。
- ブロック採掘日時：2026/10/02 03:35:46 JST（2026-10-01T18:35:46Z）。
- コード実行での検証成功時刻：2026/10/02 10:06:55 JST。

この読み取り専用検証は本番DBへ保存していない。本番画面のCONFIRMED更新や本番ボタン操作は未実施。テストで使う人工ヘッダー/レスポンスとは別の実データ検証。

## 変更ファイル

- api/src/bitcoin.ts（新規）：Esplora/RPC検証、timeout/エラー分類。
- api/src/proof.ts：既存RPC呼び出しを共通検証へ接続。
- api/src/timestamps.ts：検証保存、追記履歴、再確認、Cron。
- api/src/proof-view.ts：アンカー検出、検証段階、最新attemptの安全なサマリー。
- api/src/store.ts：BITCOIN_API_BASE_URL型。
- api/src/creator.ts：追加ブロック情報・サマリー取得。
- api/src/operations.ts：Bitcoin再確認API。
- web/src/main.ts：状態表示・再確認ボタン・ブロック情報。
- migrations/0018_bitcoin_verification.sql：追加列・追記型検証履歴・保護trigger。
- api/test/bitcoin.spec.ts（新規）、operations.spec.ts、proof-view.spec.ts、creator.spec.ts：検証・保存・認可テスト。
- api/test/asset-version-migration.spec.ts、member-migration.spec.ts：旧列保持の比較に追加列を考慮。
- e2e/bitcoin-verification.spec.ts（新規）：UI状態・送信中disabled・PC/スマホ。
- e2e/proof-verification.spec.ts：新しい状態名に対応。

API未設定、API成功、block一致/不一致、timeout、retry、確認済み再検証、証跡不変性、履歴追記、Cronを自動テストで確認する。UIテストは明示的なモックであり、上記の実API検証とは区別する。

## 最終テスト結果

- 型チェック：成功（API本体・APIテスト・Web・E2E）。
- API：15ファイル125件成功。Cronの確認済み再検証も成功。
- ブラウザー：新規Bitcoin表示テスト1件成功（PC/スマホ、再確認中disabled、確認済み後の失敗表示）。既存制作物・修正版登録/非公開ファイル照合テスト1件も成功。
- ブラウザーテスト初回はテストAPIリクエストにOriginがなかったため403となり失敗。テストへ既存CSRFルールどおりOriginを追加し再実行して成功。CSRF実装は緩和していない。
- 最終ビルド：WebとWorker dry-run成功。実装時点では本番migration・デプロイ・Proof状態更新は未実行。その後の本番反映結果は下記。
- 実Blockstream API：保存済みOTSのブロック969477/Merkle rootが一致、37確認。読み取り専用のため本番のCONFIRMED保存とは区別する。

## 本番デプロイ結果（2026/10/02）

- Worker Version：`a0d76c92-1a97-4bfb-8327-7dcd3dc59e83`。
- API接続先：`BITCOIN_API_BASE_URL=https://blockstream.info/api`。Cronは毎時17分。
- バックアップ：`/tmp/creator-trace-before-0018-5ab6fumo/production.sql`、322507 bytes、ファイル0600・ディレクトリ0700。SHA-256：`9e1cb510513d1db60dada566ece4059333529c1c7ea5cd6999c5d4cd8001cbd5`。バックアップは一時ディレクトリなので環境の削除時には失われる。
- migration 0018だけ適用。migration前後のバックアップを読み込み、追加列を除く42テーブルの元の全レコードが一致することを確認（実行時に更新されるrate_limits、migration管理テーブルは比較対象外）。ユーザー7、Passkey6、Asset6、Version9、Proof9、Approval6、Delivery2、Audit114を保持。適用直後の新規検証履歴0件。
- 型定義更新・型チェック・ビルド成功。未適用migrationなし。
- 本番Firefoxでトップ200と今回のHTML/JS配信を確認。「Bitcoinを再確認」、アンカー検出表示、採掘日時の表示コードが配信済み。
- 未ログイン案件/証跡API401、Bitcoin再確認POST401。非公開Proofの匿名Verify404を維持。
- 本番のログイン済みセッションがないため、管理者の再確認ボタン操作は未実施。ログイン後、証跡詳細の「Bitcoinを再確認」から実行可能。Cronも順次再確認する。
- 追加変更ファイル：api/wrangler.jsonc、api/worker-configuration.d.ts。テスト用api/vitest.config.mtsでは本番API接続先を継承しないよう明示的に空へ上書きし、外部APIモックテストを独立させた。

- 本番設定を追加した後のAPI最終再実行も15ファイル125件成功。
- 10:17台の読み取り確認では、bitcoin_verification_attemptsは0件、Bitcoin状態はPENDING4件/NOT_REQUESTED5件。現時点の本番CONFIRMED更新は未確認。デプロイ完了をBitcoin確認完了と混同しない。
