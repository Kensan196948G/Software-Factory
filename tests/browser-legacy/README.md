# 旧画面の合成 UI 試験（退避）

`src/web/index.html` と `src/web/public/{bridge,console}.js` を横取りして動かす合成 UI 試験です。
2026-11-11 のステーション画面への置き換えで DOM が変わったため、そのままでは通りません。

- アクセシビリティ: `tests/e2e/station-a11y.spec.ts`（実サーバ・実データで主要画面と狭い画面を検査）
- 承認者 UI・利用者管理・一覧絞り込みの回帰: 新しい画面の管理機能を移した後に、
  `tests/e2e/station.spec.ts` へ追加する（`docs/design/station-ui.md` §6）。
