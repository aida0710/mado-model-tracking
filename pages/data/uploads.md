---
title: 大きなファイルのアップロード
description: 大きなArtifactを分割して送り、途中で止まっても続きから再開する。ブラウザ、Python SDK、worker、MLflow SDKのそれぞれの方法。
---

# 大きなファイルのアップロード

![Artifactをアップロードするダイアログ](/images/data-uploads-dialog.png)

数GBを超える重みや音声データは、1回のリクエストで送ると、途中で通信が切れたときに最初から送り直しになります。mado ML Trackingでは、大きなファイルを決まった大きさのpartに分けて送り、途中で止まっても受信済みのpartを飛ばして続きから送れます。

ブラウザ、Python SDK、workerは、ファイルの大きさに応じて自動でこの方法を使います。MLflow SDKからは、MLflowのmultipart uploadで同じように分割して送れます。

## こんなときに向いています

- 数十GBのcheckpointや音声コーパスを、ブラウザから登録したい
- 学習の出力を送っている途中でネットワークが切れても、最初からやり直したくない
- フォルダごと、構成を保ったままアップロードしたい
- MLflow SDKの`log_artifact`で、大きなファイルを送りたい

## 送り方の決まり

| 送り元 | 分割して送る大きさ | partの大きさ | 同時に送る数 |
| --- | --- | --- | --- |
| ブラウザ | 8 MiB以上 | 16 MiB | 全体で3本 |
| Python SDK、worker | 64 MiB以上 | 16 MiB | 1ファイルにつき4本 |
| MLflow SDK | 既定で500 MiB以上 | 既定で10 MiB | SDKの設定どおり |

partの数は1ファイルにつき10,000までです。ブラウザとPython SDKは、partの数が10,000を超える大きなファイルでは、partを自動で大きくします。1件の上限は既定で200 GiBです。

すべてのpartがそろうと、APIがファイル全体のSHA-256とサイズを計算して確かめてから、Artifactとして登録します。送る前に計算したSHA-256と一致しない場合は登録しません。大きなファイルでは、この確認に数十分かかることがあります。

途中のアップロードは、開始から7日で期限が切れます。期限が切れたアップロードと、受信済みのpartは自動で削除されます。

