# Plugin契約 v1.0

pluginは本体から独立したHTTP serviceです。別リポジトリで管理し、DBへ直接アクセスしません。全体管理者がProjectごとにサービスURLとtokenの環境変数名を登録します。Project adminは登録済みの接続を検査し、検索・取り込み・再送・metrics取得を行います。token本文をDBへ保存しません。認証はBearer token、responseは1MiB以内、timeoutは5秒です。

## エンドポイント

| method/path | 内容 |
| --- | --- |
| `GET /manifest` | `id,name,version,protocolVersion:"1.0",capabilities:string[]` |
| `POST /datasets/search` | `{query:string}` → `{items:PluginDataset[]}` |
| `POST /events` | PluginEvent → `{accepted:true}` |
| `GET /metrics` | `storage:metrics`対応時。Prometheus text形式 |

`PluginDataset`は`externalId,namespace,name,version,uri,digest,schema,metadata`を返します。バージョンがないdatasetは返しません。本体へのimportは外部IDを保持し、同じバージョンを再importしたら同じDatasetVersionを返します。digestがcontent hash以外の場合は値の意味をplugin側で明示します。

`PluginEvent`にはUUIDのid、Runの状態、timestamp、Project ID、Run、input/output DatasetVersionが入ります。種類は`run.started`/`run.finished`/`run.failed`/`run.canceled`。本体はRunの状態変更とoutbox保存を同じDB transactionで行います。通信失敗はbackoffして再送します。pluginはevent IDを使って重複を処理し、成功していないイベントをacceptedにしないでください。

終了後のRunへ出力DatasetVersionを登録した場合も、その出力を含む新しい完了eventを同じtransactionで保存します。Runの終了時刻は保持します。Madoから取り込んだバージョンのidentityは維持し、本体のデータセットはProject IDを含むnameで別Projectの同名・同バージョンと区別します。

PluginのUI部品や任意のJavaScriptはブラウザで実行しません。画面は共通のデータセット検索・import・接続検査・再送・metrics表示を提供します。将来の実行backend拡張はprotocol versionとcapabilityを追加して設計します。

## Mado plugin

別リポジトリ`mado-model-tracking-plugin-mado`に実装します。Mado側では用途ごとにService Account keyを分けます。

| key scope | 使用するAPI |
| --- | --- |
| `lineage:read` | `/api/mado/lineage/catalog`、dataset/versionsの参照 |
| `lineage:write` | `/api/openlineage/v1/lineage` |
| `metrics:read` | `/api/mado/metrics/capacity` |

read/write keyは許可Namespaceを限定します。metricsはstorage全体の値なのでNamespaceを設定しません。本体の`MMT_MADO_PLUGIN_TOKEN`とpluginの`MMT_PLUGIN_TOKEN`は同じ値にし、Mado用keyとは分けます。

Mado API拡張の変更はMadoリポジトリの`feat/model-tracking-api`branchにあります。本番Madoへ適用したものではありません。詳細はそのリポジトリの`docs/model-tracking-api.md`を参照してください。
