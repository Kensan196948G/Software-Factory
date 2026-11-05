# 運用保証 第 2 ラウンドの実測記録（2026-11-05）

作成: 2026-11-05 JST。`15-ops-assurance-plan-20261105.md` の N2〜N5・N10 の証跡である。

- 本書の数値は **Lead（AI）が 2026-11-05 に実測した値を転記したもの**である。本書の作成者は新たな実測をしておらず、設定ファイルも読んでいない。
- **実測は保証ではない**。RPO・RTO の値は、その時点・その条件での観測値であり、将来の達成を約束しない（目標値の確定は Q-12、所有者確認待ち）。

## 1. 本番 release

| 項目                 | 結果                              |
| -------------------- | --------------------------------- |
| 日時                 | 2026-11-05 20:09 JST（11:09:42Z） |
| commit               | `8d578ca` → `9d821e2`             |
| exact-main CI ゲート | OK（run 42013453147 attempt 1）   |
| 事前バックアップ     | 成功、`offsite=1`（R2 送信済み）  |
| migration            | なし                              |
| 切替後の `/healthz`  | commit 一致                       |

## 2. RPO 実測（N2）

`pnpm ops:rpo-report`（`scripts/ops/rpo-report.mjs`）、`--since 2026-11-04T08:00:00Z`、2026-11-05 19:22 JST 時点。

| 項目                         | 結果      |
| ---------------------------- | --------- |
| 終了コード                   | 0         |
| ローカル dump の最大間隔     | 55:01.271 |
| R2 送信記録の最大間隔        | 55:47.509 |
| 60 分を超えた間隔            | 0 件      |
| healthcheck の totalFailures | 0         |

この期間に RPO 60 分からの逸脱は観測されなかった（実測であり保証ではない）。

## 3. 失敗通知（N3・N10）

- `OnFailure` のテンプレート（`deploy/systemd/mirai-sf-onfailure@.service`）を `~/.config/systemd/user` に配置した。適用先は、本番の healthcheck・backup・restore-drill と、Staging の healthcheck・autofollow。
- 変更前の unit は `/tmp/unit-bak-20261105b` に退避した。
- 2026-11-05 19:48 JST に e2e 試験を実施した。必ず失敗する一時 unit（`/bin/false`）を起動すると、`alerts.jsonl`（`~/.local/state/mirai-sf/`）に `unit=…e2e-onfailure-test.service`・`result=exit-code` の 1 行が記録された。ファイルの権限は 0600。
- **外部通知先は未設定**（`notify.env` なし。所有者の判断待ち）。現状は、ホスト上のファイルへ記録されるだけで、人へは届かない。

## 4. 全体 RTO 訓練（N4・N10）

`pnpm ops:prod:rto-drill`（`scripts/ops/rto-drill.sh`）を 2026-11-05 19:49 JST に実行した。本番は停止していない。

- 結果: `result=ok`。合計 **40.8 秒**（目標 30 分以内）。一時 DB は残っていない。レポートは保存済み。

| detect | decide | fetch（R2） | restore | verify | api  | switch_decision | cleanup |
| ------ | ------ | ----------- | ------- | ------ | ---- | --------------- | ------- |
| 0.07   | 0.17   | 7.40        | 0.79    | 30.60  | 1.12 | 0.01            | 0.63    |

（単位: 秒）注意（この値に含まれないもの・条件）:

- detect は訓練開始の宣言時刻であり、実際の障害を検知するまでの時間ではない。
- 本番の切替そのもの、DNS・Access の操作は含まない。
- 人の判断にかかる時間は含まない。
- DB は小規模（request 0 件）。データが増えれば restore と verify は長くなる。

## 5. 独立復旧訓練（N5・N10）

`scripts/ops/offsite-recover.mjs --source guess` を 2026-11-05 19:23 JST に実行した。

- ローカルの送信記録を使わず、R2 だけから `mirai_sf_prod-20261105T094024Z.dump` を特定して取得した。
- 一時 DB へ復元し、28 テーブルの件数照合と監査ハッシュ連鎖（9 件）の照合が OK だった。その後、一時 DB を削除した。
- 所要時間は 59 秒。
- 読取り専用トークンを使う `--source list` は、トークンが未発行のため実行していない。
- **同じホストで実施したもので、別ホストでの実証ではない**。ホストごと失われた場合、Tunnel の資格情報・wrangler の OAuth・`prod.conf` も一緒に失われるという課題は残っている（`14-independent-dr.md`）。

## 6. 残課題（本書で解消したと主張しないもの）

| 課題                     | 状態                                                          |
| ------------------------ | ------------------------------------------------------------- |
| 外部通知先               | 未設定。所有者の Y/N 待ち                                     |
| R2 保持規則              | 未適用。所有者の数字選択待ち（`13-r2-retention-plan.md`）     |
| 資格情報 rotation        | 未実施。所有者の Y/N 待ち（`12-credential-rotation-plan.md`） |
| Sandbox の main 保護     | 未設定（N8）。所有者の設定待ち                                |
| 別ホストでの DR 実証     | 未実施                                                        |
| 業務受入（ケース S / B） | 未実施のまま運用中（Q2=3、ADR §8.2）                          |
