---
title: Sweep（ハイパーパラメータ探索）
description: 探索空間と目的メトリクスを決めて試行を自動で繰り返すSweep。grid・random・bayes、早期打ち切り、試行の見方。
---

# Sweep（ハイパーパラメータ探索）

![Sweepの詳細画面。最良試行、試行ごとの目的値、定義が並ぶ](/images/tracking-sweep-detail.png)

Sweepは、探索空間からparamの組を選んで学習を繰り返し、目的メトリクスが最も良い組を探す機能です。試行はTaskの実行としてCompute targetのキューに入り、Workerが順に実行します。書き方はW&Bのsweep config（`method`、`metric`、`parameters`、`early_terminate`）に合わせています。

## こんなときに向いています

- 学習率とbatch sizeの組み合わせを、総当たりで試したい
- 試行回数を決めて、良さそうな範囲を自動で絞り込みながら探したい
- 見込みの無い試行を途中で止めて、コンピュータを次の試行に回したい

## 始める前に

- 学習コードを実行するTaskが必要です。Taskのparamsが全試行の共通の既定値になります（[Taskとコード](/models/tasks)）
- Sweepを作るにはProjectのeditor以上の役割が必要です
- 学習コードは、目的メトリクスをstep付きで記録してください。早期打ち切りを使う場合、stepはepochなどの進み具合にします

## 学習コードで試行のparamsを読む

試行のparamsは「Taskのparamsに試行の値を上書きしたもの」です。Python SDKの`trial_parameters`で読めます。

```python
import mado_tracking
from mado_tracking import trial_parameters

parameters = trial_parameters({"lr": 0.05, "batch_size": 4})
lr = float(parameters["lr"])
batch_size = int(parameters["batch_size"])

with mado_tracking.start_run() as run:
    for epoch in range(10):
        val_loss = train_one_epoch(lr, batch_size)
        run.log_metrics({"val_loss": val_loss}, step=epoch)
```

- Workerの外で実行すると、渡した既定値をそのまま返します。同じスクリプトを手元で試せます
- 値はJSONの型のまま返します。数値として使うところで`float()`などに変換してください
- SDKを使わない場合は、環境変数`MMT_PARAMETERS_JSON`（JSON文字列）か、`MMT_PARAMETERS_FILE`が指すファイルを読みます

## Sweepを作る

画面上部の［Sweeps］で［Sweepを作成］を選び、次の項目を入力します。

| 項目 | 入力する値 |
| --- | --- |
| Task | 学習コードのTask。作成時点のTaskの改訂番号を固定します |
| Compute target・GPU ID | 空欄ならTaskの既定を使います |
| 探索方法 | grid、random、bayes |
| 目的メトリクス・方向 | 例: `val_loss`を最小化。候補はTaskの過去のRunで記録されたメトリクスです |
| 試行の値の決め方 | 最後の値（既定）、最小値、最大値 |
| 最大試行数 | 1〜10,000 |
| 並列数 | 同時に待機・実行する試行の数。1〜100 |
| Seed | 空欄ならサーバーが決めます。同じSeedなら、randomは同じ値を選びます |
| 早期打ち切り | なし、Hyperband（min_iter、eta、max_iter） |
| 探索空間 | 下の表 |

探索空間は［行で編集］でparamごとに入力するか、［W&B形式のJSON］に貼り付けて［読み込む］を選びます。

| 種類 | 指定 | 例 |
| --- | --- | --- |
| 値の列挙 | 値をカンマ区切り。`"32"`のように引用符で囲むと文字列になります | `16, 32, 64` |
| 定数 | 1つの値 | `10` |
| 範囲 | 分布（uniform、log_uniform、int_uniform、q_uniform）とmin・max | `log_uniform` 0.00001〜0.01 |

`log_uniform`のmin・maxは値そのものです。W&Bの`log_uniform_values`に当たり、指数を渡すW&Bの`log_uniform`とは意味が違います。paramは50個まで指定できます。

W&B形式のJSONの例です。

```json
{
  "method": "bayes",
  "metric": { "name": "val_loss", "goal": "minimize" },
  "parameters": {
    "lr": { "distribution": "log_uniform_values", "min": 0.00001, "max": 0.01 },
    "batch_size": { "values": [16, 32, 64] }
  },
  "early_terminate": { "type": "hyperband", "min_iter": 1, "eta": 3 },
  "run_cap": 30,
  "parallelism": 4
}
```

