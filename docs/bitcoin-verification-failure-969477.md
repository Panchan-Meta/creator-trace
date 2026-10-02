# Bitcoin検証失敗969477の調査・修正（2026-10-02）

## 1. 実際の失敗原因

本番D1の最新検証履歴には、対象高さ969477でESPLORA / VERIFY_FAILED / BITCOIN_API_UNAVAILABLEが繰り返し保存されていた。既存コードはHTTPエラーとfetch例外をこのコードへ集約しており、履歴にHTTP statusや失敗段階はなかった。

本番と同じcompatibility_date=2026-09-29、nodejs_compatの一時Cloudflare Workersリモートプレビューで、既存fetchオプションを再現した。`redirect: 'error'`を指定すると以下のTypeErrorが発生する。

```text
Invalid redirect value, must be one of "follow" or "manual"
```

通信より前に例外が発生するため、最初のmainnet確認 `/block-height/0` で止まり、`/block-height/969477`には進まない。969477はOTSから取得済みであり、チェーンAPIからの取得成功を表していなかった。cache指定の有無でも同じ例外を再現し、`redirect: 'manual'`への変更だけで両URLのHTTP 200を確認した。RPCにも同じredirect指定があったため修正した。3xxは追従せず失敗扱いにする。

既存テストはfetchをモックしており、このWorkers固有の制約を検出できなかった。修正後はモック内でもネイティブRequestを構築し、Workersで有効なオプションか確認する。

参考: [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)。manualでは3xxをそのまま返す。公式ドキュメントの型一覧にはerrorも載るため、今回の未対応判定はリモートWorkers実測に基づく。

## 2–3. 使用API・URL・応答形式

本番Version a0d76c92-1a97-4bfb-8327-7dcd3dc59e83のbindingも確認し、`BITCOIN_API_BASE_URL=https://blockstream.info/api`だった。Blockstream Esplora REST APIを使用し、mainnet genesis hashとの一致を必須にする。testnetではない。

base URLは `https://blockstream.info/api`。各アンカーの全検証を通して15,000ms（15秒）のAbortSignalを共有する。各リクエストに15秒ずつ与える方式ではない。応答サイズ上限16KiB、最大2アンカー、redirect=manual、cache=no-store。

| 順序 | 実際のrequest path（base URLに連結） | 応答形式・確認内容 |
| --- | --- | --- |
| 1 | `/block-height/0` | plain text、mainnet genesis hash |
| 2 | `/block-height/969477` | plain text、64文字の16進block hash |
| 3 | `/block/{hash}/header` | plain text、160文字の16進ヘッダー。二重SHA-256とMerkle rootを検証 |
| 4 | `/block/{hash}` | JSON、id / height / merkle_root / timestamp。ヘッダーと比較 |
| 5 | `/block/{hash}/status` | JSON、in_best_chain=trueを要求 |
| 6 | `/blocks/tip/height` | plain text、整数。6確認以上を要求 |
| 7 | `/block-height/969477` | plain text、再取得してreorgを検出 |

仕様: [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md)。HTTP status、形式、チェーンの一致をそれぞれ確認する。HTTP 200だけでCONFIRMEDにしない。

## 4. block height取得元

`api/src/proof.ts`の`parseReceipt`が、保存済みOTSのBitcoin attestation（tag `0588960d73d71901`）の可変長整数から969477を取得する。OTS操作を適用した32byteの結果を反転し、BitcoinのMerkle rootとして比較する。標準OTSのこのattestationにはblock hashとblock timeは含まれない。解析処理自体は今回変更していない。

## 5–6. block hash・block time取得と実データ検証

修正後の`verifyBitcoinChain`をリモートWorkersプレビューから実行し、本番D1の対象証跡をSELECTだけで読み取ってOTSを解析した。`processProof`は実行せず、本番Proofや検証履歴は更新していない。

検証結果:

```json
{
  "height": 969477,
  "hash": "000000000000000000016fa7af55cec7db322c8b6702bfe9695d7d892a454a0b",
  "blockTime": "2026-10-01T18:35:46.000Z",
  "confirmations": 43,
  "provider": "ESPLORA"
}
```

