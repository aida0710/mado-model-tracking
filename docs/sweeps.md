# Sweep（ハイパーパラメータ探索）

Sweep は、探索空間から parameter の組を提案して試行（trial）を繰り返し、目的メトリクスが最良の試行を探す仕組みである。語は W&B の sweep config（`method`、`metric.goal`、`parameters`、`early_terminate`）に合わせる。

2026-10-08 時点では探索アルゴリズムだけを実装している。Sweep を保存・実行する API と画面は未実装で、sweeps-api が担当する。

## 探索アルゴリズム

実装は `apps/api/src/domain/sweeps/`。DB も HTTP も持たない純粋関数で、sweeps-api から呼ぶ。入口は `suggestTrial(input)` で、探索空間の検証も行う。

### 探索空間

| 定義 | 意味 |
|---|---|
| `{values: [...]}` | 値の列挙（categorical）。文字列・有限の数値・真偽値。重複不可、1000個まで |
| `{value: v}` | 定数 |
| `{distribution: 'uniform', min, max}` | 一様分布 |
| `{distribution: 'log_uniform', min, max}` | 対数が一様。min/max は値そのもの（W&B の `log_uniform_values` に当たる。W&B の `log_uniform` は指数を渡すので意味が違う）。min > 0 |
| `{distribution: 'int_uniform', min, max}` | min 以上 max 以下の整数。min/max は整数 |
| `{distribution: 'q_uniform', min, max, q}` | min から q 刻み（既定 q=1）。q はこの分布だけ |

- parameter は50個まで。違反は 422 `sweep_space_invalid` で、message に parameter 名が入る。
- grid は values / value だけで、組み合わせは10000通りまで（W&B と同じく連続分布の grid は不可）。

### method

- `grid`: parameter 名の昇順（先の名前ほどゆっくり変わる）×値の宣言順で trialIndex 番目の組。使い切ると `{exhausted: true}`。
- `random`: seed と trialIndex だけから値を決める。同じ seed・trialIndex なら同じ値。
- `bayes`: TPE（Tree-structured Parzen Estimator）。使える完了試行（failed と objective 無しを除く）が10件未満の間は random と同じ値。以後は objective の上位25%を l(x)、残り＋実行中の試行を g(x) にし、parameter ごとに l(x) から24候補を引いて l/g が最大の値を選ぶ。連続値はガウス kernel（log_uniform は対数空間）、categorical は平滑化した頻度。early_stopped の試行は打ち切り時点の objective を使う。
  - GP を採らない理由: 行列計算のライブラリが要らず外部依存なしで書けること、categorical と連続値が混ざった空間を parameter ごとの密度で扱えること。

### 目的メトリクス

- aggregation は `last`（既定。W&B の summary と同じ）/`min`/`max`。NaN・Infinity は記録が無いものとして扱い、補完しない（last が NaN なら null）。
- 最良試行は goal（minimize/maximize）で選び、同値は trialIndex の小さい方。

### 早期打ち切り（early_terminate: hyperband）

- ASHA 式の非同期 Hyperband。rung は minIter×eta^k（maxIter を指定したら maxIter 未満のもの）。eta は2以上の整数。
- 試行が達した最も高い rung で、その rung に達した試行（自分を含む）の上位 floor(n/eta) 件に入らなければ止める。比べる値は rung の step 以下で最後に記録した値。
- rung に達した試行が eta 未満なら止めない。rung の時点の値が NaN なら止めない。
- 設定の違反は 422 `sweep_early_terminate_invalid`。
