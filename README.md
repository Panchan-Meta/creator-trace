# Creator Trace

制作物・外注納品・版管理・証跡管理システム。小規模制作チームが、案件ごとの制作物と修正履歴を管理するBtoBサービスです。

「そのファイル、いつ納品されたか証明できますか？」

Cloudflare Workers + D1 + Vite / TypeScript。ファイル本体は送信・保存せず、ブラウザでSHA-256を計算してメタデータを登録します。原本はDrive / Dropbox / GitHub等で保管してください。

案件、制作物、版履歴、提出・承認・差戻し・FINAL、納品受領、案件メンバー招待、OTS、公開Verify、APIキー、監査ログに対応します。ファイルのSHA-256はブラウザWorkerで分割計算します。登録日時・Timestamp作成日時・Bitcoin確認日時は区別します。Bitcoin Confirmedには管理するmainnet RPCの設定が必要です。

初回利用は `/signup` でPasskeyを登録して開始できます。復旧に備えて `/settings/security` で別端末のPasskeyも追加してください。導入相談は `/business`。

## ローカル起動

```bash
npm ci
npm ci --prefix api
npm ci --prefix web
npm run setup:local
npm run build
npm run migrate:local
npm run account:create
npm run dev -- --port 8787 --var APP_ORIGIN:http://localhost:8787 --var RP_ID:localhost
```

`http://localhost:8787/setup` を開き、作成されたユーザーIDと `api/.dev.vars` の `OPERATOR_TOKEN` を入力します。認証設定へ移動後、パスキーを追加してください。初回設定のセッションは1時間、通常のPasskeyログインは24時間で期限切れになります。秘密値はURLへ含めず、共有・コミットしないでください。既存ユーザー・既存Passkeyも引き続き利用できます。

## 検証

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

E2EはFirefoxと独立したローカルD1を利用します。ブラウザが未インストールの場合は `npx playwright install firefox` を実行してください。旧修了証のテストは `.disabled` として隔離しています。

## 詳細

追加機能、DB、API、デプロイ、実ファイル手動テスト、未実装項目は [Phase2・Phase3実装報告](docs/creator-trace-phase2-3.md) を参照してください。旧資産は [整理計画](docs/legacy-cleanup-plan.md) に分類し保持しています。以前の [Phase1報告](docs/creator-trace-phase1.md) も保持します。

旧修了証API、招待による受取、MCP、内部証明書運用APIはHTTP 410で停止しています。旧テーブル・旧ソース・旧運用スクリプトは保持用です。旧READMEは `docs/legacy/certificate-service.md` に隔離し、旧コマンドはルートpackage.jsonから除外しました。
