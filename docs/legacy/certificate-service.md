# Punka Proof / Creator Trace

Punka Proofは個人・小規模講座運営者向けの、譲渡不能な修了証・受講証明書の発行代行MVPです。受講者はウォレット・暗号資産を使いません。QR/公開Verifyで証明書の状態を確認し、Passkeyで本人の一覧・詳細を閲覧します。正式発行と失効の最終判断は人間のPunkaが行います。

## 既存構成の調査結果

既存コードはnpm、`api/`のCloudflare Workers初期テンプレート、`web/`のVite/TypeScript初期テンプレート、`migrations/0001_init.sql`のusers/certificates/timestamp_proofsでした。`src/`・`functions/`・`worker/`、Passkey/SHA-256/OpenTimestamps/Verifyの既存業務実装、README、Vite設定ファイルはありません。`apps/`・`packages/`は空のディレクトリです。ルートwrangler.jsoncにD1/R2の既存bindingがありました。稼働中のPages設定・本番データ・既存Cloudflareアカウントの状態は変更していません。

既存のusersを受講者、timestamp_proofsを証明履歴として再利用し、certificatesは追加columnで拡張します。旧Creator Trace行には公開IDやPunka状態を付与せず、旧データを残します。

## Architecture

```text
内部CLI → Bearer認証API → ProofService → D1
                    ↓
       Bot検査 → Complianceのチェック項目 → Punka承認
                    ↓
       一括transactionで修了証・証明payload・監査・outboxを作成
                    ↓
       Python OTS processor → 公開calendar（hash commitmentのみ）
                    ↓
       Bitcoin mainnet full node → OTSとMerkle rootの検証
                    ↓
       Workerでも証拠を照合 → R2にOTS → confirmed / ACTIVE

Firefox → 同一originのWorker Assets/Vite画面 → 公開Verify / Passkey / My Certificates
```

`api/src/domain.ts`はCSV・hash・canonical payload、`service.ts`はDBと業務処理、`auth.ts`は認証、`proof.ts`はOTS解析とBitcoin RPC検証、`index.ts`はHTTP/認可を担当します。UI化は同じserviceを呼び出す形で拡張できます。本MVPではWorkers Static AssetsでUI/APIを同一originに配信します。Pagesを別originに配置する場合は同一originのAPI proxyを用意してください。CORSの無条件許可はありません。

