---
title: データセット
description: データセットのバージョンを作り、Runの入力と出力に結び付ける。フォルダやRunの出力からバージョンを作り、workerが本体をコンピュータへ用意する。
---

# データセット

![データセットのバージョンとファイル一覧](/images/data-datasets.png)

データセットは、学習や評価に使うデータの集まりです。中身が変わるたびに新しいバージョンを作り、Runには「どのバージョンを使ったか」を記録します。バージョンは作成したあとに変更できないので、あとから同じバージョンで学習や評価をやり直せます。

バージョンの本体は、mado ML TrackingにArtifactとして保存したファイルか、外部の場所を指すURIのどちらかです。Runの入力にしたバージョンは、workerが実行の前にGPUマシンへ用意します。

## こんなときに向いています

- 手元の音声コーパスのフォルダを、そのままバージョンとして登録したい
- 推論の出力を、次の評価の入力に使えるバージョンとして残したい
- どのモデルバージョンがどのデータで学習したかを、Lineageでたどりたい
- GPUマシンからAPIへ直接つながらなくても、学習データをGPUマシンへ送りたい
- Madoで管理しているデータセットのバージョンを、実験の入力に使いたい

## バージョンの種類

| 種類 | 本体 | 作り方 |
| --- | --- | --- |
| Artifactを本体とするバージョン | 保存したArtifactの一覧。バージョンの一覧に「Artifact N件 · サイズ」と表示されます | フォルダから作る、Python SDK、Runの出力 |
| 参照のバージョン | URI（`s3://`、`https://`、`file://`など）とdigest。一覧に「参照（URI）」と表示されます | ［バージョンを作成］、MLflowの`log_input`、Madoからのインポート |

Artifactを本体とするバージョンは、ファイルのパス、SHA-256、サイズの一覧から計算したdigest（`sha256:<hex>`）を持ちます。同じ中身のファイルを上げ直すと、同じdigestになります。URIは`mmt-dataset://<バージョンのID>`です。

1つのバージョンのファイル数は10万件までです。

## データセットを登録する

1. サイドバーの［Datasets］を開きます
2. ［データセットを登録］を押します
3. ［名前］（必須）、［Namespace］、［説明］を入力して保存します

Namespaceは、データセットを分類する名前です（例: `voice`）。［データセットを登録］は、editor以上のユーザーに表示されます。

## フォルダからバージョンを作る

ブラウザで選んだフォルダの中身をArtifactとしてアップロードし、全部の保存が終わったらバージョンを作ります。

1. 一覧でデータセットを選び、［フォルダから作る］を押します
2. ［フォルダを選択］を押すか、フォルダをドロップします
3. 必要なら次の項目を入力します
   - ［バージョン（空なら自動採番）］: 空欄なら、`1`、`2`のように整数で採番します
   - ［親のバージョン］: このバージョンの元になったバージョン
   - ［Metadata（JSON）］: 例`{"language": "ja", "sampleRate": 16000}`
4. ［uploadしてバージョンを作成］を押します

アップロードは[大きなファイルのアップロード](/data/uploads)と同じ方法で送ります。一部のファイルを送れなかった場合は、バージョンを作らずに止まります。［残りのファイルを再送］で送り直すか、［残りのファイルを除いてバージョンを作成］を選びます。バージョンの作成だけが失敗した場合は、［バージョンの作成を再試行］を押します。ファイルを送り直す必要はありません。

作ったバージョンは、一覧で選ぶと「ファイル数」「合計サイズ」とファイルの一覧が表示されます。ファイルを選ぶと、Artifactと同じようにプレビューできます。

## Python SDKでバージョンを作る

`register_dataset`の`files`にフォルダを渡すと、中身をアップロードしてバージョンを作ります。`dataset_id`を省略すると、`name`でデータセットを新しく作ります。

```python
from mado_tracking import Client

with Client() as client:
    version = client.register_dataset(
        "<Project ID>",
        name="speech-corpus",
        namespace="voice",
        files="data/speech",
        metadata={"language": "ja"},
    )
```

既存のデータセットにバージョンを足すだけなら、`upload_dataset_directory`を使います。

```python
from mado_tracking import Client
from mado_tracking.dataset_upload import upload_dataset_directory

with Client() as client:
    version = upload_dataset_directory(
        client, "<Project ID>", "<Dataset ID>", "corpus/",
        version=None,                 # Noneなら整数で自動採番
        metadata={"language": "ja"},
        schema={"sampleRate": 16000},
    )
```

SDKは、ファイルごとにSHA-256とサイズで同じ中身の保存済みArtifactを探し、見つかればアップロードせずにそれを使います。前のバージョンと大半のファイルが同じなら、変わったファイルだけを送ります。途中で止まった場合も、もう一度実行すると保存していないファイルだけを送ります。

`files`を使うときは、`uri`、`digest`、`source_run_id`、`parent_dataset_version_ids`、`external_ref`を指定しません。

## URIを参照するバージョンを作る

ファイルを保存せずに、外部の場所を指すバージョンを作るときは、データセットを選んで［バージョンを作成］を押し、次の項目を入力します。

| 項目 | 入力する値 | 例 |
| --- | --- | --- |
| バージョン | バージョンの名前（必須） | `2026-10` |
| URI | データの場所（必須） | `s3://corpus/speech/2026-10/` |
| Digest | 中身を表すハッシュ（必須） | `sha256:<64桁の16進数>` |
| 親のバージョン | 元になったバージョン | |
| 生成元Run | このバージョンを作ったRun | |
| Schema（JSON）、Metadata（JSON） | 任意のJSON | `{"columns": ["audio", "text"]}` |

