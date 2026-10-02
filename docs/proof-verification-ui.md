# トップページ・ファイル照合・外部タイムスタンプの改善

## 表示変更

トップページの見出し・説明・補足はお客様指定の文章に変更。

- 見出し：どれが最新版？誰が承認した？をひと目で確認
- 説明：修正前と修正後のファイル、登録日時、制作担当者、変更内容を案件ごとにまとめます。納品するファイルと承認状況を確認でき、取り違えを防ぎます。
- 補足：登録したファイルと、手元のファイルが同じかも確認できます。
- 活動名：Rahab Punkaholic Girlsのボカロ楽曲制作から

制作物・Version・変更コメント・承認履歴・納品記録・ブラウザーSHA-256照合の既存実装を確認したため、指定文言は実現済み機能に沿う。ファイル本体をサーバーに保管する説明や、ファイル名だけで一致を確認する説明は加えていない。

web/srcと公開HTMLを検索し、制作活動名としてのPunkaはこのトップページの1か所のみ。アカウントのdisplay_name、OWNER情報、ユーザーID、DBキー、Passkey、旧サービスの内部識別は変更していない。

## 日時の実際の意味と本番記録

- ファイル登録日時：proofs.created_at。ファイルのSHA-256・Versionメタデータを登録した日時。
- 外部タイムスタンプ作成日時：proofs.timestamp_created_at。CalendarからOTSを受領しCreator Traceに保存した日時。同じSHA-256の既存OTSを再利用する場合、その元の日時を継承する。正確な外部サービスの発行時刻やBitcoin採掘時刻ではない。
- Bitcoin確認日時：proofs.bitcoin_confirmed_at。Bitcoin mainnetのブロックヘッダーとMerkle rootを照合し、6確認以上という既存条件を満たしたとCreator Traceで検証に成功した日時。Bitcoinブロックの採掘時刻ではない。

今回の読み取り調査で、2026-10-01T17:47:59.907Z（日本時間2026/10/02 02:47:59）に一致する本番記録を確認。外部OTSあり、Bitcoin確認日時なし、WAITING_BITCOIN/PENDINGという状態に加えTIMESTAMP_PROCESSING_FAILEDも記録されていた。保存済みOTSにはブロック969477のattestationがあるが、Creator Traceの確認済みを意味しない。BITCOIN_RPC_URLは本番のvarsにもSecret名にもなく、本番Versionの実バインディングにもないことを値を表示せず確認した。この記録は「確認待ち」だけでは説明できず、Bitcoin検証用接続設定が必要な未確認状態として扱う。

すべての証跡日時は日本時間JST（UTC+09:00）に固定し明示した。一般的な処理失敗の記録だけではネットワーク失敗とRPC不備を断定せず、保存証跡の解析と現在の設定を併せて表示する。

## 修正ファイル

