# Creator Trace 本番Bitcoin接続設定確認

確認日時：2026-10-03T07:49:06+09:00（日本時間）

## 結論

本番には **BITCOIN_API_BASE_URLが設定されています**。値は **https://blockstream.info/api** です。

**BITCOIN_RPC_URLは未設定**です。現在の本番Bitcoin確認はBlockstreamのEsplora HTTP APIを使用し、Bitcoin Core RPCを使用しません。

| 設定名 | 本番での有無 | 本番設定値 | 種別 |
|---|---|---|---|
| BITCOIN_API_BASE_URL | 設定あり | `https://blockstream.info/api` | Worker環境変数（plain_text） |
| BITCOIN_RPC_URL | 設定なし | 値なし（Worker binding自体が存在しない） | 未設定 |

## 確認対象・根拠

- アプリURL： https://creator-trace-api.punkaproof.workers.dev
- Worker名：`creator-trace-api`
- 現在の本番稼働Version：`6fa6b6d6-d5bb-43ec-8235-277788e5789b`
- 本番への割当：100%（`wrangler deployments list`で確認）。
- `wrangler versions view`で、そのVersionに保存された実際のbindingsを取得し、上記2設定を確認しました。ローカル設定ファイルだけから推測した結果ではありません。
- `api/wrangler.jsonc:45`にも同じAPI URLが定義されています。

確認に使用したコマンド：

```sh
npx wrangler deployments list --config api/wrangler.jsonc
npx wrangler versions view 6fa6b6d6-d5bb-43ec-8235-277788e5789b --config api/wrangler.jsonc --json
```

Version情報には他の設定名も含まれるため、この文書にはBitcoinの2項目だけを記載しています。秘密情報・token・Cookie・RPC認証情報は記載していません。

## コード上の使用方法

`api/src/bitcoin.ts`の`bitcoinConfigured()`は、API URLまたはRPC URLのどちらかがあれば接続設定ありと判定します。

`verifyBitcoinChain()`では、**BITCOIN_API_BASE_URLを優先**します。両方が設定されていてもAPI経路を使用します。API経路の失敗時にRPCへ自動切替する実装ではありません。API URLがない場合にRPC経路を使用します。

現在の本番では以下のGETを実行するコードです。

| 段階 | リクエストURL形式 | 応答 |
|---|---|---|
| mainnet確認 | `https://blockstream.info/api/block-height/0` | Genesis block hashのテキスト |
| block hash取得 | `https://blockstream.info/api/block-height/{blockHeight}` | block hashのテキスト |
| block header取得 | `https://blockstream.info/api/block/{blockHash}/header` | 80バイトheaderの16進テキスト |
| block情報・時刻取得 | `https://blockstream.info/api/block/{blockHash}` | JSON（id、height、timestamp、merkle_root） |
| 正規チェーン確認 | `https://blockstream.info/api/block/{blockHash}/status` | JSON（in_best_chain） |
| confirmation数確認 | `https://blockstream.info/api/blocks/tip/height` | tip heightのテキスト |
| reorg再確認 | `https://blockstream.info/api/block-height/{blockHeight}` | block hashのテキスト |

例：height 969477のhash取得URLは `https://blockstream.info/api/block-height/969477` です。この文書作成では当該blockの取得・Bitcoin再確認は実行していません。

- ネットワーク：mainnetを前提とし、Genesis hashで照合します。
- timeout：`AbortSignal.timeout(15000)`、15秒。1回のverify処理内で各fetchが同じsignalを共有します。
- block time：JSONの`timestamp`（Unix秒）をISO日時に変換します。
- 本番の保存先provider表記：`ESPLORA`。

## 今回の作業範囲

本番設定の読み取りと文書作成だけです。環境変数・Secret・DB・認証・Bitcoin処理・本番Deployには変更を加えていません。設定の存在は確認しましたが、外部APIへの全検証リクエストが成功することを確認する疎通テストではありません。
