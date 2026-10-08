# Sweep（ハイパーパラメータ探索）

Sweep は、探索空間から parameter の組を提案して試行（trial）を繰り返し、目的メトリクスが最良の試行を探す仕組みである。語は W&B の sweep config（`method`、`metric.goal`、`parameters`、`early_terminate`）に合わせる。

Sweep の試行は、既存の Task の起動（Run と Job）として ComputeTarget のキューに入る。worker 側の変更は無い。API と制御は `apps/api/src/services/sweep*.ts`、探索アルゴリズムは `apps/api/src/domain/sweeps/`。Python SDK は `python/src/mado_tracking/sweeps.py`（下の「Python SDK」）。画面は Project の「Sweeps」（Experiments の右）。一覧 `/projects/:p/sweeps`、詳細 `/projects/:p/sweeps/:sweepId`（下の「画面」）。API の契約は [api-contract.md の Sweeps](api-contract.md#sweeps)。

## 使い方

1. 学習コードの Task を作る（Task の parameters が全試行の共通の既定値になる）。
2. `POST /api/projects/:p/sweeps` で探索空間・目的メトリクス・試行数・並列数を指定して作る。作成と同時に最初の試行が入る。
3. 試行の Run が終わるたびに次の試行が入る。全試行が終わると Sweep は `finished` になり、`bestTrial` が最良の試行を指す。

```json
{
  "name": "lr-search",
  "taskId": "<Task ID>",
  "method": "bayes",
  "searchSpace": {
    "lr": { "distribution": "log_uniform", "min": 0.00001, "max": 0.01 },
    "batch_size": { "values": [16, 32, 64] },
    "epochs": { "value": 10 }
  },
  "objective": { "metric": "val_loss", "goal": "minimize", "aggregation": "min" },
  "maxTrials": 30,
  "parallelism": 4,
  "earlyStopping": { "type": "hyperband", "minIter": 1, "eta": 3 }
}
```

### W&B の sweep config との対応

| W&B | Mado Model Tracking | 備考 |
|---|---|---|
| `method: grid / random / bayes` | `method` | 同じ |
| `metric.name` / `metric.goal` | `objective.metric` / `objective.goal` | goal は `minimize` / `maximize` |
| （summary の値） | `objective.aggregation` | `last`（既定、W&B の summary と同じ）/ `min` / `max` |
| `parameters.x.values` | `searchSpace.x.values` | |
| `parameters.x.value` | `searchSpace.x.value` | |
| `distribution: uniform` + `min`/`max` | `distribution: 'uniform'` | |
| `distribution: log_uniform_values` | `distribution: 'log_uniform'` | min/max は値そのもの。W&B の `log_uniform`（指数を渡す）とは違う |
| `distribution: int_uniform` | `distribution: 'int_uniform'` | |
| `distribution: q_uniform` + `q` | `distribution: 'q_uniform'` + `q` | |
| `early_terminate: {type: hyperband, min_iter, eta, max_iter}` | `earlyStopping: {type: 'hyperband', minIter, eta, maxIter}` | s（bracket 数）は無い（非同期の ASHA） |
| `run_cap` | `maxTrials` | 1〜10000 |
| agent の数 | `parallelism` | 1〜100。下の「並列数」を参照 |

### 学習コードで parameters を読む

試行の Run の parameters は「Task の parameters に試行の値を上書きしたもの」。worker はこれを環境変数 `MMT_PARAMETERS_JSON`（JSON 文字列）とファイル `parameters.json`（パスは `MMT_PARAMETERS_FILE`）で学習コードへ渡す。

```python
import json, os
parameters = json.loads(os.environ["MMT_PARAMETERS_JSON"])
lr = parameters["lr"]
```

Python SDK では `trial_parameters` で1行で読める（下の「Python SDK」）。

目的メトリクスは、Run のメトリクスとして step 付きで記録する（Python SDK の `run.log_metrics({"val_loss": v}, step=epoch)`、または MLflow の `log_metric`）。早期打ち切りを使うときは step を epoch などの進み具合にする。

## Python SDK

`mado_tracking.sweeps` に、学習コード側の `trial_parameters` と、Sweep を作って結果を取る `SweepsClient` がある。例は `python/examples/sweep_training.py`。

### 学習コード: trial_parameters

```python
from mado_tracking.sweeps import trial_parameters

parameters = trial_parameters({"lr": 0.05, "batch_size": 4})
lr = float(parameters["lr"])
```

- `MMT_PARAMETERS_JSON` を読み、無ければ `MMT_PARAMETERS_FILE` のファイルを読む。読んだ値を `defaults` に上書きして返す。
- worker の外（どちらの環境変数も無い）では `defaults` をそのまま返す。同じスクリプトを手元で試せる。
- 値は JSON の型のまま返す。文字列の `"0.1"` を数値に直さないので、数値が要るところで `float()` などに変換する。
- JSON が壊れている、object でない、ファイルが読めないときは `ConfigurationError`（`defaults` で黙って続けない）。

### Sweep の作成と結果: SweepsClient

```python
from mado_tracking import Client
from mado_tracking.sweeps import SweepsClient

with Client() as client:
    sweeps = SweepsClient(client)
    sweep = sweeps.create_sweep(
        project_id,
        task_id=task_id,
        name="lr-search",
        config={
            "method": "bayes",
            "metric": {"name": "val_loss", "goal": "minimize"},
            "parameters": {
                "lr": {"distribution": "log_uniform_values", "min": 1e-5, "max": 1e-2},
                "batch_size": {"values": [16, 32, 64]},
            },
            "early_terminate": {"type": "hyperband", "min_iter": 1, "eta": 3},
            "run_cap": 30,
            "parallelism": 4,
        },
    )
    for trial in sweeps.iter_trials(project_id, sweep["id"], order_by="objective"):
        print(trial["trialIndex"], trial["state"], trial["objectiveValue"])
    print(sweeps.best_trial(project_id, sweep["id"]))
```

| メソッド | API | 備考 |
|---|---|---|
| `create_sweep(project_id, *, task_id, config, name, target_id=None, gpu_ids=None, seed=None)` | `POST /projects/:p/sweeps` | config は W&B 形式（下の表）。試行の Run は Task の Experiment に入る。target/GPU は None で Task の既定。seed は省略でサーバーが決める |
| `get_sweep(project_id, sweep_id)` | `GET /projects/:p/sweeps/:s` | |
| `iter_sweeps(project_id, *, status=None, page_size=50)` | `GET /projects/:p/sweeps` | 新しい順。`nextCursor` を辿る |
| `iter_trials(project_id, sweep_id, *, order_by="trial_index", page_size=100)` | `GET /projects/:p/sweeps/:s/trials` | `order_by="objective"` は良い順。`nextCursor` を辿る |
| `best_trial(project_id, sweep_id)` | `GET /projects/:p/sweeps/:s` の `bestTrial` | 最良の試行がまだ無ければ None |
| `pause` / `resume` | `POST .../pause` / `.../resume` | |
| `cancel(project_id, sweep_id, *, cancel_running_trials=False)` | `POST .../cancel` | queued の試行は必ず止まる。実行中も止めるときは True |

- 読み取り（get・iter・best_trial）は一時的な失敗（408・429・5xx・接続失敗）を再試行する。書き込み（create・pause・resume・cancel）は冪等でないので再試行しない。失敗は `ApiError`（`status_code`・`code`）で返る。
- iterator はページを必要になった時点で取りに行く。同じ cursor が2回返ったら `ConfigurationError` で止める。

### W&B 形式の config の変換規則

SDK（`python/src/mado_tracking/sweep_config.py` の `convert_sweep_config`）と画面（`apps/web/src/lib/sweepConfig.ts`）は、同じ config を同じ API の body に変換する。どちらかを変えるときは、この表ともう一方を合わせて直す。未対応のキーは無視せずエラーにする（SDK は `ConfigurationError`、画面は入力エラー）。黙って捨てると、書いたものと違う探索が回るため。

| W&B の config | API の body | 例 |
|---|---|---|
| `method: grid / random / bayes` | `method` | それ以外はエラー |
| `metric: {name, goal}` | `objective: {metric, goal}` | goal は `minimize` / `maximize`。`target` などほかのキーはエラー |
| `metric.aggregation`（Mado の拡張） | `objective.aggregation` | `last` / `min` / `max`。省略時はサーバーの既定 `last` |
| `parameters.x: {values: [...]}`、`distribution: categorical` | `searchSpace.x: {values}` | `probabilities` はエラー |
| `parameters.x: {value: v}`、`distribution: constant` | `searchSpace.x: {value}` | |
| `{distribution: uniform, min, max}` | `{distribution: 'uniform', min, max}` | |
| `{distribution: int_uniform, min, max}` | `{distribution: 'int_uniform', min, max}` | |
| `{distribution: q_uniform, min, max, q}` | `{distribution: 'q_uniform', min, max, q}` | q は q_uniform だけ |
| `{distribution: log_uniform_values, min, max}` | `{distribution: 'log_uniform', min, max}` | `{min: 1e-5, max: 1e-2}` はそのまま |
| `{min, max}`（distribution 省略） | 両方整数なら `int_uniform`、それ以外は `uniform` | W&B の推定と同じ。`{min: 1, max: 8}` → int_uniform、`{min: 0, max: 0.5}` → uniform |
| `distribution: log_uniform`（指数を渡す） | エラー | 意味が違うので `log_uniform_values` に書き換える |
| `normal`・`q_log_uniform_values` などほかの distribution、入れ子の `parameters` | エラー | |
| `early_terminate: {type: hyperband, min_iter, eta, max_iter}` | `earlyStopping: {type: 'hyperband', minIter, eta, maxIter}` | min_iter は必須。eta は省略で3（W&B の既定）。`s`・`strict` はエラー |
| `run_cap` | `maxTrials` | 必須（API が試行数の上限を必須にしているため） |
| `parallelism` | `parallelism` | 省略時はサーバーの既定1 |
| `program`・`command`・`name`・`project` などほかのトップレベルのキー | エラー | 名前は `create_sweep(name=)`、実行するコードは Task で決める |

画面（JavaScript）では JSON の `1.0` と `1` を区別できないので、distribution を省略した `{min: 1.0, max: 8.0}` は画面では int_uniform、SDK では uniform になる。どちらにしたいか曖昧なときは distribution を書く。

値の範囲（min<max、grid の組み合わせ数など）は SDK では確かめず、API の 422（`sweep_space_invalid`・`sweep_early_terminate_invalid`）で返る。

## 画面

- 一覧（Sweeps）: 名前、Task、探索方法、状態、試行数/上限、実行中（queued と running の数）、最良の目的値、作成者、作成日時。状態で絞り込み、続きは「さらに読み込む」（cursor）。「Sweepを作成」は editor 以上に出る。
- 作成ダイアログ: Task（作成時点の revision を固定することを表示）、Experiment は Task のものを表示するだけ（API の SweepCreate に experimentId は無い）、Compute target と GPU（空は Task の既定）、探索方法、目的（metric 名の候補は Task の最新の Run 50件の metrics）、最大試行数、並列数、seed、早期打ち切り（なし / hyperband: min_iter・eta・max_iter）。
  - 探索空間は parameter ごとの行（値の列挙 / 範囲＋分布 / 定数）か、W&B 形式の JSON の貼り付け。JSON の変換は上の「W&B 形式の config の変換規則」の表と同じ。未対応のキーは画面の入力エラー。JSON に切り替えると、行の内容を W&B 形式にして表示する。
  - 値の列挙はカンマ区切り（数値・true/false は型を保つ。`"32"` のように引用符で囲むと文字列）。値にカンマを含むときは JSON 配列で書く。
  - grid の組み合わせ数を入力中に表示し、10000 を超えたら送信しない。
  - min<max などの値の検査は API に任せ、422 `sweep_space_invalid` の message が「名前」で指す parameter の行に出す。指さない message は探索空間の上に出す。
- 詳細: 状態と理由、進み具合（作成済みの試行数/最大試行数と状態別の件数）、最良試行（目的値と parameters）、試行ごとの目的値の散布と「それまでの最良」の階段線（finished と early_stopped だけで更新）、定義、試行の表（parameters の列、目的値、状態。early_stopped は別の色、Run・Job へのリンク、試行番号順 / 目的値の良い順）、試行 Run の目的メトリクスの重ね描き（新しい200試行まで）、分析（RunAnalysisPanel、runSet は sweepId）。
  - 一時停止・再開・中止・試行数と並列数の変更は、作成者（editor 以上）か Project admin にだけ出す。終了した Sweep には出さない。Task の改訂で止まった Sweep（`task_revision_changed`）には再開を出さず、新しい Sweep の作成を案内する。
  - Sweep が running か、queued・running の試行が残る間は5秒ごとに読み直す。

## 試行の制御

- 試行の Run は Sweep の作成者が作ったものとして記録する（自動実行の rule と同じ）。名前は `<Sweep名>-<trial_index>`、予約 tag `mmt.sweepId`・`mmt.sweepTrialIndex` をサーバーが付ける。
- Task の revision は作成時に固定する。Task を編集すると、次の投入時に Sweep を `paused`（`task_revision_changed`）にする。新しい版で勝手に回さないため。再開はできず、新しい Sweep を作る。
- 作成者が Project の editor でなくなったら、次の投入時に `paused`（`owner_forbidden`）にする。
- Job の登録に失敗したら（target の無効化など）`paused`（`launch_failed`）。原因を直して resume する。
- 試行の Job を手で retry して作った Run は Sweep の試行に数えない（tag は引き継がれるが `sweep_trials` には入らない）。

### 並列数と target の max_concurrent_jobs

`parallelism` は「同時に queued か running の試行の数」の上限で、Sweep が Job をキューに入れる量を決める。実際に同時に動く数は、さらに ComputeTarget の `max_concurrent_jobs` と GPU の空きで制限される。例えば parallelism=8 でも target の max_concurrent_jobs=2 なら、2件が動き、6件は queued で待つ。target を他の Job と共有するときは parallelism を max_concurrent_jobs 以下にすると、ほかの Job の順番を押しのけない。

### 早期打ち切りの意味

`earlyStopping` を指定すると、API 内の scheduler（15秒ごと）が running の試行のメトリクスを rung（minIter×eta^k step）で比べ、上位 1/eta に入らなかった試行の Job に cancel を要求する。試行は `early_stopped` になり、Run は worker が止めた後に `canceled` になる。Run の tag `mmt.sweepEarlyStopped=true` が付く。打ち切った試行の objective も記録し、最良試行の候補に含める（打ち切った時点の値なので、通常は上位にならない）。止めた枠にはすぐ次の試行が入る。

最良試行（`bestTrial`）は `finished` と `early_stopped` の試行から選ぶ。failed・canceled は途中で切れた値なので含めない。

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
