# 2026-11-04 配備後再確認と検証境界

## 状態と目的

2026-11-04 18:39 JST 時点を基準に、現在配備されている `8a1ee9931e5838234a4f5da86f5e598f7d95100a` と未配備PRを区別する。healthz成功だけを主要業務の受入完了とは扱わない。

## 確認済み

- GitHub main CI run `41801003971` は同SHAで `completed/success`。ローカルmain作業ツリーはclean。
- Staging（8782）・本番（8783）の `/healthz` はともに同SHA、`status=ok`、`db.ok=true`、正しいenvironmentを返した。
- 両API unitはactive、`NRestarts=0`。本番の最終起動は17:40:43 JST、Stagingは17:38:36 JST。
- 18:35 JSTのStaging/本番healthcheckは `Result=success` / `ExecMainStatus=0`。
- 公開URL `https://sf-prod.mirai-dx-platform.com/` の未認証応答は302。これはAccess認証後の操作確認ではない。
- 両環境の配信 `console.js` / `bridge.js` を固定releaseの `dist/web` とバイト比較し、一致した。
  - console SHA-256: `ef2ebde10b88e0afb05d2b666671e4f9eaa06bba36b4bb3e9ec43617924f8b2c`
  - bridge SHA-256: `765a3d1f08be1e66d96e49ee6f809a99d28687c5d7287c4079b918aa97d7492f`
- 18:39:47〜18:39:49 JSTのローカルGET再測定（5回/環境）は両方5/5成功。Staging p95=68.276ms、本番p95=10.776ms。短時間・少数サンプルであり月間可用性や負荷性能の証拠ではない。
- 本番バックアップunitの最終完了は17:55:21 JST、success/0。最新dumpの観測鮮度は44.7分（18:39時点）。R2送信記録の存在だけでは、全世代が継続して復元可能である保証にはならない。

## CIへの検査組込み

PR #86 の管理UI回帰は、専用の `playwright.approver.config.ts` では検出されるが、必須e2eジョブが使う `tests/e2e` に読み込み口が無かった。本変更で `tests/e2e/admin-users.spec.ts` を追加し、既存の承認者/a11yと同じ方式で必須e2eから同じspecを読み込む。workflowや保護規則は変更しない。

- 専用configで管理UI回帰9件成功（DB・実サーバを使わず全通信を横取り）。
- 通常configの `--list` でも同じ9件を検出した。
- typecheck（3構成）とlint成功。
- CI実行・マージの成否はPR上の同一headの結果を正本とする。本書作成時点では未確認。

## 未完了・訂正事項

1. **PR #87 は未マージ・未配備**。初期head `00cfd01` の独立レビューで、5,000件超の空ページ、サーバだけにある依頼の詳細が開けない問題、既存行の古い状態/決定色の再利用を検出した。修正・回帰試験・再レビュー・exact-head CI成功前にはマージしない。
2. 「55分バックアップにしたのでRPO1時間を厳守・保証」とする過去の報告は強すぎた。55分は起動間隔の設定であり、復元可能なsnapshotの鮮度、処理完了、R2送信失敗、ホスト停止まで含むRPO保証ではない。
3. 約31〜32秒の復元訓練は一時DBへの復元/照合の所要であり、検知から本番受付再開までのRTOではない。実人間2名によるAccess OTP後の別人承認・注文書受入も未完了。
4. 資格情報は一度ツール出力に現れており、非露出だったとの旧文言を訂正する。値の再表示は禁止。発行/失効/rotationやuser manager環境の一括変更は所有者確認まで行わない。
5. 他repoの検査はreadiness診断であり接続完了ではない。artifact名の存在をv2の内容検証とは扱わず、Sandboxの保護未整備やDispatcherの契約未確定を解消したとは宣言しない。
6. R2の保持期限による削除、Accessサービストークン発行、production secret変更は未承認のまま保留する。

## 影響とロールバック

本変更は検証用specの読み込み口と文書のみ。schema・認証・権限・本番データ・サービス設定・公開範囲は変更しない。取消は本PRのsquash commitをrevertする。稼働releaseの再配備は不要。
