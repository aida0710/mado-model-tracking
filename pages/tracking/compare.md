---
title: Runを比較する
description: 選んだRunを並べて比べる比較画面、基準Runとの差、平行座標・パラメータ重要度・散布図による探索結果の分析。
---

# Runを比較する

![比較画面。基準Runとの差を各セルの下に表示している](/images/tracking-compare.png)

比較画面では、選んだRunのparams・metrics・tagsを1つの表に並べます。基準にするRunを決めると、metricsごとに基準との差を表示します。［分析］タブでは、平行座標・パラメータ重要度・散布図で「どのparamが結果に効いたか」を確かめられます。

## こんなときに向いています

- 学習率だけを変えた3つのRunで、どの指標がどれだけ良くなったかを数字で確かめたい
- 評価Runごとに、使ったモデル版と評価データセット版の違いを確かめたい
- Sweepの30試行から、結果に効いているparamを見つけたい

## 比較画面を開く

1. ［Experiments］の一覧で、比べたいRunのチェックボックスを選びます。違うExperimentのRunも、［すべての実験］から選べます
2. 表の上に「2 runs · 選択中」のような選択バーが出るので、［比較］を選びます

2〜50件のRunを比較できます。比較画面のURLには選んだRunと基準Runが入るので、そのまま共有できます。

| タブ | 内容 |
| --- | --- |
| 詳細 | 比較表と、選んだRunを重ねたメトリクスの図 |
| Artifacts | すべてのRunにある同じパスのArtifactを並べます |
| Media | stepごとの音声・画像の聴き比べ（[メディアの記録と聴き比べ](/tracking/media#compare-runs)） |
| 分析 | 平行座標・パラメータ重要度・散布図 |

## 比較表を読む

表の列がRun、行が項目です。上から状態、モデル版、評価データセット版、params、metrics、tagsの順に並びます。

- ［基準Run］でRunを選ぶと、その列に「基準」と付き、ほかのRunのmetricsの下に基準との差（値−基準）と変化率（÷基準の絶対値）を表示します。どちらかの値が無い、またはNaNのときは差を出しません
- ［差のある行だけ］を選ぶと、すべてのRunで同じ値の行を隠します
- metricsは各Runの最新の値です
- ［CSVをダウンロード］で、同じ表（行が項目、列がRun）をBOM付きのUTF-8のCSVで保存します。基準を選んでいると、metricsの行の次に差の行が入ります

図は［図を追加］で足せます。図の使い方は[メトリクスの図](/tracking/charts)と同じです。

Pythonからも同じ比較を取得できます。

```python
from mado_tracking import Client

with Client() as client:
    comparison = client.compare_runs("PROJECT_ID", ["RUN_B", "RUN_A"], baseline_run_id="RUN_A", metric_keys=["wer"])
    client.export_comparison_csv("PROJECT_ID", "compare.csv", run_ids=["RUN_B", "RUN_A"], baseline_run_id="RUN_A")
```

## 探索結果を分析する {#analysis}

![比較画面の分析タブ。平行座標でlr、batch_size、epochs、val_lossを結んでいる](/images/tracking-compare-analysis.png)

［分析］タブは、比較画面のほか、［Experiments］の一覧で［図を表示］を選んだときの右側と、[Sweepの詳細](/tracking/sweeps#trials)にもあります。一覧では検索結果のRun、Sweepでは試行のRunが対象です。対象は5,000件までです。

最初に［目的metric］で、良し悪しを決めるmetricを選びます。Sweepでは試行の目的値も選べます。

### 平行座標

paramと目的metricを縦の軸にして、Runごとに線で結びます。線の色は目的metricの値で、小さいほど薄く、大きいほど濃くなります。

- 軸の上をドラッグすると、その範囲を通るRunだけに絞り込みます。複数の軸で絞り込めます。軸をクリックすると解除し、［絞り込みを解除］ですべて解除します
- 絞り込んだRunの名前が下に並び、選ぶとそのRunを開きます
- ［表示する軸］で軸を選び、軸の上の←→で並びを入れ替えます。［対数］で軸を対数にします
- 値の無いRunは、軸の下の「欠損」の位置に置きます

### パラメータ重要度

paramごとに、目的metricへの効き方を表にします。

| 列 | 意味 |
| --- | --- |
| 重要度 | ランダムフォレストで目的metricを予測したときの寄与。［重要度の計算］で［不純度の減少］と［並べ替え（permutation）］を切り替えます |
| 相関 | 目的metricとの相関係数。正なら値が大きいほど目的metricも大きくなります |
| 値のある割合 | そのparamが記録されているRunの割合 |
| 種類 | 数値かカテゴリか |

- 目的metricの値があるRunが5件未満のときは、重要度を計算せず相関だけを表示します
- 表の上に、予測モデルの当てはまり（out-of-bag R²）を表示します。低いときは、重要度の差を当てにしすぎないでください
- 値の種類が50を超えるカテゴリのparamは、計算から除きます。除いたparamとその理由は表の下に出ます
- 同じRunの集合なら、何度開いても同じ結果になります

### 散布図

［X軸］と［Y軸］にparamかmetricを選び、Runを点で描きます。［色］に別の項目を選ぶと、その値で点の色を変えます。点をクリックすると、そのRunの詳細を開きます。