D1 transactionとパラメーターbindingの仕様は[Cloudflare D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/)に基づきます。CSVの上限はUTF-8 1MB・50データ行です。最悪時の発行query数を抑えるためのMVP上限で、本番はWorkers Paidを前提とします（[D1 query limits](https://developers.cloudflare.com/d1/platform/limits/)）。

## CSV仕様と発行フロー

```csv
name,email,course,completed_at
山田太郎,taro@example.com,Python基礎講座,2026-09-30
```

ヘッダはこの4列のみ（順序変更可）。UTF-8/BOM、LF/CRLF、引用符付きのカンマを扱います。name最大100文字、email最大254文字、course最大200文字、修了日は実在するYYYY-MM-DDです。必須項目・email・不正な制御文字・列数・空行・同一email/講座の重複を検査します。最終改行だけは無視します。メールは小文字、講座名はNFCに正規化します。人の同一性はMVPでは講座運営者が確認したemailで識別します。

CSVの元バイト列（APIではUTF-8文字列）をSHA-256化し`source_hash`をUNIQUEで保存。ファイル名を変えた同一CSVは409。改行等を変えた再投入は受講者/講座UNIQUEとvalidationで防ぎます。同一issuer/email/courseの再発行は失効済みでも拒否します。新しい講座期を別証明書とする場合は別course名で登録してください。

1. 内部operatorがCSVを登録（UPLOADED）。構文不正CSVは400で拒否。
2. BotがVALIDATINGを経て検査。全行正常ならREADY_FOR_APPROVAL、一行でも不正ならFAILED。部分発行はしません。
3. 白石 律の役割として同意・個人情報・発行条件を確認した結果をPunkaへ提示。
4. Punkaが自分の専用認証secretでapproveし、同意・PII・発行条件の3項目をtrueとして記録（APPROVED）。Botのoperator secretでは承認できません。
5. Punkaが専用認証secretでissue。DBの条件付き更新でISSUINGを取得し、全証明書・proof・outbox・監査を一括transactionで作成（COMPLETED）。発行途中の失敗はrollbackしFAILED。同じCOMPLETED Batchへのissueは既存レポートを返します。
6. Batchレポートの証明書ID/状態と、outboxのVerify・登録URLを取得。
7. OTS processorを定期実行し確認状態を更新。発行レポートCOMPLETEDとBitcoin確認完了は別です。

承認・却下・証明の状態変化はDB triggerで監査ログも同じtransactionに記録します。実行途中にプロセスが強制停止しVALIDATING/ISSUINGで残った場合は、監査と証明書有無を調査したうえでPunka管理下で復旧してください。自動的な承認や未承認の再発行はありません。

## 権限とBotの責任

| 担当 | 責任 |
|---|---|
| 橘 司 | PM / Workflow Coordinator。CSVから完了までの進行 |
| 真田 蓮 | Engineering。データ変換・hash・証明書生成・証明処理 |
| 御堂 玲 | Security。重複・入力・認証・アクセス制御の確認 |
| 白石 律 | Compliance。同意・PII・発行/失効条件の確認支援。法的判断は行わない |
| 水城 澪 | Customer。outbox・通知・Verify導線 |
| 神谷 蒼 | Marketing。MVP対象外 |
| 黒田 | Finance。課金はMVP対象外 |
| Punka | Human Final Approver。発行・失効・重大なPII/契約/法的判断の最終権限 |

これは業務上の責任分離です。自律AIによる正式発行・失効・法的判断は実装しません。PUNKA_APPROVAL_TOKENはPunka本人のみに渡し、内部operatorとGrok Botの認証は分離してください。Grok Botには対応するMCP専用tokenだけを渡してください。MVPの内部認証は専用secretで本人権限を表します（複数管理者用の管理UI/企業SSOは対象外）。PROOF_VERIFIER_TOKENも分離した証明processor専用です。承認APIに文字列Punkaを送るだけでは承認できません。

## Passkey・本人向け画面

`/login`、`/my-certificates`、`/my-certificates/:certificateId`。

発行outbox内の受講者専用招待URL（7日有効、256-bit random）から、本人の端末で同意のうえ登録します。招待はメール等で正しい本人へ届ける必要があり、Verify URLを知るだけでは登録できません。登録tokenはURL fragmentに含め、画面表示時にfragmentを消去します。招待tokenのhash・受講者・期限・消費日時をD1に保存し、credential登録とtoken消費をtransaction化、UNIQUEとtriggerで再使用を拒否します。

[SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server)の検証ライブラリを使用。RP ID/origin/challenge/署名/user verificationを検証し、discoverable Passkeyを使用します。チャレンジは5分有効、検証前にDELETE RETURNINGで一回だけ消費。sessionはrandom tokenのhashを保存し24時間有効。HttpOnly/SameSite=Strict、HTTPS本番ではSecure。Passkeyは認証手段でありBlockchainアドレスではありません。

本人向けAPIはsessionのrecipient_idでDB検索を制限。存在する他人のIDも404。公開Verifyでは氏名・email・credential・非公開document・失効理由を返しません。失効理由は内部だけに保存します。紛失時の本人確認/招待再発行は手動運用で、未確認の第三者へ発行しないでください。

## Verify・QR・Certificate status

`/verify/:certificateId`はログイン不要。ID、発行者、講座名、修了/発行日、証明書状態、OTS状態、document hash、DBでの最終状態確認日時を表示します。大きいbadgeと文字/記号で状態を区別します。

| DB状態 | 表示 |
|---|---|
| PENDING | ! PENDING / 証明処理を確認中です |
| ACTIVE | ✓ VALID / この修了証は有効です |
| REVOKED | × REVOKED / この修了証は失効しています |

QRはブラウザ内で生成し、内容はAPP_ORIGIN上のVerify URLだけです。氏名/email等は入れません。公開証明書IDはUUID v4で推測困難。受講者・講座情報を推測困難なIDからだけ公開します。

## Document hash・Blockchain / OpenTimestamps

private documentはcertificateId、recipientId、氏名/emailのスナップショット、issuerId、courseId/講座名、completedAt、issuedAtとランダムsaltの固定順JSONで、そのSHA-256をdocument_hashにします。document_json/saltはD1だけに保持し、内部監査でhashを再計算できます。saltを含むため氏名/emailからの辞書攻撃はできません。MVPのdocumentはこのデジタル証明書データで、PDFファイル生成やPDFアップロード照合は対象外です。

public canonical JSONは以下の6項目のみ。辞書順のkey、UTF-8、余分な空白なし。

```json
{"certificateId":"...","courseId":"...","documentHash":"...","issuedAt":"...","issuerId":"...","status":"ACTIVE"}
```

SHA-256をpayload_hashとして保存。元CSV/source_hash/氏名/email/credential/住所/電話/生年月日は公開calendarやBlockchainに送りません。Python OTS clientはpayload hashにnonceを付けてSHA-256したcommitmentをcalendarへ送信します。calendarは無料のtimestamp処理で、ウォレット・トークン・暗号資産決済は不要です。

proofは`pending / confirmed / failed`。calendarからpending receiptが返ってもconfirmedとは扱いません。receiptはR2に保持し、定期実行でupgradeします。Bitcoin mainnetの自分が信頼するfull nodeが必要です。PythonでOTSの操作を検証し、WorkerもOTSの対象hash・操作経路・Bitcoin attestationとRPCのmainnet genesis/ブロックMerkle root/6 confirmationsを照合した後だけconfirmedにし、PENDING証明書をACTIVEにします。RPC未設定ならpendingのままです。失敗時はfailed、再実行可能、証明書は消しません。Worker parserは標準SHA-256/SHA-1/RIPEMD160/append/prepend/reverse/hex操作を扱い、未対応操作は安全に拒否します。

本番WorkerからRPCへは認証付きHTTPS接続可能な信頼するread-only RPCを設定してください。ローカルのみlocalhostのHTTP RPC可。RPCの秘密情報をログ出力しません。Bitcoin確認待ちは即時完了ではありません。ネットワーク確認前のVALID表示用の裏口は設けていません。

失効はPunka専用revokeで即時REVOKEDにし、新しいstatus=REVOKEDのcanonical payload/proofを追加します。最初のACTIVE proofを上書きしません。失効証明がpendingでもVerifyの証明書表示はREVOKEDです。古いACTIVE proofが後からconfirmedになってもREVOKEDをACTIVEに戻しません。証明書・proof・監査のDELETEと失効の取り消し、受講者の変更はDB triggerで禁止します。

## Notification outbox

D1 notificationsにrecipient、type、certificate、Verify URL、Passkey登録URLとPENDING/SENT/FAILEDを保存。外部メールproviderの設定は不要です。`ops outbox`はPIIをconsoleに出さず、指定の新規ファイルへ0600で書き出します。これは開発用file providerで、配信済みとは扱いません。本人に通知を届けた後に`notification-sent`でSENTへ変更します。本番ではproviderがoutboxを取得して配信し、成功/失敗を内部APIへ返す運用にできます。

## DB migration

`0002_punka_proof.sql`は非破壊・追加型。既存のcertificateを一括削除/書き換えしません。

- users: email（部分UNIQUE）、consent_at。
- issuers、courses（issuer/name UNIQUE）。usersがrecipientsに相当。
- issuance_batches: source hash UNIQUE、状態・各count・Punka承認・Compliance結果。
- issuance_rows: CSV行/エラー。
- certificates: 公開UUID、issuer/course/recipient/batch FK、各日時・状態・document hash/private JSON・失効理由。recipient/course UNIQUE、公開ID UNIQUE。
- timestamp_proofs: canonical payload/hash/status、エラーを追加。certificate/state UNIQUE、R2 receipt、確認ブロック/日時。certificate_proofsに相当。
- audit_logs、notifications、enrollment_tokens、webauthn_credentials、auth_challenges、sessions、rate_limits。
- 各ID/email/hash/status/created_atと主要FKにINDEX、所有者変更/物理削除/失効解除禁止、証明payload・certificate document・監査の不変性trigger。

```bash
npm run migrate:local
# 適用履歴の確認（ローカル）
npx wrangler d1 migrations list creator-trace-db --local --config api/wrangler.jsonc
```

ルートwrangler.jsoncは既存設定を残しています。APIのbinding設定の基準はapi/wrangler.jsoncです。以前にルート設定で作成したローカルDBを引き続き使う場合は`--persist-to`を同じディレクトリに明示して、適用済みmigrationを確認してください。remote migrationは本番バックアップとreview後に手動で実行します。

## Local development（Ubuntu）

Node.js 22以上、npm、Python 3.10以上/python3-venvを使用。

```bash
cd /home/projects/creator-trace
npm install
npm install --prefix api
npm install --prefix web
npm run setup:local
npm run build
npm run migrate:local
npm run dev
```

Firefoxで `http://localhost:8787` を開きます。PasskeyとRP IDのためlocalhostを使用します。Vite単独の5173はAPI proxy未設定のため、通常はWorkerからbuild済みUIを確認してください。UI変更後に`npm run build --prefix web`を実行。開発用secretはapi/.dev.varsに0600で作成されます（git除外）。本番でこの開発secretを使わないでください。

別ターミナルで内部CLIを使用します。開発環境ではPunka本人がapprove/revokeを実行することを確認してください。

```bash
cd /home/projects/creator-trace
set -a
. api/.dev.vars
set +a
export PUNKA_API_URL=http://localhost:8787
export PUNKA_ISSUER_ID=3e1a51bc-5dc3-4e59-bac6-985a05668532
# 同じ運営者は同じissuer IDを使う
npm run ops -- import examples/completions.csv 'Punka Academy'
# 出力されたBatch IDを設定
export BATCH_ID='出力されたBatch ID'
npm run ops -- validate "$BATCH_ID"
npm run ops -- status "$BATCH_ID"
# Punka本人が内容・同意・PII・発行条件を確認した後だけ実行
npm run ops -- approve "$BATCH_ID" --compliance-reviewed
npm run ops -- issue "$BATCH_ID"
npm run ops -- outbox outbox-local.json
npm run ops -- audit
```

status/issueのJSONが発行完了レポートです。rejectedも監査に残ります。

```bash
npm run ops -- reject "$BATCH_ID"
# 発行済み証明書のIDを設定し、Punkaが失効条件を確認後
export CERTIFICATE_ID='出力されたCertificate ID'
npm run ops -- revoke "$CERTIFICATE_ID" '発行条件の訂正'
```

### OTS processor

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
# 同じAPI secretを使用（本番では証明processorにverifier secretだけを渡す）
export BITCOIN_RPC_URL='http://rpcuser:rpcpassword@localhost:8332'
# Workerのapi/.dev.varsにも同じ信頼するRPCのBITCOIN_RPC_URLを追加して再起動
npm run proofs
```

Bitcoin RPC未設定でもOTS送信/receipt保存は動きますがconfirmed/ACTIVEにはしません。`npm run proofs`を定期実行してください。full nodeの認証情報は専用read-only接続に限定し、shell履歴や共有ログに残さないでください。実際のmainnet確認時間まで待つ必要があります。

## API

すべてJSON、失敗は`{ "error": "..." }`。内部操作はBearer secret、ブラウザ認証は同一origin cookie。

| Endpoint | 権限 |
|---|---|
| GET /api/health | public |
| POST /api/issuance-batches | operator（filename/csv/issuer） |
| GET /api/issuance-batches/:id | operator |
| POST /api/issuance-batches/:id/validate | operator |
| POST /api/issuance-batches/:id/approve | Punka（approver/consentConfirmed/issuanceConditionsConfirmed/piiReviewed） |
| POST /api/issuance-batches/:id/reject | Punka |
| POST /api/issuance-batches/:id/issue | Punka、承認済み限定 |
| GET /api/certificates/:certificateId | operator（非公開情報を含む） |
| POST /api/certificates/:certificateId/revoke | Punka（approver/reason/revocationConditionsConfirmed） |
| GET /api/verify/:certificateId | public、PIIを返さない |
| GET /api/my/certificates | session本人 |
| GET /api/my/certificates/:certificateId | session本人 |
| POST /api/auth/passkey/register/options | 正当な招待、consent=true |
| POST /api/auth/passkey/register/verify | challenge cookie、response |
| POST /api/auth/passkey/login/options | public |
| POST /api/auth/passkey/login/verify | challenge cookie、response |
| POST /api/auth/logout | same-origin |
| GET /api/auth/session | public、現在のsession状態 |
| GET /api/internal/audit-logs | operator、最新200件 |
| GET /api/internal/notifications | operator、PENDING最大100件、PIIあり |
| POST /api/internal/notifications/:id | operator、status=SENT/FAILED |
| GET /api/internal/proofs | verifier、未確認最大100件 |
| GET /api/internal/proofs/:id/receipt | verifier、OTS binary |
| POST /api/internal/proofs/:id | verifier、status/receipt/bitcoinBlock |

## Security

Zod validation、SQLパラメーターbinding、DOM textContentによる表示（受講者データをinnerHTMLに挿入しない）、CSP、no-store/no-referrer/nosniff、HTTPS本番Secure cookieとHSTS。状態変更のcookie APIはOriginを厳密検査。request originとAPP_ORIGIN/RP_IDの不一致は拒否。本番でlocalhost設定を残した場合は動作せず設定修正が必要です。

rate limitingはD1 fixed-windowで実装（認証30/分、その他API240/分、hash化した接続元と経路種別）。更なる本番対策はCloudflare WAF等で拡張可能。ログ/監査metadataへ氏名/email/招待tokenを記録しません。outbox/private証明書は権限付き内部APIのみ。受講者同士の取得不可、証明書譲渡APIなし。監査履歴は失効後も保持。

## Tests / build

```bash
npm run typecheck
npm test
npm run build
```

既存lint scriptはありません。Worker内の実D1/R2（ローカルテストbinding）でCSV、二重投入、承認前後、公開ID UNIQUE、PII非公開、本人認可、失効/履歴保護、proof failure/pending、Bitcoin RPC照合（mock）、実署名Passkey登録/login/session/logout・challenge再利用禁止をテストします。型生成は`npm run cf-typegen --prefix api`。

Firefox手動確認:

1. 上記CLIでCSV登録→validation→Punka承認→issue。IDを控えます。approve前のissueが拒否されることも確認。
2. `/verify/ID`で! PENDING、発行者・講座・hash・QRを確認。QRはVerify URLだけ。ネットワークレスポンスにもemail/氏名がないことを確認。
3. outbox-local.jsonの自分のregistration_urlをFirefoxで開き、同意→端末またはセキュリティキーでPasskey登録。Ubuntu Firefoxでは対応するFIDO2キーやスマートフォン連携等が必要です。
4. `/my-certificates`→詳細→公開Verifyへ移動。ログアウト後`/login`からPasskeyで再ログイン。別受講者のIDを本人APIへ送ると404。
5. OTS processorを繰り返し実行。信頼するBitcoin full nodeで確認完了後のみVerifyが✓ VALID / confirmedになることを確認。
6. Punkaがrevokeを実行して公開Verifyを再読込。× REVOKED、失効proofは確認前ならpending、元のACTIVE proofは履歴に残ります。

## Production deployment

本実装作業では本番deploy/remote migration/メール送信を実行しません。

1. D1/R2 bindingの既存ID/バケット、Workers Paid、データバックアップを確認。
2. api/wrangler.jsoncのAPP_ORIGINを実際のHTTPS origin、RP_IDをそのhostnameに設定。設定変更後typegen/typecheck/test/build。
3. `npx wrangler secret put OPERATOR_TOKEN --config api/wrangler.jsonc`、同様にPUNKA_APPROVAL_TOKEN・PROOF_VERIFIER_TOKEN・BITCOIN_RPC_URLを別secretとして設定。secretは役割別に共有範囲を分離。
4. review後`npx wrangler d1 migrations apply creator-trace-db --remote --config api/wrangler.jsonc`。
5. `npm run deploy --prefix api`。UI/API同一origin・HTTPS・RP設定とアクセス制御を検証。
6. 証明processorにverifier secretとmainnet RPCを設定し定期実行。provider未導入の場合outboxを安全な内部運用で本人へ届けます。

対象外: NFT/トークン/暗号資産決済/売買/DeFi/DAO/譲渡、フル管理画面、課金・AI分析、PDF生成、本番メールprovider、Passkey紛失の自動本人確認、企業SSO。本番Bitcoin確認と実端末Passkeyの手動確認は各環境で必要です。

### Firefox E2E自動テスト

```bash
npx playwright install firefox
npm run test:e2e
```

専用のe2e/wrangler.jsonc・8791ポート・毎回新規の/tmpローカルDB/R2を使い、通常の開発DB/本番DBには触れません。CSV→検査→Punka承認→発行→Verify、登録→logout→Passkey login→本人一覧→詳細→Verify、失効→再読込をFirefoxで実行します。Passkeyはテストだけでnavigator.credentialsに挿入する実署名ソフトウェア認証器です。物理セキュリティキーやOS生体認証の動作確認は手動で実施してください。ACTIVE badgeのFirefox表示だけはレスポンスfixture、サーバーのACTIVE遷移はBitcoin RPCをmockしたD1テストで確認します。実mainnet確認済みの発行成功を偽装する仕組みは製品にはありません。

OTS processorのオフラインテストは`npm run test:proofs`で実行します。実calendarのreceiptとのhash一致、RPC未設定時のpending保持、PIIのない送信body、改ざんpayloadの拒否を検査します。実calendarに公開の架空payloadを送信して保存したfixtureを使うため、通常の自動テストは外部calendarへ再送信しません。QRはFirefoxのcanvasから復号してVerify URLとの一致を検査し、公開データのXSS表示も確認します。

## Grok Bot Remote MCP

追加した5人のBot連携・Secret設定・疎通確認・権限一覧は[docs/grok-mcp.md](docs/grok-mcp.md)を参照。承認・正式発行・失効はPunka専用。旧説明のoperatorによるissueは現在403となり、ops issueにはPUNKA_APPROVAL_TOKENが必要です。