hashは `/block-height/969477` の応答から取得。block timeは `/block/{hash}` のtimestamp（Unix秒）をUTC ISO 8601へ変換し、80byteヘッダーのoffset 68の時刻との一致も確認する。日本時間は2026-10-02 03:35:46。Creator Traceの初回検証成功時刻はDB保存時の別の値であり、採掘日時を代入しない。全7リクエストとOTS Merkle root検証が成功した。診断用プレビューは終了済み。

## 7. 修正ファイル・動作

- `api/src/bitcoin.ts`: REST/RPCのredirect修正、failureStage/httpStatus、HTTP 429・network・timeoutの区別、安全な構造化ログ、RPC時刻の必須検証。
- `api/src/timestamps.ts`: 検証結果を戻り値で返す。成功時だけCONFIRMEDとブロック情報を保存し、失敗時はOTS upgrade候補で元のOTSを上書きしない。既存確認済み証跡は保持し、最新結果を履歴に追記する。
- `api/src/operations.ts`: bitcoin-recheckで `{ok:true,...outcome}` を返す。HTTP成功と検証成功を分ける。
- `api/src/proof-view.ts`: 新エラーを安全な一覧へ追加し、最新attemptのfailure_stage/error_type/http_statusを公開する。
- `migrations/0019_bitcoin_failure_details.sql`: attemptにfailure_stage/error_type/http_statusを追加。既存履歴のUPDATE/DELETE禁止を維持する。
- `api/test/bitcoin.spec.ts`、`api/test/operations.spec.ts`: 取得・保存・失敗・再確認の回帰テスト。
- 本書。

ログは `BITCOIN_VERIFY_START`、`BITCOIN_BLOCK_HASH_LOOKUP`、`BITCOIN_BLOCK_INFO_LOOKUP`、`BITCOIN_VERIFY_SUCCESS` / `BITCOIN_VERIFY_FAILED`。proof_id、block_height、HTTP status、成功/失敗、failure_stage、error_typeだけを記録する。URL、Authorization、API key、token、Cookie、upstream本文、例外messageを出力しない。成功ログはDB保存後に出る。

内部エラーコードはBLOCK_HASH_LOOKUP_FAILED、BLOCK_INFO_LOOKUP_FAILED、BLOCK_MISMATCH、NETWORK_ERROR、TIMEOUT、RATE_LIMIT、INVALID_OTS、VERIFY_FAILEDを区別する。既存のwrong network、canonical不一致、確認数不足、設定不正などの詳細コードも維持する。failureStageでNETWORK_CHECK、BLOCK_HASH_LOOKUP、BLOCK_HEADER_LOOKUP、BLOCK_INFO_LOOKUP、CANONICAL_CHECK、CONFIRMATIONS_CHECK、REORG_CHECK、OTS_PARSEなどを区別する。失敗が複数アンカーにまたがる場合、レスポンスの高さと段階は最後に失敗したアンカーのもの。

recheckは、成功時にverificationStatus=CONFIRMED、blockHeight、blockHash、blockTime、confirmedAtを返す。検証失敗時はHTTP 200 / ok=trueとverificationStatus=VERIFY_FAILED、blockHeight、failureStage、errorCodeを返す。アンカー待ちやAPI未設定はWAITING_BITCOIN / OTS_CREATED / BITCOIN_ANCHOR_FOUND。権限不足・未ログイン・lease/cooldown・OTS未作成は従来のHTTPエラーを維持する。

失敗時はSHA-256、保存済みOTS、timestamp_created_at、過去のブロック情報、初回確認日時を削除しない。過去にCONFIRMEDならその状態も維持する。最新失敗は新しいattemptとAudit Logへ追記する。

## 8. 自動テスト結果

- API全体: 15ファイル136件成功。その後、Calendar upgrade成功後のBitcoin失敗でも元OTSを保持するテスト1件を追加し、operations.spec.ts全18件が成功。合計137件を検証。
- 型チェック: API本体・APIテスト・Web・E2E成功。最終追加後もAPI型チェック成功。
- ビルド: WebおよびWorker dry-run成功。
- 追加/更新対象: hash取得成功（969477）、hash API 404 / 429 / 302、hash段階のnetwork error / timeout、block info取得成功 / 404 / 不正JSON、block time取得 / 不正値、block mismatch、CONFIRMEDのDB保存とレスポンス、既存OTS保持、確認済み後の失敗でも元記録保持、不正OTS、秘密を含む例外messageがログに出ないこと。
- モック以外の検証: 上記の本番OTS + リモートWorkers + 実Blockstream APIの読み取り専用成功。

