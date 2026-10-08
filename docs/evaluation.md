# 評価と基準版との比較

モデル版の評価結果を、同じ条件で評価した基準版（既定は alias `production` が指す版）と並べて比べる仕組みと、その比較で合否を決める昇格policyを説明する。API の形は [API契約](api-contract.md) の「評価結果の比較」を正とする。

## 評価Runの作り方

評価は `kind=evaluation` の Run として記録する。比べられるのは、次をすべて満たす Run だけである。

- `modelVersionId` に評価したモデル版が入っている
- `status=finished` で、削除されていない（`lifecycleStage=active`）
- `codeVersionId` に評価コードの版が入っている（コード版を持たない手動Runどうしも比べられる）
- `inputDatasetVersionIds` に評価に使った DatasetVersion が入っている

条件を揃えるには、モデル登録後の自動実行 rule（[コンテナと自動実行](containers-automation.md)）で評価を回すのが確実である。rule は評価コード版と入力 DatasetVersion を固定して保存するため、どのモデル版にも同じ条件の評価 Run ができる。手動で評価する場合も、同じ DatasetVersion と評価コード版を指定する。

## 正解セットと上流出力

評価 Run の入力は役割で2つに分ける。

| 役割 | 中身 | Run の項目 |
|---|---|---|
| 正解セット | 正解の書き起こし・評価用音声など、どのモデル版でも同じ評価データ | `inputDatasetVersionIds` − `upstreamDatasetVersionIds` |
| 上流出力 | 推論 Run の出力（予測結果）など、モデル版ごとに別物になるデータ | `upstreamDatasetVersionIds` |

`upstreamDatasetVersionIds` は `inputDatasetVersionIds` の部分集合で、Run の作成時に決まり、後から変更できない（DB の CHECK 制約と trigger で拒否する）。「登録→推論→評価」の連鎖では、評価 Run の入力が「rule の固定分＋推論の出力」になる。推論の出力はモデル版ごとに違うため、入力全体を比べると候補版と基準版が一致しない。そこで比較の条件は正解セットだけで判定する。MLflow の dataset context（どのデータで測った値か）に近い考え方である。

値を入れるのは自動実行の連鎖（上流の出力を `upstreamDatasetVersionIds` に入れる）で、native/MLflow の Run 作成 API からは指定できない。手動の Run では空のままなので、全入力が正解セットになる。

## 一致の条件

候補版と基準版の評価 Run は、次がすべて一致するときだけ比べる。

1. 同じ Project
2. `kind=evaluation`、`status=finished`、削除されていない
3. 正解セットが集合として一致する（順序と重複は無視。1つでも多い・少ないと不一致）
4. 評価コード版（`codeVersionId`）が一致する
5. `evaluationRuleId` を指定した場合は、その rule の自動実行が作った Run に限る（手動の評価 Run を除く）。自動実行の Job を手動 retry して成功した Run も、元の自動実行の Run として扱う

一致する Run が複数あれば、`endedAt` が最も新しいもの（同時刻なら id の降順で先のもの）を使う。条件を指定しなければ、候補版の最新の評価 Run から正解セットと評価コード版を取る。

## 比べる値と fallback

metric ごとに次の順で値を選び、どちらを使ったかを `source` で返す。

1. `dataset_context`: MLflow で dataset 付きで記録した点のうち、`mlflow_dataset_digest` が正解セットの DatasetVersion の `digest` と一致する最新の点（step、timestamp の順に新しいもの）
2. `run_latest`: 1 が無い metric は Run の `latestMetrics`。`latestMetrics` は全 dataset の点を1つに畳むため、別 dataset で測った値が混ざりうる

正解セットに複数の DatasetVersion があり、同じ metric を両方で記録した場合は、そのうち最新の点を使う。dataset ごとに分けて比べたい場合は metric 名を分ける。

差は `候補 − 基準`、相対差は `差 ÷ |基準|`。基準が 0 の相対差、NaN・無限大（`not_finite`）や欠損（`missing`）を含む差は null で返す。良し悪しの方向は判定しない（昇格の判定は下の「昇格policy」が方向を定義する）。

## 状態

比較できない場合もエラーにせず `status` で返す。

| status | 意味 |
|---|---|
| `ok` | 候補と基準の両方に同じ条件の評価がある |
| `baseline_missing` | 基準 alias が設定されていない |
| `candidate_not_evaluated` | 候補版に条件に合う評価が無い |
| `baseline_not_evaluated` | 基準版に同じ条件の評価が無い |

