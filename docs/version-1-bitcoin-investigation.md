# Version 1 Bitcoin証跡調査（2026-10-02）

## 1. 実際の停止点

本番D1をSELECTし、保存済みOTSをローカルで解析した。Version 1には有効なPending OTSがあり、SHA-256がVersionとProofで一致している。OTSにBitcoin attestationがなく、指定されたAlice Calendarの`GET /timestamp/{OTS内のpending.message}`がHTTP 404を返した。このためBitcoin APIのblock-height lookupには到達していない。Bitcoin API全体の障害でも、旧Versionを除外する条件でもない。

404はCalendarがこのcommitmentの証跡を返していないことを示す。公式実装も`CommitmentNotFoundError`として扱う: https://github.com/opentimestamps/python-opentimestamps/blob/master/opentimestamps/calendar.py 。公開待ちかCalendar側の保持・公開問題かは404だけでは断定できず、確認済みに強制変更しない。

Version 1のTimestampは2026-10-02 11:46:47 JST、Version 2は同日02:47:59 JST。Version番号は1のほうが古いが、OTS作成は1のほうが約9時間後だった。Version 2のBitcoin情報をVersion 1に転用できない。

## 2. Version / Proof 比較

|項目|Version 1|Version 2|
|---|---|---|
|asset_version.id|3dbd40c7-0ae2-4573-a96f-a4eba4f4ea93|6b1d19e7-3cf6-4d9a-a03c-eee780d30fbd|
|version|1|2|
|asset_version.sha256|c8e2e71bf16c3601fa009ce3088df8a36343ec666a81cc0bbb6c5e00af8fa004|212e160bd1a97ef18d8a75a0deb5a4f41a5b87a3d41e5417c59353c98aa4faa8|
|proof.id|6d43416b-24cc-4a07-849a-cc8ea51d8a90|4765f964-898d-414a-be8d-a24a393ebb88|
|proof.asset_version_id|3dbd40c7-0ae2-4573-a96f-a4eba4f4ea93|6b1d19e7-3cf6-4d9a-a03c-eee780d30fbd|
|proof.sha256|Version 1のsha256と完全一致|Version 2のsha256と完全一致|
|OTS保存先|D1 proofs.ots_proof（base64）|D1 proofs.ots_proof（base64）|
|R2 key|なし（OTS処理にR2は使っていない）|なし|
|timestamp_created_at UTC|2026-10-02T02:46:47.385Z|2026-10-01T17:47:59.907Z|
|bitcoin_status|PENDING（検証状態WAITING_BITCOIN）|CONFIRMED|
|bitcoin_block_height|null|969477|
|bitcoin_block_hash|null|000000000000000000016fa7af55cec7db322c8b6702bfe9695d7d892a454a0b|
|bitcoin_block_time UTC|null|2026-10-01T18:35:46.000Z|
|last_checked_at UTC（調査SELECT時）|2026-10-02T04:01:15.796Z|2026-10-02T04:00:02.268Z|
|failure_stage|null|null|
|OTS実バイト長|221|1187|
|OTS対象hash一致 / 解析成功|true / true|true / true|
|Pending attestation|1（Alice）|1（Alice）|
|Bitcoin attestation|0|1（969477）|

## 3. 最新Version参照とupgrade経路

`operations.ts`はURLのproofIdから`proofs → asset_versions → assets`をJOINし、権限確認後その同じproofIdを`processProof`に渡す。`timestamps.ts`の処理・保存・attempt・auditはこのproofIdで限定される。`MAX(version)`や`ORDER BY version DESC`は一覧表示用に存在するが、Bitcoin再確認の対象選択には使われない。Version番号・FINALでupgradeを除外する条件もない。

再確認は既存OTSをparseし、OTSに保存された許可済みCalendarのpending.messageに対してupgrade GETする。Bitcoin attestationが返れば元Pending分岐を残してOTSに追記し、Bitcoin mainnetとの照合を行い、成功時だけ同じProofへCONFIRMEDとブロック情報を保存する。元timestamp_created_at、SHA-256、Proof IDは維持する。Calendar 404はWAITING_BITCOIN、対象hash不一致はINVALID_OTS/OTS_PARSE。既存OTSの再確認では`POST /digest`は行わない。

