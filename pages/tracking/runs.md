---
title: Runを記録して探す
description: Project・Experiment・Runの関係、params・metrics・tags、Runの一覧と全履歴の検索、保存ビュー、CSV出力。
---

# Runを記録して探す

![Experimentを選んでRunの一覧を表示した画面](/images/tracking-runs.png)

mado ML Trackingでは、学習や評価の1回の実行を「Run」として記録します。Runにはparams（実行条件）、metrics（stepごとの数値）、tags（目印）、ログ、Artifact（ファイル）が付きます。画面上部の［Experiments］で、Runを一覧・検索・比較できます。

## こんなときに向いています

- 学習率やbatch sizeを変えた実行を並べて、どの条件が良かったかを確かめたい
- 半年前の実験も含めて、`val_loss`が一定より小さいRunだけを探したい
- よく使う絞り込みと列の並びを保存して、チームで同じ表示を開きたい
- 検索結果をCSVにして、表計算ソフトで集計したい

## Project・Experiment・Runの関係

| 単位 | 内容 | 作る場所 |
| --- | --- | --- |
| Project | 権限と保存先の単位。メンバーと役割（viewer・editor・admin）はProjectごとに決まります | Projectの切り替えの［＋ プロジェクトを作成］（[Projectの作成と管理](/admin/projects)） |
| Experiment | 同じ目的のRunをまとめる単位（「音声合成の学習」など） | ［Experiments］の左側の［+］（実験を作成） |
| Run | 1回の実行の記録 | Python SDK、MLflow 3 SDK、Task・Sweep・自動実行、画面の［Runを作成］ |

Runには実行種別があります。学習、ファインチューニング、推論、評価、データ処理の5種類で、一覧の［実行種別］で絞り込めます。

閲覧はviewer以上、Runの記録や編集はeditor以上の役割が必要です。役割の付け方は[権限](/admin/permissions)を参照してください。

## params・metrics・tags

| 項目 | 記録する内容 | 規則 |
| --- | --- | --- |
| params | 学習率、epoch数など、実行の条件 | 一度記録したキーに別の値は書けません。条件を変えるときは新しいRunにします |
| metrics | lossや精度など、stepごとに変わる数値 | stepと時刻を一緒に保存します。一覧に出るのは最新の値です |
| tags | データセット名、担当者など、Runを探すための目印 | あとから変更できます |

metricsの「最新の値」は、届いた順ではなくstepと時刻の大きいものです。途中から記録し直しても、最後のstepの値が一覧に出ます。

`mmt.`と`automation.`で始まるtagはシステムが付けるもので、利用者は付け外しできません。Sweepの試行番号（`mmt.sweepTrialIndex`）などがこれに当たります。

Workerで動いたRun（Jobが付いたRun）は、終わったあとにmetrics・params・tagsを追加できません。結果を後から書き換えられないようにするためです。説明文とコメントは終わったあとも書けます（[メモとコメント](/tracking/notes)）。

## Runの一覧

左側で［すべての実験］かExperimentを選ぶと、Runが新しい順に並びます。

- ［状態］と［実行種別］で絞り込みます
- ［並び順］は作成日時と名前に加え、metricsの昇順・降順を選べます
- ［表示する列］で、表に出すparams・metrics・tagsの列を選びます。列の端をドラッグすると幅が変わり、見出しを選んでAlt+←/→で列を移動できます
- 行のチェックボックスでRunを選ぶと、表の上に選択バーが出ます。2件以上選んで［比較］を選ぶと[比較画面](/tracking/compare)を開きます。editor以上は［タグを追加］で、選んだRunにまとめてtagを付けられます
- Run名を選ぶと、そのRunの詳細（Metrics、Media、Artifacts、System metrics、Logsなど）を開きます

## 全履歴を検索する

![metrics.val_loss < 0.1で全Experimentを検索した画面](/images/tracking-runs-search.png)

検索欄には、Run名の一部か、MLflowの`search_runs`と同じ形式の検索式を入力します。検索はサーバー側で全履歴に対して行うので、表示中のページに無い古いRunも見つかります。

```text
metrics.val_loss < 0.1
params.batch_size = '32' AND metrics.accuracy >= 0.9
tags.dataset = 'training-v1' AND attributes.status = 'finished'
```

- 条件は`AND`でつなぎます。`OR`と括弧は使えません
- paramsは文字列として比べるので、値を引用符で囲みます（`params.lr = '0.01'`）
- metricsは各Runの最新の値で比べます
- 状態は`finished`・`failed`などの名前でも、MLflowの`FINISHED`・`FAILED`でも指定できます

［すべての実験］を選んでから検索すると、Project内の全Experimentが対象になります。検索式が読めないときは、何文字目を確認すればよいかが検索欄の下に表示されます。

Pythonからも同じ検索式を使えます。

```python
from mado_tracking import Client

with Client() as client:
    for run in client.search_runs(
        "PROJECT_ID",
        filter="metrics.val_loss < 0.1 AND params.lr = '0.01'",
        order_by=["metrics.val_loss ASC"],
    ):
        print(run["name"], run["latestMetrics"]["val_loss"])
```

## 保存ビュー {#saved-views}

![保存ビューのメニューを開いた画面](/images/tracking-saved-views.png)

Experimentの選択、検索式、状態と実行種別の絞り込み、並び順、表示する列と幅、図のグループ化と[図パネル](/tracking/charts)の配置を、名前を付けて保存できます。保存したビューは一覧の左上のメニューから開けます。

1. 一覧を見たい形に整えます
2. ［名前を付けて保存］を選びます
3. ［ビューの名前］を入力し、［公開範囲］を選んで保存します

| 公開範囲 | 見える人 | 作れる人 |
| --- | --- | --- |
| 自分だけ | 作った本人だけ。ほかのメンバーには一覧にもURLにも出ません | viewer以上 |
| プロジェクトで共有 | Projectのメンバー全員 | editor以上 |

ビューを開いたあとに表示を変えると、メニューに「未保存の変更」と出ます。［上書き保存］で今の表示を保存し、［名前を付けて保存］で別のビューにできます。［URLをコピー］で、ビューを開くURL（`?view=<ID>`）をコピーできます。共有したビューの名前変更・内容の変更・削除は、作った本人とProject adminができます。

保存されるのは表示の条件だけで、Runの一覧そのものは保存しません。開くたびにその時点のRunで検索し直します。

## CSVに出力する

一覧の［検索結果をCSV出力］を選ぶと、いまの検索条件に一致したRunを1件1行のCSVでダウンロードします。表示中のページだけでなく、一致した全件が対象です。

- 列は`id`、`name`、`experiment`、`kind`、`status`、`created`、`ended`、`modelVersion`、`datasetVersions`のあとに、`params.*`・`metrics.*`・`tags.*`が続きます
- 文字コードはBOM付きのUTF-8なので、Excelでそのまま開けます
- 1回に出力できるのは50,000行までです（管理者が変更できます）。超えた分は省き、画面とCSVの末尾に打ち切ったことを示します
- `=`や`+`で始まる値は、表計算ソフトで数式として動かないように先頭に`'`を付けます

Pythonでは`export_runs_csv`で同じCSVを保存できます。

```python
with Client() as client:
    client.export_runs_csv("PROJECT_ID", "runs.csv", filter="metrics.val_loss < 0.1")
```

選んだRunを項目ごとに並べたCSVは、[比較画面](/tracking/compare)の［CSVをダウンロード］で出力します。