`baseline_missing` と `baseline_not_evaluated` でも、候補の評価があれば候補側の値だけを並べて返す。

## 昇格policy（合否の判定）

昇格policy は「この Model の版を、この評価 rule の結果で合否判定する」設定である。評価 Run が `finished` になった同じ transaction の中で判定し、結果を判定履歴に残す。API の形は [API契約](api-contract.md) の「昇格policyと判定履歴」を正とする。

### 判定の対象

判定するのは、policy の `evaluationRuleId` に指定した評価 rule（`kind=evaluation` の自動実行 rule）の自動実行が作った Run だけである。手動 retry で成功した Run も、元の自動実行の Run として判定する。

- 人が作った評価 Run は判定しない。同じ版・同じ正解セット・同じ評価コード版で作り、`finished` にしても判定しない。
- 別の評価 rule が作った Run も判定しない。
- 基準版の評価も、同じ rule の自動実行が作った Run だけを使う。手動の評価 Run や別 rule の Run は基準に使わない。
- 正解セットと評価コード版は、policy に入力させずに rule の固定入力（`inputDatasetVersionIds`）と `codeVersionId` を使う。rule は作成後に変更できないため、同じ policy の判定はすべて同じ条件で比べる。
- 判定は `finished` の Run だけで行う。`failed`・`canceled` の Run は判定しない。
- 1つの Run を同じ policy で自動判定するのは1回だけである。worker の complete の再送や MLflow の Run の再開では増えない。

editor は評価 Run を自由に作れるため、条件の一致だけで対象を選ぶと、偽の合格判定が作れてしまう。対象を rule の自動実行に限るのはこのためである。

### 合否基準の書き方

`criteria` に 1〜50 件の基準を並べる。すべての基準を満たすと合格である。

| 項目 | 値 | 意味 |
|---|---|---|
| `metric` | metric 名 | 比べる metric。値の選び方は上の「比べる値と fallback」と同じ |
| `mode` | `absolute` | 候補の値そのものを閾値と比べる |
|  | `delta` | 差（候補 − 基準）を閾値と比べる |
|  | `relative_delta` | 相対差（差 ÷ \|基準\|）を閾値と比べる |
| `direction` | `higher` | 比べる値 ≥ 閾値で合格 |
|  | `lower` | 比べる値 ≤ 閾値で合格 |
| `threshold` | 有限の数 | 閾値。閾値ちょうどは合格（浮動小数の計算誤差は閾値ちょうどとみなす） |

例:

```json
[
  {"metric": "accuracy", "direction": "higher", "mode": "absolute", "threshold": 0.8},
  {"metric": "accuracy", "direction": "higher", "mode": "delta", "threshold": 0},
  {"metric": "wer", "direction": "lower", "mode": "relative_delta", "threshold": -0.05}
]
```

1行目は「accuracy が 0.8 以上」、2行目は「accuracy が基準版から下がらない」、3行目は「wer が基準版より 5% 以上下がる」。値が小さいほど良い metric は `direction: lower` にし、改善を求めるなら閾値を負にする。

### 判定の結果

| decision | 意味 |
|---|---|
| `passed` | すべての基準を満たした |
| `failed` | 満たさない基準が1つ以上ある |
| `insufficient` | 判定に必要な評価が無い（基準版に同じ rule の評価が無い、など） |
| `skipped` | 判定できなかった（policy 作成者の権限が失効している、判定中にエラーが起きた） |

- 値が NaN・無限大、または記録されていない metric の基準は `failed` にし、基準ごとの `reason`（`candidate_metric_missing`、`baseline_metric_not_finite` など）に理由を残す。基準が 0 の `relative_delta` も `failed`（`baseline_zero`）である。
- 基準 alias（既定 `production`）が未設定の初回は、`missingBaseline`（既定 `pass`）に従う。`pass` なら差・相対差の基準を合格扱いにし、判定の `reason` に `baseline_missing_first_promotion` を残す。`absolute` の基準は初回でも判定する。`fail` なら `failed`（`baseline_missing`）である。
- 基準 alias はあるが、その版に同じ rule の評価が無い場合、差・相対差の基準は `insufficient`（`baseline_not_evaluated`）になる。基準版にも rule を適用して評価してから再判定する。
- policy 作成者が Project admin（直接付与または group binding）でも全体管理者でもなくなっていれば、判定せずに `skipped`（`creator_access_revoked`）を残す。
- 判定中のエラーは `skipped`（`evaluation_error`）として残す。エラーでも評価 Run の終端と plugin への通知は確定する。

