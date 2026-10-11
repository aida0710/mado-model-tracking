---
title: PluginとMado連携
description: 外部サービスとつなぐPluginの仕組みと、MadoのデータセットをRunの入力に使い、lineageをMadoへ送るMado pluginの設定。
---

# PluginとMado連携

Pluginは、このアプリとは別に動くHTTPのサービスです。このアプリのDBには接続せず、決まった形のHTTP APIだけでやり取りします。最初のPluginとして、Madoと連携するMado pluginがあります。

Mado pluginでは、次のことができます。

- Madoのデータセットを検索し、固定したバージョンをこのアプリのDatasetVersionとして取り込む
- Runの開始・完了・失敗・中止と、その入力・出力のデータセットのバージョンを、OpenLineageとしてMadoへ送る
- Madoのストレージの容量メトリクスを見る

PluginのUI部品や任意のJavaScriptは、ブラウザで実行しません。画面はどのPluginでも共通です。

## 役割

| 操作 | 担当 |
| --- | --- |
| Pluginを登録する、接続先やtokenの環境変数名を変える、有効・無効を切り替える | 全体管理者 |
| 接続を確認する、データセットを検索して取り込む、イベントを再送する、容量メトリクスを見る | ProjectのAdmin |

Pluginの登録はProjectごとです。Pluginを使うProjectごとに登録します。

## Mado pluginを動かす

Mado pluginは別のリポジトリ（`mado-model-tracking-plugin-mado`）です。Node.js 22.12以降が必要です。Ubuntuでは、次のコマンドでNode.js 22を入れられます。

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Pluginのリポジトリで依存を入れ、`.env`を用意します。

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

### Madoでkeyを発行する

MadoのSettings → Access → Service Accountsで、用途ごとにkeyを分けて発行します。

| keyのscope | 使う場面 | Pluginの`.env` |
| --- | --- | --- |
| `lineage:read` | データセットとバージョンの検索 | `MADO_READ_TOKEN` |
| `lineage:write` | lineageの送信 | `MADO_LINEAGE_TOKEN` |
| `metrics:read`（任意） | 容量メトリクス | `MADO_METRICS_TOKEN` |

`lineage:read`と`lineage:write`のkeyは、使うNamespaceに限定してください。容量メトリクスはストレージ全体の値なので、Namespaceを設定しません。

### Pluginの`.env`

| 変数 | 設定するもの | 例 |
| --- | --- | --- |
| `MMT_PLUGIN_TOKEN` | このアプリがPluginへ接続するための専用のシークレット。Madoのkeyとは別の値 | `openssl rand -hex 32`で作る |
| `MADO_BASE_URL` | MadoのUI・APIのorigin | `https://mado.example.com/` |
| `MADO_LINEAGE_URL` | OpenLineage APIのorigin。同じなら省略可 | `https://mado-api.example.com/` |
| `MADO_NAMESPACES` | 検索するNamespace。カンマ区切り | `speech` |
| `MADO_JOB_NAMESPACE` | このアプリの実験をMadoへ登録するNamespace | `mado-model-tracking` |
| `MADO_STORAGE_SYSTEM_KEY` | このアプリで作った出力のStorageSystemの識別子 | `mado-model-tracking` |
| `PLUGIN_LEDGER_DIRECTORY` | 送信済みイベントの記録を置く場所。永続ボリュームにする | `./var/events` |
| `HOST`、`PORT` | 待ち受けるアドレスとポート | `127.0.0.1`、`4190` |

起動して、待ち受けを確かめます。

```sh
npm start
```

### このアプリのAPI serverに同じシークレットを置く

API serverの`.env`に、Pluginの`MMT_PLUGIN_TOKEN`と同じ値を置きます。変数名は自由に決められ、Pluginの登録ではその変数名を指定します。値はDBに保存しません。

```sh
# API serverの.env
MMT_MADO_PLUGIN_TOKEN=<PluginのMMT_PLUGIN_TOKENと同じ値>
```

変えたらAPIを再起動します。

## Pluginを登録する（全体管理者）

1. Projectの［Plugins］を開き、［Pluginを登録］を押します。
2. 次の値を入力して保存します。

| 項目 | 入力値の例 |
| --- | --- |
| 名前 | `Mado` |
| 接続先URL | `http://127.0.0.1:4190`。別のコンテナならservice名（`http://mado-plugin:4190`） |
| トークンを参照する環境変数名 | `MMT_MADO_PLUGIN_TOKEN`（英大文字・数字・`_`） |
| 有効 | 選ぶ |

3. ［接続を確認］を押し、Pluginのversionとcapabilitiesが表示されることを確かめます。

接続先URLやtokenの環境変数名を変えると、確認済みの情報は消えます。もう一度［接続を確認］を押してください。tokenの環境変数がAPIのプロセスに無いと、「Pluginのtoken環境変数が設定されていません」（`plugin_token_unavailable`）になります。

Pluginとの通信は、Bearer tokenで認証し、応答は1MiBまで、5秒で打ち切ります。接続先URLを登録できるのは全体管理者だけです。

## Madoのデータセットを取り込む（ProjectのAdmin）

1. ［Plugins］で［データセットを検索］に検索語を入れます。
2. 結果からバージョンを選び、［インポート］を押します。

取り込んだバージョンは［Datasets］に、Madoの外部IDを保ったDatasetVersionとして表示されます。同じバージョンをもう一度取り込んでも、同じDatasetVersionを返します。Runの入力にすると、どのMadoのバージョンを使ったかが記録されます。データセットの扱いは[データセット](/data/datasets)を参照してください。

## lineageの送信と再送

Runの状態が変わると、その変更と同じtransactionで送信待ちのイベントを積みます。Pluginが止まっていても、Runは失敗しません。送信に失敗したイベントは、間隔を空けて再送します。

- 送るイベント: `run.started`、`run.finished`、`run.failed`、`run.canceled`。Runと、入力・出力のDatasetVersionを含みます。
- 終わったRunへ後から出力のDatasetVersionを登録した場合も、その出力を含む完了のイベントを送り直します。
- Pluginは同じイベントIDの再送を重複として扱います。

［Plugins］の「イベントの送信状況」で、未送信の件数、最古の未送信、最多の試行回数、最終エラー、最終送信を確認できます。Pluginを直したら［イベントを再送］を押すと、待ち時間を飛ばしてすぐに再送します。

15分以上未送信のイベントがあるか、5回以上失敗したイベントがあると、運用アラート「Plugin送信の滞留」が開きます（[通知と運用アラート](/admin/notifications)）。

Pluginを無効にしているあいだは送信を止め、新しいイベントも積みません。無効にする前に積んだ未送信のイベントは残り、有効に戻すと送信を再開します。無効のあいだに起きたRunの変化は、あとから送られません。

## Pluginを自作する

Pluginは次のHTTP APIを持つサービスです（plugin protocol 1.0）。認証はBearer tokenです。

| method・path | 内容 |
| --- | --- |
| `GET /manifest` | `id`、`name`、`version`、`protocolVersion:"1.0"`、`capabilities` |
| `POST /datasets/search` | `{query}`を受け取り、`{items: PluginDataset[]}`を返す |
| `POST /events` | Runのイベントを受け取り、`{accepted: true}`を返す |
| `GET /metrics` | `storage:metrics`に対応する場合だけ。Prometheusのテキスト形式 |

`PluginDataset`は`externalId`、`namespace`、`name`、`version`、`uri`、`digest`、`schema`、`metadata`を返します。バージョンの無いデータセットは返しません。イベントはIDで重複を除き、処理できていないイベントに`accepted`を返さないでください。
