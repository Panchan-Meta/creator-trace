# Creator Trace：提示文章と現行ソースの照合

確認日：2026年10月3日

対象コミット：`cc9dc11f2428e3ada473570c5a0a28d02f2b6382`（略称 `cc9dc11`）

照合時の現行HEADも同じコミット。作業ツリーに変更はなく、`api/src/timestamps.ts`、`bitcoin.ts`、`proof.ts`、migrationについてコミットとの差分もなかった。以下の行番号はこの時点のソースを指す。

## 結論

**提示文章は、一部は一致するが、全体としては現行ソースと一致しない。**

「このファイルにBitcoinへ直接書き込む処理がない」「その時点に存在したと証明する、という断言文がない」は一致する。しかし、「カレンダーへ出して、あとからattestationを探す、まで」は、attestation取得後のBitcoin照合と結果保存を省いているため一致しない。

`proofs`のDELETE拒否は実装されているが、記述場所は`timestamps.ts`ではなくDB migrationである。提示されていない草案に何を残しているかは、この調査では確認できない。

## 対象文章

> cc9dc11のtimestamps.tsには、このアプリがBitcoinへアンカーする処理も、その時点に存在したと証明する文もありません。カレンダーへ出して、あとからattestationを探す、までです。草案に残しているのは、proofsのDELETEを拒否する、という読めた一文だけです。

依頼文には同じ文章が2回あるため、重複を除いて1回分を照合した。

## 主張ごとの判定

| 主張 | 判定 | ソースから確認できたこと |
| --- | --- | --- |
| このアプリがBitcoinへアンカーする処理がない | 条件付きで一致 | 「このファイル自身がBitcoinへトランザクションを送信する処理がない」という意味なら一致。既存アンカーの検証がない、という意味なら不一致。 |
| その時点に存在したと証明する文がない | 一致（文言について） | `timestamps.ts`にその断言文は見当たらない。ただし、文がないことと、Bitcoin検証処理がないことは別である。 |
| カレンダーへ出す | 一致 | `/digest`へコミットメントをPOSTし、OTSを保存する処理がある。 |
| あとからattestationを探す | 一致 | 既存OTSのPending情報から`/timestamp/{message}`を取得し、OTSをupgradeしてBitcoin attestationを解析する。 |
| attestationを探す「まで」 | 不一致 | 取得後に`verifyBitcoinChain()`を呼び、成功時にCONFIRMEDとブロック情報を保存する。 |
| proofsのDELETEを拒否する | 一致（migrationについて） | `0005_creator_trace.sql`のDBトリガーがDELETEを拒否する。`timestamps.ts`の記述ではない。 |
| 草案にその一文だけ残している | 判定不可 | 草案本文が提供されていないため、内容や編集方針は確認できない。 |

## 根拠1：カレンダーへの提出とOTS upgrade

`api/src/timestamps.ts:11`の`calendar()`は、bodyがある場合はPOST、ない場合はGETで外部カレンダーへアクセスする。

同ファイルの63〜70行では、VersionのSHA-256と乱数nonceからコミットメントを作成し、カレンダーの`/digest`へ提出してOTSを保存する。

```ts
for(const uri of calendars){try{tree=await calendar(`${uri}/digest`,commitment);break;}catch{}}
```

`upgradeReceipt()`（19〜37行）は、既存OTSのPending URIとmessageからカレンダーの`/timestamp/{message}`を取得し、得られたtreeを組み込んで再解析する。既にBitcoin attestationがあれば、そのOTSを利用する。

この部分について、提示文の「カレンダーへ出して、あとからattestationを探す」は概ね一致する。ただし、OTSには対象hashの検査もあり、単に文字列としてattestationを探しているわけではない。`api/src/proof.ts:15`で対象SHA-256を照合し、22行でBitcoin attestationから高さとMerkle rootを取り出す。

## 根拠2：attestation取得後にも処理が続く

`api/src/timestamps.ts:77`で`verifyAndRecord()`を呼んでいる。同関数の110〜119行は、以下を区別する。