判定履歴は追記だけで、変更・削除できない。Project admin が再判定すると、同じ候補 Run について `sequence` を1つ増やした行を追加する（`requestedBy` に実行者を残す）。editor は再判定できない。

`autoPromote`（既定 false）は保存するだけで、現在は合格しても alias を切り替えない（`promoted` は常に false）。

### policy の変更

policy の設定は作成後に変更できず、有効/無効だけを切り替えられる（DB の trigger でも拒否する）。基準を変えたいときは新しい policy を作り、古い policy を無効にする。これで過去の判定は作成時の基準のまま読める。作成・切替は Project admin と全体管理者だけで、すべて監査ログに残る。

### 評価コードを直したとき

評価コードの CodeVersion を変えると、旧コードの評価と新コードの評価は比べられない。次の順で切り替える。

1. 新しい評価コード版で、新しい評価 rule を作る（rule は変更できない）。
2. 新しい rule を指定して、新しい policy を作る。古い policy は無効にする。
3. 基準版（`production` などが指す版）にも新しい rule を手動適用する（Project admin。[コンテナと自動実行](containers-automation.md) の「既存版への手動適用」）。基準版の評価が無いと、差・相対差の基準は `insufficient` になる。
4. 基準版の評価が終わったら、`insufficient` だった判定を再判定する。

## 画面

`EvaluationComparisonPanel`（apps/web/src/components）が比較を表示する部品である。基準 alias を選ぶ（既定は `production`、無ければ名前順で最初の alias）と、metric ごとの候補・基準・差・相対差、値の出典、比較に使った正解セットと評価コード版、比べた評価 Run へのリンクを表示する。モデル版の画面への組み込みは model-version-page の担当。

## 評価サンプルの推奨形式

評価 Run がサンプルごとの結果を jsonl の Artifact として保存すると、Web の Artifacts タブで表として確認できる（音声の再生、参照と推論の文字単位の差分、score での並べ替え）。

- 形式: 1行に1つの JSON オブジェクト（jsonl。拡張子 `.jsonl` / `.ndjson`、または MIME `application/x-ndjson`）。ヘッダー行付きの csv（RFC 4180）も読める。
- 列名: `audio`、`reference`、`prediction`、`score`。`audio` 列か、`reference` と `prediction` の両方がある表を評価サンプルとして表示する。ほかの列は表示しない。
  - `audio`・`reference`・`prediction` は文字列（無い場合は省略か null）。
  - `score` は数値（csv では数値の文字列）。無い場合は省略か null。
- 壊れた行（JSON として読めない、オブジェクトでない、型が違う、csv の列数が違う、引用符が閉じていない）は補完せず、「読み取れない行」として行番号と理由を表示する。
- 表示は1ページ50行。音声は再生を押すまで取得しない（`preload="none"`）。波形とスペクトログラムは行の「波形」を開いたときだけ計算する。表の Artifact は16MiBまで表示する。

```jsonl
{"audio": "eval/audio/0001.wav", "reference": "今日は晴れです", "prediction": "今日は雨です", "score": 0.29}
{"audio": "mmt-artifact://runs/<推論RunのID>/outputs/0002.wav", "reference": "こんにちは", "prediction": "こんにちは", "score": 0}
```

## audio 列のパスの書き方

- 相対パス: 表を保存した Run の Artifact として、Run の保存パスの root から解決する（表のディレクトリからではない）。`./` と重複した `/` は無視する。`..` を含むパスと `/` から始まるパスはエラー行になる。
- 別の Run の Artifact: `mmt-artifact://runs/<Run ID>/<保存パス>`。評価 Run の表が上流の推論 Run の音声を指す場合に使い、評価 Run へコピーしない。推論 Run の ID は、推論の出力にあたる入力 DatasetVersion の `sourceRunId` から取れる。解決は同じ Project の Run だけで、ほかの Project の Run や存在しない Run はエラー行になる。
- `mmt-artifact://projects/<Project ID>/runs/<Run ID>/<保存パス>` も書けるが、表と同じ Project のときだけ解決する。
- 保存パスはそのまま照合する（パーセントエンコードは解かない）。`s3://` や `https://` などほかの形式はエラー行になる。