## 4. 修正ファイルと診断

- `api/src/timestamps.ts`: 選択Proofのasset_version_idでVersionを取得し、Version.sha256・Proof.sha256・OTS対象hashの整合性を検証する。安全な`BITCOIN_RECHECK_START`（proof_id/asset_version_id/version）、`OTS_LOAD`（D1/r2_key:null/存在）、`OTS_PARSE`（有効性/attestation数）、`OTS_UPGRADE`（許可済みCalendar/200・404/結果）を追加。既存の`BITCOIN_VERIFY_START`・成功/失敗ログに続く。OTS本体・commitment・Cookie・token・APIキー・生のエラーメッセージはログに出さない。
- `api/test/operations.spec.ts`: Version 2を先にCONFIRMEDにし、Version 1がFINALかつPendingの状態から再確認する回帰テストへ強化。Version 1自身のOTSがupgradeされCONFIRMEDになり、Version 2全行・Version 1のファイル行・SHA-256・Proof ID・元Timestamp作成日時が不変であることを検証する。Version 2の再確認でもVersion 1全行が不変。hashを変更できないDB triggerと、別hashのOTSに対するINVALID_OTSも検証する。
- `docs/version-1-bitcoin-investigation.md`: 本報告。

## 5. 本番upgrade / Bitcoin結果

Version 1の既存OTSを読み取り専用で取得・解析し、Calendar upgrade GETを試した結果は404。アップグレードされたBitcoin attestationやblock heightは取得できなかった。Version 1をCONFIRMEDとする実証はまだできていない。新しいProof・Timestampは作っておらず、本番データを直接更新していない。

Version 2の保存済みOTSはBitcoin高さ969477を含み、DBのhash/time/statusも上記のとおりCONFIRMED。Version 1との共有・転用はしない。

## 6. デプロイと手動確認

検証結果: API全16ファイル146テスト成功、`npm run typecheck`成功、`npm run build`成功。調査完了時点では未デプロイだったが、その後ユーザーの指示で本番へ反映した（下記）。直前のUI/Version処理デプロイ（Version ID `3a2d3a3a-c576-43d9-a5e3-58995617f9eb`）とは区別する。

新しいDB migrationは不要。保護triggerを変更・解除しない。

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --config api/wrangler.jsonc
```

1. OWNER/MANAGERでログインし、Version 1の画面から「Bitcoinを再確認」を押す。
2. NetworkタブでPOST先が`/api/proofs/6d43416b-24cc-4a07-849a-cc8ea51d8a90/bitcoin-recheck`であることを確認する。
3. Calendar 404時は`ok:true, verificationStatus:WAITING_BITCOIN, blockHeight:null`。ログは同じproof_id・version:1、OTS_LOAD:D1成功、OTS_UPGRADE:pending/404。Bitcoin API lookupはまだ発生しない。
4. CalendarがBitcoin attestationを返すようになった後は同じボタンで再確認する。upgrade/Bitcoin照合が成功すればCONFIRMEDと高さ・hash・blockTimeが表示される。元作成日時は11:46:47 JSTのまま。
5. Version 2のProof ID/SHA-256/OTS日時/Bitcoin情報が変わっていないことを確認する。Version 2からの再確認先は`/api/proofs/4765f964-898d-414a-be8d-a24a393ebb88/bitcoin-recheck`。
6. 手動再確認は60秒以上の間隔を空ける。自動再確認対象はProof単位で、Cronは毎時17分。

## 本番デプロイ結果（2026-10-02）

- `npx wrangler deploy --config api/wrangler.jsonc` 成功。
- Version ID: `74039291-730f-44ae-b6c5-5babcb560db1`。
- URL: https://creator-trace-api.punkaproof.workers.dev
- 反映後のトップページと`/api/health`はHTTP 200、未ログインの案件APIはHTTP 401を確認。
- 新規migration適用・既存データ削除・手動の本番Bitcoin再確認は行っていない。Cronは毎時17分を維持。
