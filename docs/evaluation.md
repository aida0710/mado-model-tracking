# 評価と基準版との比較

モデル版の評価結果を、同じ条件で評価した基準版（既定は alias `production` が指す版）と並べて比べる仕組みを説明する。API の形は [API契約](api-contract.md) の「評価結果の比較」を正とする。

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
5. `evaluationRuleId` を指定した場合は、その rule の自動実行が作った Run に限る（手動の評価 Run を除く）

一致する Run が複数あれば、`endedAt` が最も新しいもの（同時刻なら id の降順で先のもの）を使う。条件を指定しなければ、候補版の最新の評価 Run から正解セットと評価コード版を取る。

## 比べる値と fallback

metric ごとに次の順で値を選び、どちらを使ったかを `source` で返す。

1. `dataset_context`: MLflow で dataset 付きで記録した点のうち、`mlflow_dataset_digest` が正解セットの DatasetVersion の `digest` と一致する最新の点（step、timestamp の順に新しいもの）
2. `run_latest`: 1 が無い metric は Run の `latestMetrics`。`latestMetrics` は全 dataset の点を1つに畳むため、別 dataset で測った値が混ざりうる

正解セットに複数の DatasetVersion があり、同じ metric を両方で記録した場合は、そのうち最新の点を使う。dataset ごとに分けて比べたい場合は metric 名を分ける。

差は `候補 − 基準`、相対差は `差 ÷ |基準|`。基準が 0 の相対差、NaN・無限大（`not_finite`）や欠損（`missing`）を含む差は null で返す。良し悪しの方向は判定しない（昇格の判定は promotion policy が方向を定義する）。

## 状態

比較できない場合もエラーにせず `status` で返す。

| status | 意味 |
|---|---|
| `ok` | 候補と基準の両方に同じ条件の評価がある |
| `baseline_missing` | 基準 alias が設定されていない |
| `candidate_not_evaluated` | 候補版に条件に合う評価が無い |
| `baseline_not_evaluated` | 基準版に同じ条件の評価が無い |

`baseline_missing` と `baseline_not_evaluated` でも、候補の評価があれば候補側の値だけを並べて返す。

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