`run_cap`（最大試行数）は必須です。`program`や`command`など、対応していないキーはエラーになります。黙って無視すると、書いた内容と違う探索が動くためです。名前は画面で入力し、実行するコードはTaskで決めます。

作成すると最初の試行がすぐにキューに入ります。試行のRunはTaskのExperimentに`<Sweep名>-<試行番号>`の名前で作られます。

Pythonから作ることもできます。

```python
from mado_tracking import Client
from mado_tracking.sweeps import SweepsClient

with Client() as client:
    sweeps = SweepsClient(client)
    sweep = sweeps.create_sweep("PROJECT_ID", task_id="TASK_ID", name="lr-search", config={...})
    print(sweeps.best_trial("PROJECT_ID", sweep["id"]))
```

## 探索方法

| 方法 | 選び方 | 向いている場面 |
| --- | --- | --- |
| grid | 値の列挙と定数の、すべての組み合わせを順に試します。範囲（分布）は使えません。組み合わせは10,000通りまでで、入力中に数を表示します | 候補が少なく、総当たりしたい |
| random | 探索空間から無作為に選びます | 範囲が広く、まず全体の傾向を見たい |
| bayes | TPE（Tree-structured Parzen Estimator）で、良かった試行に近い値を選びます。完了した試行が10件になるまではrandomと同じです | 試行回数を抑えて、良い値に早く近づきたい |

## 早期打ち切り

Hyperbandを選ぶと、実行中の試行を15秒ごとに比べ、見込みの無い試行を止めます。

- min_iter×eta^k（1、3、9…など）のstepごとに、そこまで到達した試行の目的メトリクスを比べます
- 上位1/etaに入らなかった試行を止めます。到達した試行がeta件未満のときは止めません
- 止めた試行は「早期打ち切り」になります。RunはWorkerが止めたあとに終了し、Runの一覧でも「早期打ち切り」と表示して、人が止めたRunと区別します。空いた枠にはすぐ次の試行が入ります
- 止めた時点の値も記録し、最良試行の候補に含めます

## 並列数とコンピュータの上限

並列数は、Sweepが同時にキューへ入れる試行の数の上限です。実際に同時に動く数は、Compute targetの同時実行数とGPUの空きでも制限されます。並列数を8にしても、targetの同時実行数が2なら2件だけが動き、残りは待機します。targetをほかのJobと共有する場合は、並列数をtargetの同時実行数以下にすると、ほかのJobの順番を押しのけません。

## 試行を見る {#trials}

![Sweepの一覧](/images/tracking-sweeps.png)

［Sweeps］の一覧には、状態、試行数と上限、実行中の試行数、最良の目的値が並びます。Sweepを選ぶと詳細を開きます。

- 状態と理由、進み具合（状態ごとの件数）
- 最良試行: 完了した試行と早期打ち切りの試行から、目的値が最も良いもの。同じ値なら試行番号の小さい方
- 試行ごとの目的値の点と、「それまでの最良」の階段線
- 定義: 探索方法、目的、並列数、早期打ち切り、Taskの改訂番号、Seed、探索空間
- 試行の表: paramsの列、目的値、状態、Run・Jobへのリンク。［試行番号順］と［目的値の良い順］を切り替えられます
- 試行の目的メトリクスを重ねた図（新しい200試行まで）
- [探索結果の分析](/tracking/compare#analysis)（平行座標・パラメータ重要度・散布図）

実行中の試行がある間は、5秒ごとに表示を更新します。

## 止める・変える

作成者（editor以上）とProject adminは、詳細画面で次の操作ができます。

- ［一時停止］と［再開］: 新しい試行の投入を止め、再び始めます
- ［Sweepを中止］: 新しい試行の投入をやめ、待機中の試行を止めます。［実行中の試行にも停止を要求する］を選ぶと、実行中の試行も止めます
- ［試行数・並列数を変更］: 最大試行数と並列数を変えます。最大試行数は作成済みの試行数より小さくできません

探索方法や探索空間などの定義は変えられません。変えるときは新しいSweepを作ります。

Sweepは次の場合に自動で一時停止します。

| 理由 | 対処 |
| --- | --- |
| Taskが編集された | 古い条件のまま回さないため止めます。再開はできないので、新しいSweepを作ります |
| 作成者がProjectのeditorでなくなった | 作成者の役割を戻してから再開します |
| Jobの登録に失敗した（targetの無効化など） | 原因を直してから再開します |

試行のJobを手動で再実行して作ったRunは、Sweepの試行には数えません。