::: warning
保存先の設定で［Multipart uploadを使う］をオフにしている場合、分割したアップロードは使えません。[保存先の設定](/data/storage#storage-without-multipart-support)を参照してください。
:::

## ブラウザからアップロードする

1. Runの［Artifacts］タブで［Artifactをアップロード］を押します。Runに属さないファイルは、［Models］や［Code］の画面のアップロードから送ります
2. ［ファイルを選ぶ］か［フォルダを選ぶ］を押すか、ダイアログにファイルやフォルダをドロップします
3. 1つのファイルなら［保存パス］を、複数のファイルなら［保存先フォルダ］を入力します。フォルダを選んだときは、フォルダ内の構成を保ったまま、指定したフォルダの下に置きます
4. ［アップロードを開始］を押します

「アップロードの進み具合」に、ファイルごとの状態、速度、残り時間が表示されます。

| 操作 | 内容 |
| --- | --- |
| 一時停止 | 新しいpartの送信を止めます。8 MiB未満のファイルでは表示されません |
| 再開 | 一時停止したファイルや失敗したファイルを、続きから送ります |
| 取消 | アップロードを中止し、サーバーが受信したpartも削除します |
| 失敗したファイルを再送 | 失敗したファイルをまとめて送り直します |

partの送信に失敗すると、1秒から最大30秒まで待ち時間を延ばしながら、1つのpartにつき5回まで試します。完了すると`artifact://<Artifact ID>`が表示され、コピーしてモデル版の登録などに使えます。

送信中はダイアログを閉じられません。閉じるときは、一時停止するか取消してから閉じてください。

### 再読み込みしたあとに続きから送る

ブラウザを再読み込みしたり、タブを閉じたりしても、サーバーには受信済みのpartが残っています。

1. 同じRunで［Artifactをアップロード］を開きます
2. 「途中のアップロード」に、続きを送れるアップロードと期限が表示されます
3. 同じファイルを選び、同じ保存パスで［アップロードを開始］を押します

ファイルの名前、サイズ、更新日時が前回と一致すれば、受信済みのpartを飛ばして続きから送ります。続きを送らないアップロードは［破棄］で削除します。

## Python SDKからアップロードする

`log_artifact`と`log_artifacts`は、64 MiB以上のファイルを自動で分割して送ります。

```python
import mado_tracking

with mado_tracking.start_run(
    project_id="<Project ID>", experiment_id="<Experiment ID>", name="学習",
) as run:
    run.log_artifact("checkpoints/model.pt", path="checkpoints/model.pt")
    run.log_artifacts("outputs/audio", path="audio")
```

途中で止まった場合は、同じファイルで同じ処理をもう一度実行します。SDKは送信中のアップロードを`~/.cache/mado-tracking/uploads/`（`XDG_CACHE_HOME`を設定している場合はその下）に記録しています。もう一度実行すると、サーバーが受信済みのpartを確かめて、足りないpartだけを送ります。送信中にファイルが変わった場合はエラーになるので、もう一度実行して新しい内容を送ります。

通信の失敗、HTTPの408、429、500、502、503、504は、0.25秒から最大5秒まで待ち時間を延ばしながら4回まで再試行します。

SDKの接続先とtokenの設定は[Python SDK](/tracking/sdk)を参照してください。

## workerの出力

workerは、Jobが出力したファイルをRunのArtifactとして保存します。64 MiB以上のファイルは、Python SDKと同じ方法で分割して送ります。workerが途中で再起動しても、受信済みのpartを飛ばして続きから送ります。

GPU計算機からworkerへの出力の回収が300秒止まった場合は、まだ確認できていないファイルだけを取り直します。workerのプロセスが異常終了した場合は、直前の1秒間に保存したファイルを送り直すことがあり、そのときは同じ内容のArtifactの版が1つ増えます。

## MLflow SDKのmultipart upload

公式のMLflow 3 SDKからは、MLflowのmultipart uploadで分割して送れます。途中のpartが失敗した場合、SDKはファイル全体ではなく、そのpartだけを送り直します。

- MLflow 3.17以降のSDKは、サーバーの設定を読んで自動でmultipart uploadを使います
- MLflow 3.0〜3.16のSDKでは、環境変数`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`を設定します

```sh
export MLFLOW_TRACKING_URI=https://mmt.example.com
export MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true
export MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE=33554432   # 32 MiB
export MLFLOW_HTTP_REQUEST_TIMEOUT=600
```

| 環境変数 | 内容 |
| --- | --- |
| `MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE` | 分割して送るファイルの大きさ。SDKの既定は500 MiB |
| `MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE` | partの大きさ。既定は10 MiBで、5 MiB以上にします。200 GiBのファイルでは21 MiB以上にします |
| `MLFLOW_HTTP_REQUEST_TIMEOUT` | SDKが応答を待つ秒数。既定は120秒 |

最後のpartを送ったあと、SDKはAPIがファイル全体を確かめて登録するまで待ちます。API側で待つのは既定で100秒までで、超えると503が返ります。その場合もAPIは確認を続け、終わればArtifactの一覧に表示されます。数十GBのファイルを送る環境では、`MLFLOW_HTTP_REQUEST_TIMEOUT`とAPIの`MMT_UPLOAD_FINALIZE_WAIT_MS`を大きくしてください。

MLflow SDKの接続とtokenの設定は[MLflow 3 SDKから記録する](/tracking/mlflow)を参照してください。

## APIで直接送る

SDKを使わずに送る場合は、次の順にAPIを呼びます。どのリクエストも、アップロードを作成したときと同じ認証情報で送ります。

| 手順 | API |
| --- | --- |
| アップロードを作成 | `POST /api/projects/<Project ID>/artifact-uploads`（`path`、`runId`、`expectedSize`、`expectedSha256`、`partSize`） |
| partを送る | `PUT /api/projects/<Project ID>/artifact-uploads/<upload ID>/parts/<番号>`。ヘッダー`X-Part-SHA256`でpartのSHA-256を確かめられます |
| 受信済みのpartを確かめる | `GET /api/projects/<Project ID>/artifact-uploads/<upload ID>` |
| 完了 | `POST /api/projects/<Project ID>/artifact-uploads/<upload ID>/complete` |
| 中止 | `DELETE /api/projects/<Project ID>/artifact-uploads/<upload ID>` |

`partSize`は5 MiB〜5 GiBで、既定は16 MiBです。最後以外のpartは`partSize`ちょうど、最後のpartは残りのバイト数ちょうどで送ります。完了を送ると状態が「検証中」（`verifying`）になり、確認が終わると「完了」（`completed`）になります。登録したArtifactのIDは、アップロードのIDと同じです。

## 関連するページ

- [Artifact](/data/artifacts)
- [保存先の設定](/data/storage)
- [データセット](/data/datasets)
