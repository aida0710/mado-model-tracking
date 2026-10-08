---
title: Metric Charts
description: Smoothing, log scales, x-axis choices, Run grouping, and chart panel layout for metric charts.
---

# Metric Charts

![Chart panels above the Run list](/images/tracking-charts.png)

Recorded metrics are drawn as line charts by step on these pages:

| Page | What it shows |
| --- | --- |
| The Run list under **Experiments**, with 図を表示 (Show charts) | Search-result Runs overlaid, plus [result analysis](/en/tracking/compare#analysis) |
| A Run's **Metrics** tab | That Run's metrics |
| A Run's **System metrics** tab | CPU, memory, disk, network, and GPU ([System metrics](/en/tracking/sdk#system-metrics)) |
| The 詳細 (Details) tab of the comparison page | The selected Runs overlaid |

## When it helps

- Overlaying the loss of runs with different learning rates to compare how fast they converge
- Smoothing a noisy loss to see its trend
- Summarizing dozens of trials as the mean and range per batch size
- Sharing a layout with only the charts you care about

## Read a chart

- Click a legend item to hide or show that line; すべて表示 (Show all) brings hidden lines back. Hovering a legend item highlights its line
- Drag across the chart to zoom into that range; ズームを戻す (Reset zoom) returns to the full range
- Hover a line to see the values of each Run at that position
- Resumed Runs show a 再開 (resumed) marker ([Run resume](/en/tracking/sdk#resume))

Long series are downsampled on the server before drawing. Each series has at most 1,000 points, fewer when many lines are overlaid. Downsampling draws the mean of each interval and keeps its minimum and maximum, so short spikes remain visible with 範囲（最小〜最大）を表示 (Show range). Zooming in fetches finer data for that range. NaN and infinite values are not drawn.

## Configure a chart

![The chart settings dialog](/images/tracking-chart-editor.png)

The settings button at the top right of a chart (図を設定) changes the following:

| Item | Values |
| --- | --- |
| Title | The metric names when left empty |
| Metrics | Up to 10 per chart, with a search box to filter names |
| x-axis | Step, elapsed time (seconds since the Run started), wall time, or a metric |
| Smoothing | None, EMA (exponential moving average), Gaussian, or running average, with a strength from 0 to 1 |
| Log y-axis, log x-axis | Values of 0 or below cannot be placed on a log axis; they are skipped and their count is shown below the chart |
| Show range (min to max) | Draws the minimum and maximum of each downsampled interval as a band |
| Show unsmoothed line | Draws the original line faintly behind a smoothed one |

With a metric as the x-axis, the value chosen in x軸のメトリクス becomes the horizontal axis, for example `val_loss` against `epoch`. Points without an x value at the same step are skipped.

As in W&B, smoothing works on the order of points. EMA strength is capped at 0.999 so the line still follows new values. At strength 1, Gaussian smoothing spans about 60 points on each side and the running average covers the last 100 points.

## Runs to draw and grouping

Above the charts in the Run list you choose:

- 図にするRun (Runs to draw): the top 50 search results, or the Runs selected in the list
- グループ化 (Group by): none, Tag, Param, or Experiment

With grouping, Runs are grouped by the value of the chosen key, and every chart draws each group's mean line with a band from the minimum to the maximum across Runs. Legend entries get （平均） (mean). Each Run is averaged per interval first and then averaged across Runs, so a Run with many points does not dominate.

- Runs without the value go to the `(none)` group
- Up to 50 groups and 1,000 Runs

## Arrange chart panels

Charts sit on a 12-column grid.

- 図を追加 (Add chart) creates a chart
- The move button at the top right of a chart moves it up, down, left, or right, sets its width (1/3, 1/2, full), or makes it taller
- The delete button removes the chart
- 既定の配置に戻す (Reset layout) restores the default layout

The layout is saved in this browser per Project and page. To use the same layout in another browser or with other members, save a [saved view](/en/tracking/runs#saved-views) in the Run list; it includes the chart panel layout and grouping.
