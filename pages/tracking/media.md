---
title: メディアの記録と聴き比べ
description: 学習中のstepごとに音声・画像・動画・表を記録し、stepのスライダーやRun×stepの表で聴き比べる。
---

# メディアの記録と聴き比べ

![RunのMediaタブ。キーの一覧とstepのスライダー、音声入りの表](/images/tracking-media.png)

学習の途中で生成した音声や画像を、stepと一緒に記録できます。Runの［Media］タブでstepを動かして変化を確かめ、［比較］の［Media］タブで複数のRunと複数のstepを並べて聴き比べます。

## こんなときに向いています

- 音声合成の学習で、100 stepごとの推論音声がどう変わったかを聴きたい
- 2つの学習率で、同じstepの生成音声を切り替えながら比べたい
- 評価サンプルの音声・書き起こし・スコアを1つの表で確かめたい

## Python SDKで記録する

numpyの配列やPILの画像を渡すときは、`media`の追加パッケージを入れます（[インストール](/tracking/sdk#install)）。ファイルのパスやbytesだけなら不要です。

```python
import mado_tracking
from mado_tracking import Audio, Table

with mado_tracking.start_run(name="tts") as run:
    for step in range(1, 1001):
        run.log_metrics({"loss": loss}, step=step)
        if step % 100:
            continue
        run.log_audio("inference/sample", waveform, sample_rate=16000, caption="prompt 1")
        run.log_image("inference/spectrogram", mel)
        run.log_table("evaluation/samples", Table(
            columns=["audio", "transcript", "score"],
            rows=[[Audio(wav, sample_rate=16000), text, score] for wav, text, score in samples],
        ))
```

`step`を省略すると、直前に`log_metrics`で記録したstepに入ります。

| 関数 | 渡せるもの |
| --- | --- |
| `log_audio(key, data, sample_rate=)` | ファイルのパス、bytes（WAV・FLAC・MP3・OGG・M4A）、numpyの配列。配列のときは`sample_rate`が必須です。floatは-1〜1の範囲を16bitのPCMに変換し、範囲外は切り詰めます |
| `log_image(key, image)` | パス、bytes、numpyの配列（高さ×幅、または×3・×4。uint8か0〜1のfloat）、PILの画像 |
| `log_video(key, data)` | パスかbytes。変換はしないので、ブラウザで再生できるmp4（H.264）かwebmにしてください |
| `log_table(key, table)` | `Table(columns, rows)`、pandasのDataFrame、MLflowの`{columns, data}`形式。セルに`Audio`・`Image`・`Video`を置けます |

- keyは1〜250文字です。`/`で区切ると、Artifactの一覧でもフォルダとしてたどれます。ファイルは`media/<key>/step-<step>/`の下に保存します
- 別のRunのファイルを表のセルに置くときは、`artifact_reference(run_id, path)`を使います
- オフライン記録（`mode="offline"`）でも使えます。`mado-tracking sync`がファイルを送ったあとに登録します

## MLflowで記録したもの

MLflowの`log_image(image, key=..., step=...)`で記録した画像と、`log_table`で記録した表も［Media］タブに出ます。MLflowには音声と動画のstep付きの記録が無いので、音声を聴き比べるならPython SDKを使ってください。詳しくは[MLflow 3から記録する](/tracking/mlflow#media)を参照してください。

## Runの［Media］タブで見る

左側に、記録したキーごとの種類（音声・画像・動画・表）、stepの範囲、件数が並びます。キーを選ぶと右側に表示します。

- スライダーで表示するstepを選びます。記録のあるstepにだけ止まります
- スライダーを選んだ状態で矢印キーを押すと前後のstep、Home・Endで最初と最後のstepへ移動します
- 表の音声のセルは［再生］でその場で再生し、［波形］で波形とスペクトログラムを開きます
- 記録が多い場合は、最初の10,000件だけを表示します

音声のビューアでは、波形の拡大、区間のループ、メルと線形のスペクトログラムの切り替えができます（[音声ビューア](/data/audio)）。

## 複数のRunで聴き比べる {#compare-runs}

![比較画面のMediaタブ。Run×stepの表で音声を並べている](/images/tracking-media-compare.png)

1. ［Experiments］の一覧で比べたいRunを選び、［比較］を選びます
2. ［Media］タブを開きます
3. ［比較するキー］で音声などのキーを選びます
4. ［比較するstep］にstepをカンマ区切りで入力し（例: `0, 500, 1000`）、［表示］を選びます。［均等にN列］のボタンを選ぶと、記録のあるstepから最大8個を均等に選んで入力します。空欄か［各Runの最新step］なら、Runごとの最後のstepを1列で並べます

行がRun、列がstepの表ができます。記録の無いセルは「なし」と表示し、近いstepで埋めることはしません。

- セルを選ぶと、表の下に大きく表示します。矢印キーでセルを移動できます
- 音声は同時に1つだけ鳴ります。再生中に別のセルへ移ると、同じ再生位置から続けて再生するので、同じ箇所を聴き比べられます
- 比べられるRunは最初の20件、stepは50個までです
- 1つのstepに同じキーが複数あるときは、最初の1件を表示します