## Runの出力からバージョンを作る

推論や前処理のRunが出力したファイルを、そのまま次のRunの入力に使えるバージョンにできます。Runの出力から作ったバージョンは、生成元のRunが記録され、Lineageの「データ出力」の線でつながります。

- Taskで実行するコードでは、`/mmt/outputs/result.json`（version 2）の`datasets`で出力を宣言します。workerが出力ファイルを保存したあとに、整数で採番したバージョンを登録します。宣言はRunごとに64件までです
- Python SDKでは、`run.register_output_dataset(version=, uri=, digest=)`で参照のバージョンを登録します。親のバージョンには、Runの入力のバージョンが入ります
- APIでは、`POST /api/projects/<Project ID>/datasets/<Dataset ID>/versions`の`content`に`{"kind": "artifacts", "fromRunArtifacts": {"runId": "<Run ID>", "prefix": "outputs/audio"}}`を指定すると、RunのArtifactのうち`prefix`の下にあるファイルでバージョンを作ります

`result.json`の書き方は[Taskとコードバージョン](/models/tasks)を参照してください。推論のRunの出力を評価のRunへ自動で渡す方法は[自動実行](/models/automation)にあります。

## Runの入力にする

Taskの実行や自動実行のruleで、入力にするデータセットのバージョンを選びます。workerは実行コードを起動する前に、バージョンの本体をGPUマシンの作業ディレクトリへ用意し、中身を確かめます。

| バージョン | workerが行うこと |
| --- | --- |
| Artifactを本体とするバージョン | ファイルを取得し、digestと各ファイルのSHA-256、サイズを照合します |
| `file://`の参照 | コンピュータにあるパスをそのまま使います。コピーしません |
| `https://`の参照 | 認証なしで1つのファイルを取得します。digestがSHA-256なら照合します |
| `s3://`の参照 | コンピュータの環境変数`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_ENDPOINT_URL_S3`などで認証して取得します |
| `urn:`、`mmt-artifact:`の参照 | 取得しません |

用意できなかった場合（取得の失敗、照合の不一致、対応していないURI）は、実行コードを起動せずにJobを失敗にします。理由はRunの［Logs］に表示されます。

実行コードは、環境変数`MMT_INPUT_DATASET_DIRS`（バージョンのIDとディレクトリのJSON）で本体の場所を知ります。ディレクトリは読み取り専用です。

```python
import json, os, pathlib

for version_id, directory in json.loads(os.environ.get("MMT_INPUT_DATASET_DIRS", "{}")).items():
    for wav in sorted(pathlib.Path(directory).rglob("*.wav")):
        ...
```

DockerやSingularity、Apptainerで動かす場合、本体は`/mmt/datasets/<バージョンのID>`に置かれます。

### コンピュータへの送り方とキャッシュ

Compute targetの編集画面で、［データセットの転送］と［データセットのcache上限（GiB）］を設定します。

| データセットの転送 | 内容 |
| --- | --- |
| workerが中継する（既定） | workerがAPIから取得し、まとめてGPUマシンへ送ります。GPUマシンからAPIへつながらなくても使えます。worker側にも一時的にバージョン1つ分の空き容量が必要です |
| targetがAPIから直接取得する | GPUマシンがJob限定のtokenでAPIから取得します。GPUマシンからAPIへつながる必要があります |

取得した本体は、コンピュータの`<作業ディレクトリ>/.mmt-cache/datasets/`にキャッシュします。同じバージョンを使う次のJobは、取得し直さずにキャッシュを使います。キャッシュの合計がcache上限（既定100 GiB）を超えると、最後に使った日時が古いものから削除します。実行中のJobが使っているバージョンは削除しません。1つのバージョンがcache上限より大きい場合は、Jobを失敗にします。

Compute targetの設定は[Compute target](/compute/targets)を参照してください。

## Madoのデータセットを使う

Mado pluginを登録していると、Madoで管理しているデータセットのバージョンを取り込めます。

1. ［Datasets］の［Madoからインポート］を押します。［Plugins］の画面が開きます
2. ［データセットを検索］で、取り込むデータセットを探します
3. バージョンを選んで［インポート］を押します

取り込んだバージョンは参照のバージョンになり、Madoでの名前、Namespace、バージョンを保ちます。同じバージョンをもう一度取り込んでも、バージョンは増えません。［Madoからインポート］はProject adminに表示されます。

Runが始まったときと終わったときに、Runの入力と出力のバージョンがMadoへ送られます。Madoのデータセットのlineageから、どの実験で使ったかを確かめられます。pluginの登録は[pluginとMado連携](/admin/plugins)を参照してください。

## 使わなくなったデータセット

データセットとバージョンは削除できません。使わなくなったデータセットは、APIの`PATCH /api/projects/<Project ID>/datasets/<Dataset ID>`に`{"archived": true}`を送ってarchiveします。archiveしたデータセットのバージョンを入力にして、新しいRunを作ることはできなくなります。作成済みのRunの記録はそのまま残ります。画面にはarchiveの操作はありません。

バージョンが参照しているArtifactは、バージョンがある限り削除できません。

## 関連するページ

- [大きなファイルのアップロード](/data/uploads)
- [Artifact](/data/artifacts)
- [自動実行](/models/automation)
- [Compute target](/compute/targets)
