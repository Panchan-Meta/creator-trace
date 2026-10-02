# 招待ユーザーのPasskey登録・ログイン

## 原因と修正

調査したソースでは、新規登録はすでに SimpleWebAuthn の startRegistration()（navigator.credentials.create）を利用しており、get() を呼ぶ不具合は確認できなかった。登録オプションにも authenticatorAttachment: platform の固定はなかった。

一方、未認証の招待画面で登録・ログインの説明が曖昧で、招待からログインへ進んだ場合も通常の「無料で試す」へ誘導する説明を表示していた。ログイン処理は保存済みPasskeyを取得するため、新規利用者がそちらへ進むと報告された症状と整合する。実際のWindowsダイアログ発生原因は実機での確認が必要。

招待専用の登録案内・ログインから招待専用登録へ戻るリンクを追加。新規登録は登録検証の後、同じ操作で招待を受諾し、対象案件へ移動する。既存ユーザーはログイン後に表示名を確認して受諾する。

## 変更ファイル

- web/src/main.ts：招待専用案内、登録後の自動受諾、案件への遷移・完了表示。受諾だけ失敗した場合、画面上の再試行は登録を繰り返さず受諾を再試行する。再読み込み後も認証済みなら招待確認画面へ進む。
- api/src/auth.ts：登録時のスマホ・PC・セキュリティキーのヒント、登録開始・検証時の招待状態再確認。
- api/test/passkey.spec.ts：必須登録オプションと登録途中の期限切れ・使用済み・取消を検証。
- e2e/authenticator.ts：create/getと渡された登録設定をテスト用に記録。
- e2e/navigation-invites.spec.ts：create一回、get不使用、新規登録・自動参加、既存ユーザーget、招待コンテキスト、再利用拒否の確認。
- e2e/reviewer-comments.spec.ts：新しい登録後の直接遷移に対応。
- docs/invite-passkey.md：報告・手動確認。

## APIとコンテキスト

既存APIの分離を維持する。新API・DB migrationは不要。

1. POST /api/auth/invite-signup：表示名とtokenを検証し、登録準備。
2. POST /api/auth/passkey/register/options → startRegistration() → credentials.create()。
3. POST /api/auth/passkey/register/verify：署名・RP・Origin・本人確認を検証し、Passkey登録とセッション発行。
4. POST /api/project-invites/accept：同じtokenで参加。ACTIVE membershipへ追加し、招待をACCEPTEDにする既存のトランザクション・監査記録を使用。
5. /projects/{id}?joined=1へ遷移し、参加完了を表示。

ログインは POST /api/auth/passkey/login/options → startAuthentication() → credentials.get() → POST /api/auth/passkey/login/verify。ログイン後 /invite/{token}へ戻り受諾する。

招待コンテキストはURLと登録準備用HttpOnly Cookie、そのhashを参照するinvite_enrollments、サーバーのchallengeで保持する。localStorageは使わない。既存設計ではusersの準備レコードは登録準備APIで作成されるが、Passkey登録・認証セッション・案件参加は検証成功後のみ有効になる。この順序は維持し、既存ユーザーとPasskeyを変更しない。登録と受諾は別APIで、途中失敗しても案件の自動新規作成は行わない。

登録は residentKey=required / userVerification=required、authenticatorAttachment未指定。hints=['hybrid','client-device','security-key']は選択の優先順を示すだけで端末を制限しない。スマホQRの選択肢・保存の可否はブラウザ/OS/認証器の対応に依存する。

## 手動確認

1. OWNERがCREATOR招待を作成。未ログインのWindows Chrome/EdgeでURLを開く。
2. 「初めての利用：Passkey登録」から表示名を入力。「最初の案件名」が出ないことを確認。
3. 「Passkeyを登録して参加する」を押し、新規Passkey作成の操作になることを確認。
4. 「iPhone、iPad、またはAndroidデバイス」を選択。Bluetoothを有効にした近くの対応スマホでQRを読み取り、新しいPasskeyの保存と本人確認を行う。
5. 対象案件へ移動し、参加完了・表示名・CREATOR Roleを確認。OWNER側で参加済み表示を確認。
6. ログアウト後、別の有効な招待で「登録済み：ログイン」。登録済みPasskeyでログインし、表示名確認後受諾する。
7. 期限切れ・使用済みリンクでは登録/受諾できないことを確認。
8. 開発者ツールの通信で register と login がそれぞれ専用APIを使うことを確認。秘密tokenやCookieを公開しない。

Windowsと実スマホによるQR保存はこの開発環境では未検証。自動テストはソフトウェア認証器による実署名・Worker側の実検証で行う。

実装検証時点では本番変更を行わなかった。下記の本番反映は、その後のお客様の明示的な指示を受けて実施した。

## 自動テスト結果

- npm run typecheck：成功。
- npm test：13ファイル、100テスト成功。
- npm run build：Webビルド、Worker dry-run成功。本番デプロイなし。
- npm run test:e2e -- e2e/navigation-invites.spec.ts e2e/reviewer-comments.spec.ts e2e/signup.spec.ts：8テスト成功。
- 新規招待の実署名登録はcreate一回/getなし、既存ユーザーログインはget一回を確認。登録設定、context保持、ACTIVE参加、ACCEPTED更新、使用済み拒否、別案件の勝手な新規作成なしを検証。
- 登録途中の期限切れ/使用済み/取消はregister/options・register/verifyで拒否し、Passkeyが保存されないことを検証。
- Workerライブリロードに伴うBroken pipeログが一部出たが、テスト失敗はなし。


## 本番反映（2026/10/02）

お客様指定の順序で、DBバックアップ → migration 0017適用 → npm run build → npx wrangler deploy --config api/wrangler.jsonc を実施。

- バックアップ：/tmp/creator-trace-before-0017-20261002-cex43c89/production.sql（306767 bytes、権限600、親ディレクトリ700）。SQLiteへ読み込み確認済み。
- バックアップSHA-256：0372479f2daedea6a979808287e32e41fe99547f3be4dc4aa1f9b950ad2d754f。
- migration：0017_asset_versions_approval.sqlのみ、成功。既存の未適用migrationなし。
- Version ID：d5190c37-eaaf-4e73-ba10-7a668bcaf413。
- 本番：https://creator-trace-api.punkaproof.workers.dev。
- 反映前後のSQLを比較し、旧カラムで既存行が完全一致することを確認。users5、Passkey4、members8、assets6、versions9、state history16、approvals5、deliveries2、proofs9、audit105、invites6、review comments1、bot runs10、bot messages35。
- Versionカウンタが各制作物の最大Version+1であること、PunkaのADMINを保持していることを確認。
- Windows＋実スマホのQR登録は引き続き手動確認対象。本番の招待・登録・参加データを検証目的で作成していない。
- 本番スモーク確認：招待登録ページHTML・JS・CSSが今回のビルドと一致。/api/healthは200、未認証の案件一覧・問い合わせ・登録optionsは401。