## 9. 本番デプロイ手順

今回、本番migration適用と本番デプロイは実施していない。0019を先に適用し、その後Workerをデプロイする。新Workerは0019の列を使用するため、順序を逆にしない。base URLやbinding変更は不要。

リポジトリルートから:

```sh
backup_dir=$(mktemp -d /tmp/creator-trace-before-0019-XXXXXX)
chmod 0700 "$backup_dir"
npx wrangler d1 export creator-trace-db --remote --config api/wrangler.jsonc --output "$backup_dir/production.sql"
chmod 0600 "$backup_dir/production.sql"
npx wrangler d1 migrations list creator-trace-db --remote --config api/wrangler.jsonc
```

未適用が0019だけであることを確認して:

```sh
npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc
npm run typecheck
npm test
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

0019は追加列だけなので、旧Workerへロールバックする際にmigrationを削除する必要はない。確認済み証跡の保護triggerを解除しない。

## 10. 本番再確認手順

1. `npx wrangler tail --config api/wrangler.jsonc --format json`を開始する。
2. OWNER/MANAGERとしてログインし、969477が表示される証跡詳細で「Bitcoinを再確認」を実行する。前回実行から60秒以内なら待ってから再試行する。
3. NetworkパネルでPOST `/api/proofs/{proofId}/bitcoin-recheck`のHTTP statusとJSONを別々に確認する。verificationStatus=CONFIRMED、blockHeight=969477、上記hash、blockTime=2026-10-01T18:35:46.000Z、Creator TraceのconfirmedAtが返ること。
4. ログでSTART → HASH_LOOKUP（200/true）→ INFO_LOOKUP（200/true）→ SUCCESSを確認する。失敗した場合はfailureStage/errorCodeと最新attemptのhttp_statusを見る。
5. 再描画後のGET `/api/proofs/{proofId}`でbitcoin_status=CONFIRMEDとブロック情報を確認する。timestamp_created_atとSHA-256は以前と同じ、今回のアンカー付きOTSも保持されること。bitcoin_confirmed_atは採掘日時とは別の初回検証成功時刻。
6. 最新履歴にはBITCOIN_VERIFIEDが追記され、過去のVERIFY_FAILED履歴も残ることを確認する。

本番におけるCONFIRMED保存の確認は、上記の反映と再確認後に行う。今回の読み取り専用成功と本番DBの更新を区別する。

## 本番デプロイ結果（2026-10-02、ユーザー承認後）

- 本番DBバックアップ: `/tmp/creator-trace-before-0019-wpj6u3vq/production.sql`。ディレクトリ0700、ファイル0600。SHA-256: `2f5e7e2cc0dac6613eb718e7fdf6e3d857fb4c2dd947e019e227845b62fbb017`。
- 未適用が0019だけであることを確認し、0019を適用成功。適用後の未適用migrationなし、failure_stage / error_type / http_status列の存在を確認。
- Worker本番デプロイ成功。Version: `0744cfdb-da42-45b5-ab65-98c3bc6e7603`。
- 配信先: `https://creator-trace-api.punkaproof.workers.dev`。トップページHTTP 200。未ログインbitcoin-recheck POSTはHTTP 401を維持。
- API接続先はBlockstream mainnetのまま、Cronは毎時17分。
- デプロイ後の対象Proof（4765f964-898d-414a-be8d-a24a393ebb88）は、まだ前回のFAILED / BITCOIN_API_UNAVAILABLEが保存されていた。デプロイ自体は既存Proofの再確認を実行しない。
- ログイン済み本番セッションがないため、認証済みrecheck APIの実行と本番CONFIRMED保存は未確認。OWNER/MANAGERの再確認ボタン、または次回以降のCronで再検証する。修正後の実Blockstream + 本番OTSの読み取り専用検証は上記のとおり成功済み。
