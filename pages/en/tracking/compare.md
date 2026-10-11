---
title: Compare Runs
description: Compare selected Runs side by side, see differences from a baseline Run, and analyze results with parallel coordinates, parameter importance, and scatter plots.
---

# Compare Runs

![The comparison page with differences from the baseline below each cell](/images/tracking-compare.png)

The comparison page lines up the params, metrics, and tags of the selected Runs in one table. When you choose a baseline Run, each metric shows its difference from the baseline. The 分析 (Analysis) tab uses parallel coordinates, parameter importance, and scatter plots to show which params affected the result.

## When it helps

- Checking in numbers how much each metric improved across three Runs that differ only in learning rate
- Seeing which model version and evaluation dataset version each evaluation Run used
- Finding the params that matter among 30 Sweep trials

## Open the comparison page

1. Under **Experiments**, select the Runs to compare. Runs from different Experiments can be selected under すべての実験 (all experiments)
2. A selection bar such as "2 runs · 選択中" appears above the table; choose 比較 (Compare)

You can compare 2 to 50 Runs. The page URL contains the selected Runs and the baseline, so you can share it as is.

| Tab | Content |
| --- | --- |
| 詳細 (Details) | The comparison table and metric charts of the selected Runs |
| Artifacts | Artifacts with the same path in every Run, side by side |
| Media | Per-step audio and images ([Media Logging and Listening](/en/tracking/media#compare-runs)) |
| 分析 (Analysis) | Parallel coordinates, parameter importance, scatter plot |

## Read the comparison table

Columns are Runs and rows are items: status, model version, evaluation dataset versions, params, metrics, and tags.

- Choose a Run in 基準Run (Baseline Run) to mark its column 基準 (baseline). Other Runs then show, below each metric, the difference (value − baseline) and the relative change (÷ |baseline|). No difference is shown when either value is missing or NaN
- 差のある行だけ (Only rows with differences) hides rows where every Run has the same value
- Metrics are each Run's latest value
- CSVをダウンロード (Download CSV) saves the same table (items as rows, Runs as columns) as UTF-8 CSV with a BOM. With a baseline, a difference row follows each metric row

図を追加 (Add chart) adds charts, which work as described in [Metric Charts](/en/tracking/charts).

Python gets the same comparison:

```python
from mado_tracking import Client

with Client() as client:
    comparison = client.compare_runs("PROJECT_ID", ["RUN_B", "RUN_A"], baseline_run_id="RUN_A", metric_keys=["wer"])
    client.export_comparison_csv("PROJECT_ID", "compare.csv", run_ids=["RUN_B", "RUN_A"], baseline_run_id="RUN_A")
```

## Analyze search results {#analysis}

![The Analysis tab with parallel coordinates over lr, batch_size, epochs, and val_loss](/images/tracking-compare-analysis.png)

The analysis appears on the comparison page, beside the charts in the Run list when charts are shown (below them on narrower screens), and on [Sweep details](/en/tracking/sweeps#trials). It covers the search results in the Run list and the trial Runs in a Sweep, up to 5,000 Runs.

First choose the metric that defines good and bad in 目的metric (Target metric). Sweeps also offer the trials' objective value.

### Parallel coordinates

Params and the target metric become vertical axes, and each Run is a line across them, colored by the target metric from light (small) to dark (large).

- Drag along an axis to keep only Runs passing through that range; several axes can be filtered. Click an axis to clear its filter, or 絞り込みを解除 (Clear filters) to clear all
- The filtered Runs are listed below; select one to open it
- 表示する軸 (Axes) chooses axes, the ← → buttons reorder them, and 対数 (Log) makes an axis logarithmic
- Runs without a value sit at 欠損 (missing) below the axis

### Parameter importance

A table of how each param relates to the target metric.

| Column | Meaning |
| --- | --- |
| 重要度 (Importance) | Contribution when a random forest predicts the target metric. 重要度の計算 switches between impurity decrease and permutation |
| 相関 (Correlation) | Correlation with the target metric. Positive means larger values go with a larger target |
| 値のある割合 (Coverage) | Share of Runs that recorded the param |
| 種類 (Kind) | Numeric or categorical |

- With fewer than 5 Runs that have the target value, only correlation is shown
- The out-of-bag R² of the prediction model is shown above the table. When it is low, do not read too much into importance differences
- Categorical params with more than 50 distinct values are excluded; excluded params and reasons are listed below the table
- The same set of Runs always gives the same result

### Scatter plot

Choose a param or metric for X軸 (X axis) and Y軸 (Y axis) to plot Runs as points; 色 (Color) colors them by another item. Click a point to open that Run.
