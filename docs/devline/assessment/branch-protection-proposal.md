# main のブランチ保護の提案

- 状態: **提案のみ。未適用。**
- 適用する人: **所有者だけ。** 利用者規則により、エージェントは保護設定を変更しない。FR-46 と詳細仕様書 9-4 も、保護ルールの変更を管理の対象としている。
- 確認日: 2026-10-31。

## 1. 現状（確認した事実）

| 確認                                                                   | 結果                                 |
| ---------------------------------------------------------------------- | ------------------------------------ |
| `gh api repos/Kensan196948G/Software-Factory/branches/main/protection` | 404（Branch not protected）          |
| `gh api repos/Kensan196948G/Software-Factory/rules/branches/main`      | 0 件                                 |
| `gh api repos/Kensan196948G/Software-Factory/rulesets`                 | 0 件                                 |
| main の check run                                                      | `quality`、`e2e`（どちらも success） |
| check run のアプリ                                                     | `github-actions`（ID 15368）         |
| `allow_auto_merge`                                                     | 有効                                 |

保護がないので、必須チェックなしで main へ入れる状態にある。利用者規則により、保護設定がない間は自動マージを使わない。

## 2. 提案

| 設定              | 案                                   | 理由・注意                                                                               |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Required Checks   | `quality`、`e2e`                     | 現行の job 名。workflow に path 条件がないので、全 PR で実行される                       |
| `strict`          | `true`                               | マージ前に最新の main で検証する（詳細仕様書 4-7）                                       |
| `enforce_admins`  | `true`（**所有者の決定事項**）       | 所有者も迂回できなくなる。緊急時の扱いを決めておく                                       |
| レビューの必須化  | `null`（**SC-01 の決定後に見直す**） | 所有者 1 人の場合、GitHub では自分の PR を承認できないので、1 以上にすると全 PR が止まる |
| force push / 削除 | 禁止                                 | `AGENTS.md` §2 の 4                                                                      |
| 会話の解決        | 必須                                 | `AGENTS.md` §3（未解決レビューなし）                                                     |
| `restrictions`    | `null`                               | push できる人を絞る設定。今回は使わない                                                  |

## 3. 適用コマンド（所有者が実行）

```bash
gh api --method PUT repos/Kensan196948G/Software-Factory/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "quality", "app_id": 15368 },
      { "context": "e2e", "app_id": 15368 }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

このコマンドは未実行で、構文も実機で確認していない。

## 4. 確認方法

```bash
gh api repos/Kensan196948G/Software-Factory/branches/main/protection \
  --jq '{strict: .required_status_checks.strict,
         checks: [.required_status_checks.checks[].context],
         admins: .enforce_admins.enabled,
         force: .allow_force_pushes.enabled,
         del: .allow_deletions.enabled}'
```

期待値: `strict=true`、`checks=[quality, e2e]`、`force=false`、`del=false`。

動作の確認（TC-N07 の一部）:

1. チェックが失敗する、または未実行の PR がマージできないこと。
2. `main` への直接 push が拒否されること。保護が効いていないと main に入るので、試すかどうかは所有者が判断する。

## 5. 戻し方

適用前は保護なしなので、戻す操作は削除になる。

```bash
gh api --method DELETE repos/Kensan196948G/Software-Factory/branches/main/protection
```

戻したら第 1 節の 3 つの確認を再実行し、理由と日時を記録する。必須チェックが欠けた状態になるので、戻す間は merge を止める。

## 6. 適用の影響

| 対象                   | 影響                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| 開いている PR #22〜#27 | `strict` により、順番にマージするたびに残りの PR の更新と CI の再実行が必要になる             |
| job 名の変更           | `quality` / `e2e` の名前を変えると、必須チェックが待ち続ける。CI 定義の変更時に同時更新が必要 |
| e2e の依存             | `e2e` は `quality` の成功後に実行される（`needs`）。`quality` が失敗すると `e2e` は通らない   |
| 同時実行の取り消し     | `cancel-in-progress` により、新しい push で前の実行が止まる。最新の実行が結果になる           |
| 自動マージ             | 必須チェックができるので、利用者規則の前提の一部が満たされる。SC-01 の決定までは merge 保留   |

## 7. 関連する残作業

- `.github/CODEOWNERS` がない（NFR-06 の専用のコード所有者設定）。
- CI のセキュリティ段階は secret scan のみ。組織方針 §5 が求める「security scan を含む」とみなせるかは未確認。
- 適用を 9-4 の変更として記録する先が未定（FR-46 は未実装）。