1. Bitcoin attestationがない：`WAITING_BITCOIN`または`OTS_CREATED`を記録。
2. attestationはあるがBitcoin接続設定がない：`BITCOIN_ANCHOR_FOUND`を記録。
3. attestationと接続設定がある：`verifyBitcoinChain()`で照合。
4. 照合成功：成功結果を保存。照合失敗：失敗結果を保存。

特に116〜117行には次の呼び出しがある。

```ts
try{result=await verifyBitcoinChain(anchor,env,proofId);}catch(error){failure=error instanceof BitcoinError?error:new BitcoinError('VERIFY_FAILED','検証に失敗しました');failedHeight=anchor.height;continue;}
return recordVerification(env,proofId,actor,'BITCOIN_VERIFIED',result,null,immutable,null,null,receipt);
```

したがって「attestationを探すまで」という処理範囲の説明は不正確である。

## 根拠3：Bitcoinとの照合と成功結果の保存

呼び出し先の`api/src/bitcoin.ts:28`に`verifyBitcoinChain()`の実装がある。Esplora経路では、49〜70行でmainnetのgenesis、高さに対応するブロックhash、ブロックヘッダー、Merkle root、ブロック時刻、best chain所属、6確認以上、読み取り中の高さ/hashの再一致を確認する。

ヘッダーの二重SHA-256とOTS由来のMerkle rootはローカルで照合する。canonical chain所属はAPIの応答を使用する。26〜27行のコメントどおり、アプリがBitcoinチェーン全体を独立検証する実装ではない。RPC経路も別途ある。

`timestamps.ts:100`では、初回成功時に以下を保存する。

- `proof_status / timestamp_status / bitcoin_status = CONFIRMED`
- `bitcoin_verification_state = BITCOIN_VERIFIED`
- Bitcoinブロックの高さ、hash、時刻
- `bitcoin_confirmed_at`（Creator Traceが検証に成功した日時）

既にCONFIRMEDの証跡を再確認する場合は、元の成功情報を上書きせず検証試行を記録する。

なお、`timestamp_created_at`はOTSを保存した日時、`bitcoin_confirmed_at`はアプリの検証成功日時、`bitcoin_block_time`は取得・照合したブロック時刻である。これらを同じ日時として扱う記述にはなっていない。UI側も`web/src/main.ts:49`で区別を説明している。

## 根拠4：proofsのDELETE拒否の所在

`migrations/0005_creator_trace.sql:12`に次の定義がある。

```sql
CREATE TRIGGER creator_proof_no_delete BEFORE DELETE ON proofs BEGIN SELECT RAISE(ABORT,'proof history is permanent'); END;
```

したがって、「このトリガーが適用されたDBでは、proofsへのDELETEが拒否される」はソースに沿った説明である。Bitcoinへの書き込みや外部証跡検証とは別の、DB内の履歴保護である。この定義だけから、DB管理者によるトリガー削除やDB全体の置換まで不可能とはいえない。

旧テーブル`timestamp_proofs`にもDELETE拒否があるが（`0002_punka_proof.sql:62`）、今回の`proofs`の根拠は上記0005であり、両者を混同しない。

## ソースに沿った文章への修正案

> cc9dc11のtimestamps.tsには、Bitcoinへの直接書き込み処理や、「その時点に存在した」と断言する文はありません。同ファイルは、カレンダーへの提出と既存OTSのupgradeに加え、取得したBitcoin attestationをbitcoin.tsの検証処理へ渡し、照合結果を記録します。初回検証に成功した場合は、CONFIRMEDとブロックの高さ・hash・時刻を保存します。proofsのDELETE拒否は、timestamps.tsではなく、0005_creator_trace.sqlのDBトリガーに記述されています。

草案に何を残すかという編集方針を述べたい場合は、このソース上の事実と別の文にする。「草案にはDELETE拒否だけを記載する」という方針自体は、Bitcoin検証処理がソースに存在しないことの根拠にはならない。

## 調査範囲

コミットと現行ソースの静的照合であり、個別Proofの本番検証成功や、外部カレンダーの内部実装を再検証した報告ではない。特定の日時にどの対象が存在したといえるかの判断は、ここで確認した文言の有無・処理範囲と分けて扱う。

アプリ、API、DB、本番環境には変更を加えていない。作成したのはこの照合文書と配布用PDFのみ。