- web/src/main.ts：トップ文言・活動名、日本語の証跡日時と状態説明、ファイル照合ボタン、非公開確認画面、状態ごとの再確認/OTSダウンロード/公開リンク。
- api/src/proof-view.ts（追加）：保存OTSの解析に基づく未実行・取得待ち・検証未完了・失敗・接続未設定・確認済みの分類、公開Proof IDの明示許可。
- api/src/creator.ts：公開・非公開APIの検証状態summary、公開範囲の認可、公開許可されたOTSのダウンロード。
- api/src/store.ts：PUBLIC_PROOF_IDS環境設定の型。
- api/src/timestamps.ts：作成失敗・更新取得失敗・証跡不正・RPC未設定・Bitcoin検証失敗を区別。Calendarの404は未取得、503や通信失敗は更新失敗として保持。
- api/test/proof-view.spec.ts（追加）：状態・公開範囲のテスト。
- api/test/creator.spec.ts：公開許可なしの拒否、許可されたProofだけの公開・OTSダウンロード、公開フィールドに個人情報や内部情報を含めないこと。
- api/test/operations.spec.ts：Calendar取得失敗/RPC未設定の記録を確認。
- e2e/creator.spec.ts：非公開確認画面の照合・公開拒否を検証。
- e2e/large-file.spec.ts：非公開確認画面と新ボタン/進捗表示に対応。
- e2e/proof-verification.spec.ts（追加）：ブラウザーで登録・一致/不一致・実Calendar作成/再確認・ダウンロード、スクリーンショット。
- docs/demo-files/original.wav / modified.wav：1秒の自作440Hzテスト音源と内容を変更した比較用ファイル。
- docs/screenshots/*：実演画像とOTS・検証結果JSON。
- docs/proof-verification-ui.md：本報告。

DB migrationなし。証跡・Version・承認データの上書きや物理削除なし。

## 公開範囲

調査前のAPIは、Proof IDがあればすべての証跡を匿名取得できる実装で、音楽作品だけを判別する公開フラグ・権限設定はなかった。この状態を「音楽作品だけに制限されている」と報告しない。

修正ではPUBLIC_PROOF_IDSに明示されたProofだけ匿名Verify/OTSダウンロードを許可する。案件名、ファイル名、display_nameから公開対象を推測しない。未設定・対象外は404となり、案件メンバーは認証された /proof/{id}/check から確認する。公開設定のためにDBの作品情報や所有者情報は変更しない。

公開対象のVerify URLまたはProof IDは未指定。2026/10/02、お客様の本番デプロイ依頼により公開許可なし（公開Verifyはすべて404）で反映した。案件メンバー専用の確認画面は維持。公開Verifyを利用するには、自分の音楽作品の対象Proof IDを確定してPUBLIC_PROOF_IDSへ設定する。実演用案件を公開対象へ登録せず、非公開案件も公開していない。

## ブラウザーでの再現手順（修正ビルド）

1. テスト案件を開き「新しい制作物を登録」。制作物名を入力しoriginal.wavを選んで登録する。既存の制作物は使用しない。
2. Versionの「証跡詳細」→「ファイルと証跡を確認する」。この画面は案件メンバー専用。
3. 「確認するファイル」で登録時と同じoriginal.wavを選び「ファイルを照合する」。一致する。
4. modified.wavを選び「ファイルを照合する」。不一致になる。同じファイル名に変えても内容が違えば不一致になる。ファイル本体はアップロードしない。
5. 「② 証跡のBitcoin確認」で外部タイムスタンプ作成日時、Bitcoin確認状態・日時、最終確認処理日時を読む。
6. OWNER/MANAGERで「証跡を作成 / 再確認」。処理後の状態を確認する。二度目は60秒以上あける。失敗も成功扱いのメッセージにせず、画面の状態に表示する。
7. OTSが作成されたら「OpenTimestamps証明ファイルをダウンロード」。公開許可済みの自分の音楽作品に限り「公開Verifyを開く」から匿名の照合・ダウンロードも利用できる。
8. Bitcoin未確認なら、接続設定が必要な表示の場合は運営者がBitcoin mainnetの検証用RPCを設定する。それ以外の取得待ちなら時間をおいて再確認する。外部CalendarでのBitcoin登録と、Creator TraceでのBitcoin検証は別段階。

## 検証の範囲

実ブラウザー（Firefox）で本番トップページの変更前表示と200応答、未ログイン案件APIの401を確認した。画像はproduction-homepage-before.png。本番の既存証跡の再処理・制作物登録・承認変更は行っていない。本番のログイン済みPasskeyセッションがないため、本番証跡詳細の操作実演は未実施。対象の元ファイルも提供されていないため、本番音源の一致/不一致は未検証。

修正後の操作実演は、localhostの隔離D1とテストユーザーで実施。ただしOTS作成/再確認はWorkerから実際の外部Calendarへ接続しており、ブラウザーAPIレスポンスのモックではない。Bitcoinの確認済み表示を作るための偽データや偽ブロックは使用しない。


## 実演結果（2026/10/02）

- 登録と照合：original.wav（SHA-256 b7d1ac9356fbac0369dd08100edd8999d5fa666bc39c58da7042f233203362e8）は一致。
- 不一致：modified.wav（SHA-256 2eba41a7c8fc57ff3a1345cd9eacfd7fd761b849ecdc882241138bf77574667d）。ブラウザーでは名前をoriginal.wavに揃えても不一致だった。照合操作中のPOSTリクエストは0件。
- 実OTS作成：2026/10/02 09:36:48 JST（UTC+09:00）。外部Calendarから証跡を取得。
- 実再確認：60秒以上あけて2026/10/02 09:37:47 JST（UTC+09:00）に再確認を実行。retry_count=2、元の外部タイムスタンプ作成日時は保持。
- 結果：WAITING_BITCOIN、Bitcoin確認日時なし。ダウンロードOTSの公式パーサー解析は成功し、音源のSHA-256と一致。pending attestation 1件、Bitcoin attestation 0件。
- Bitcoin確認未完了の理由：この新しいテスト証跡にはBitcoinのブロック証明がまだない。加えて、テスト環境・本番とも検証用RPC未設定。状態を偽ってCONFIRMEDにしなかった。
- 次の操作：公開対象の音楽作品Proof IDを確認し、本番の公開許可設定を準備する。Bitcoin mainnetのRPC設定後、取得待ちの証跡は時間をおいて「証跡を作成 / 再確認」。
- 不変性：再確認前後でテストVersionのSHA-256、filename、version、status、created_atが一致。制作/承認の更新操作なし。非公開テストProofの匿名Verifyは404で照合欄を表示しない。

スクリーンショット：homepage-mobile.png、file-match-mobile.png、file-mismatch-desktop.png、timestamp-result-desktop.png、timestamp-result-mobile.png。すべて修正後のローカルテスト環境の実操作画像。本番の変更前画面はproduction-homepage-before.pngで区別。

## 自動テスト結果

- 型チェック：成功。
- ビルド：Web成功、Worker dry-run成功。本番デプロイ成功。
- API：14ファイル109件成功。
- ブラウザー：全体実行で13/14成功。非公開化により大容量テストが独立APIコンテキストのCookieをブラウザーに共有していなかったため、テストをpage.requestへ修正。対象1件を再実行して成功（1GiB+1byte、照合中もUI応答維持）。最終状態で14項目の成功を確認。
- 実演用の証跡テスト：実Calendar呼び出し2回、二度目も状態を確認。固定の待機でBitcoin成功を想定せず、保存証跡を解析して未確認と判定。
- 途中のライブリロード時にworkerdのBroken pipe/Connection resetログが出たが、最終確認項目の失敗なし。

参考：OpenTimestamps公式 https://opentimestamps.org/ 、Cloudflare D1 https://developers.cloudflare.com/d1/worker-api/d1-database/ 。日時の意味・6確認条件・公開認可は、Creator Traceの実装と実際の記録を基に説明した。

最終の導線配置は既存history-actionsのflex・gap・折り返しを再利用し、PC/スマホの実演画像で確認。配置修正後の実演ブラウザテストも1件成功。

## 本番反映結果（2026/10/02）

- コマンド：`npm run build` → `npx wrangler deploy --config api/wrangler.jsonc`。
- Version ID：`41864262-2917-42cf-845a-e7c31cd25edb`。DB migrationは不要で実行していない。
- Firefoxで本番トップを開き、指定の見出し・説明・補足・制作活動名を確認。PC/スマホ画像はproduction-homepage-after-desktop.png、production-homepage-after-mobile.png。
- 配信HTML・JS・CSSが今回のビルドと一致。health 200、未ログインの案件・問い合わせ・証跡API 401、公開許可していない既存ProofのVerify/OTS API 404を確認。
- 本番のログイン済み証跡詳細操作と元ファイル照合は引き続き未検証。Bitcoin検証用RPCは未設定で、デプロイ完了とBitcoin確認完了は別。
