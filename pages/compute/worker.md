---
title: workerの導入と常駐
description: Jobを実行するworkerをworkerのマシンに入れ、systemdで常駐させる。tokenの用意、install・status・doctor・upgradeのCLI、実行コードに渡すJob限定token。
---

# workerの導入と常駐

workerは、API serverからJobを受け取り、Compute targetへSSHで接続してコードを実行するプロセスです。実行中のログ、メトリクス、出力ファイルをAPI serverへ送り、終わったらJobの結果を報告します。

workerはAPI serverとは別のマシンに置けます。SSHの秘密鍵はworkerのマシンだけに置き、API serverには持たせません。導入、更新、状態の確認は、workerのマシンで`mado-tracking-worker`コマンドを使って行います。

```text
API server ← worker（SSH鍵・known_hosts・worker token） → Compute target（GPUマシン）
```

## こんなときに向いています

- GPUマシンでJobを動かすworkerを、ログアウトや再起動の後も動かし続けたい
- workerを更新しても、実行中の学習を止めたくない
- tokenや鍵の権限の設定ミスを、Jobを流す前に見つけたい

## 必要なもの

- Linux（Ubuntuで確認しています）
- Python 3.11以上、`venv`、`pip`、OpenSSH client、Git
- workerのマシンからAPI serverへ届くこと
- Compute targetからもAPI serverへ届くこと。実行中のコードがメトリクスを記録するためです。SSHの接続先でworkerのマシンの`127.0.0.1`を指定しても、そのAPIには届きません

Ubuntuでは次のコマンドで入れられます。

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip openssh-client git
python3 --version
```

## 1. worker用のtokenを用意する

workerのtokenは、人に紐付かないService Accountで発行します。発行した人がProjectを離れても止まりません。作業はProject adminがWebの画面で行います。

1. ［プロジェクト設定］を開き、［Service Accounts］の［Service Accountを作成］を押します。
2. ［名前］に`gpu-host-1-worker`のような名前、［Role］に`Admin`を指定して保存します。`worker:execute` scopeは、RoleがAdminのService Accountにだけ発行できます。
3. 作成した行の［API tokenを発行］を押し、scopeと有効期限を選びます。

| scope | 必要な場面 |
| --- | --- |
| `read` | 必須。入力データセットの一覧の取得などに使います |
| `worker:execute` | 必須。Jobの受け取りと結果の報告に使います |
| `artifacts:write` | 必須。実行前のコードと、出力ファイルの保存に使います |
| `registry:write` | `result.json`（version 2）で出力モデル・データセットを宣言するJobがある場合 |

有効期限の上限は365日です。

4. 表示されたtokenを、次の手順の入力に使います。tokenは一度だけ表示されます。

Service AccountとAPI tokenの詳細は[API tokenとService Account](/admin/tokens)を参照してください。

## workerをインストールする {#install-the-worker}

workerのマシンでターミナルを開き、worker専用のvenvへPythonパッケージ`mado-tracking`を入れます。ここではGitHubのリポジトリから入れる例を示します。社内の配布先やwheelファイルがある場合は、`pip install`の引数をそれに置き換えてください。

```bash
git clone https://github.com/aida0710/mado-ml-tracking.git ~/mado-ml-tracking
python3 -m venv ~/.local/share/mado-tracking-worker/venv
~/.local/share/mado-tracking-worker/venv/bin/pip install "$HOME/mado-ml-tracking/python[telemetry]"
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker --help
```

`telemetry`を付けると、GPU使用率などのsystem metricsも採取します。

## 2. systemdで常駐させる

`install`は、設定ファイルとsystemdのunitを書き、workerを起動します。

```bash
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.internal \
  --worker-id gpu-host-1 \
  --target-ids "<targetのID>"
loginctl enable-linger "$USER"
```

| 引数 | 入力例 | 内容 |
| --- | --- | --- |
| `--api-url` | `https://tracking.example.internal` | API serverのURL |
| `--worker-id` | `gpu-host-1` | workerの名前。再起動や更新の後も同じ値を使います。英数字、`.`、`_`、`-`で64文字まで |
| `--target-ids` | targetのID | このworkerが担当するCompute targetのID。複数あればカンマで区切ります |
| `--token-file` | `/path/to/token` | tokenをファイルから読むとき。省略するとターミナルで入力します |
| `--state-dir` | | 実行中のJobの記録を置くディレクトリ。通常は省略します |

実行すると、tokenの入力を求められます。入力した文字は表示されません。tokenをコマンドの引数に書かないでください。

`--target-ids`は省略できますが、省略したworkerは［接続を確認］を受け取りません（[Compute target](/compute/targets#check-the-connection)）。targetのIDは、Webにログインしたブラウザで`https://tracking.example.internal/api/targets`（WebのURLの後ろに`/api/targets`）を開くと、各targetの`id`として表示されます。

`loginctl enable-linger`は、ログアウトした後もuserのunitを動かし続けるための設定です。

`install`が行うことは次のとおりです。

- `~/.config/mado-tracking-worker/<worker-id>.env`を権限600で書きます。API URL、worker ID、target、state directory、tokenが入ります。
- `~/.config/systemd/user/mado-tracking-worker@.service`を書き、`mado-tracking-worker@<worker-id>.service`を有効にして起動します。
- state directoryは`~/.local/state/mado-tracking-worker/`の下に作ります。手でworkerを起動していた場合も同じ場所を使うので、実行中のJobの記録を引き継ぎます。

### system unitにする場合

専用のユーザーで動かすときは、rootで`--systemd-system --service-user <ユーザー名>`を付けます。設定ファイルは`/etc/mado-tracking-worker/<worker-id>.env`（root、権限600）、state directoryは`/var/lib/mado-tracking-worker/<worker-id>`（そのユーザーの所有、権限700）になります。手で置く場合のunitの雛形は、リポジトリの`deploy/worker/mado-tracking-worker@.service`と`deploy/worker/worker.env.example`です。

## 3. 動いていることを確かめる

```bash
WORKER=~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker
$WORKER doctor --worker-id gpu-host-1 --ssh-key ~/.ssh/mmt_worker_ed25519 --known-hosts ~/.ssh/mmt_known_hosts
$WORKER status --worker-id gpu-host-1
journalctl --user -u mado-tracking-worker@gpu-host-1 -f
```

| コマンド | 確かめること |
| --- | --- |
| `doctor` | 設定ファイルとstate directoryの権限、APIへの到達、tokenのscope、`~/.ssh`・秘密鍵・known_hostsの権限。問題があれば終了コード1 |
| `status` | unitの状態、workerのlock、保持しているJob。止まっていれば終了コード3 |
| `journalctl` | workerのログ |

最後に、WebのComputeの［Workers］に、workerの版とホスト名が「オンライン」で表示されることを確かめます。

## 4. 更新する

```bash
git -C ~/mado-ml-tracking pull
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker upgrade \
  --worker-id gpu-host-1 --package-spec "$HOME/mado-ml-tracking/python[telemetry]"
```

社内の配布先から版を指定して入れる場合は、`--package-spec`の代わりに`--version 0.2.0`のように指定します。

`upgrade`は、unitが使っているvenvへパッケージを入れてから、unitを再起動します。

- 実行中のJobは止まりません。unitは`KillMode=process`なので、workerの再起動・停止・更新では実行中のコードを止めず、再起動したworkerが記録から引き継ぎます。
- `pip`が失敗したら、再起動しません。
- unitが止まっているのに、手で起動したworkerがstate directoryを使っている場合は、何もせずに止まります。

### tokenを差し替える

期限が近づいたら新しいtokenを発行し、ファイルに保存して`install`をもう一度実行します。

```bash
install -m 600 /dev/null ~/worker-token
read -rsp 'Worker API token: ' TOKEN && printf '%s\n' "$TOKEN" > ~/worker-token && unset TOKEN
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.internal --worker-id gpu-host-1 \
  --target-ids "<targetのID>" --token-file ~/worker-token
rm ~/worker-token
```

古いtokenは、Projectの［Projectのtoken一覧］で失効させます。Service Accountを［無効化］すると、そのService Accountのtokenは次の要求からすべて使えなくなります。

## 手で起動して試す

常駐させる前に試すときは、ターミナルで直接起動できます。

```bash
export MMT_API_URL=https://tracking.example.internal
export MMT_WORKER_ID=gpu-host-1
export MMT_WORKER_TARGET_IDS="<targetのID>"
export MMT_WORKER_STATE_DIR="$HOME/.local/state/mmt-worker-manual"
read -rsp 'Worker API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker
```

`--once`を付けると、Jobを1件処理して終了します。同じstate directoryでworkerを2つ起動すると、後から起動した方を拒否します。

## Docker Composeで動かす

SSHのtargetだけを使うworkerは、リポジトリのDocker Composeでも動かせます。

```bash
docker compose --profile worker up -d worker
docker compose --profile worker run --rm worker doctor
```

- token: `./var/worker-token`（`MMT_WORKER_TOKEN_FILE`で変更）をDocker secretとして渡します。
- 鍵とknown_hosts: `./var/worker-ssh`（`MMT_WORKER_SSH_DIR`）をコンテナの`/home/worker/.ssh`へ読み取り専用でmountします。targetの［SSH鍵のパス］［known_hostsのパス］は、コンテナ内のパスで登録します。
- state: volume`worker-state`です。消すと実行中のJobを引き継げなくなります。

## 実行コードにはJob限定tokenを渡す

workerは、自分のtokenを実行コードに渡しません。代わりにAPI serverがJobごとに発行するJob限定token（`mmtj_`で始まる）を、実行コードの`MMT_API_TOKEN`と`MLFLOW_TRACKING_TOKEN`に入れます。実行コードは、Python SDKもMLflow 3 SDKも、そのままこのtokenで記録できます。

- 権限は、Runを作った人の現在の権限です。その人をProjectから外すと、実行中のコードからの記録も拒否されます。
- 書き込めるのは、そのJobのRun（メトリクス、パラメータ、タグ、ログ、入力データセット、Artifact）と、そのRunを生成元とするモデル・データセットの版だけです。
- 同じProjectのほかのRunへの書き込み、tokenの発行、Projectの設定、自動実行ルールの変更はできません。読み取りは同じProjectの中ならできます（上流RunのArtifactの取得など）。
- Jobが終わる（完了、失敗、中止）と、そのtokenは使えなくなります。

tokenはworkerのstate directory（権限700、ファイルは600）に保存します。workerを再起動しても、実行中のJobは同じtokenを使い続けます。

## 実行コードに渡すもの {#what-the-code-receives}

workerは、実行コードに次の環境変数を渡します。コンテナでは、パスもコンテナ内のものになります。

| 環境変数・パス | 内容 |
| --- | --- |
| `MMT_API_URL`、`MMT_API_TOKEN` | API serverのURLとJob限定token |
| `MLFLOW_TRACKING_URI`、`MLFLOW_TRACKING_TOKEN` | MLflow 3 SDK用の接続先とJob限定token |
| `MMT_RUN_ID` | このJobのRun。Python SDKの`start_run()`を引数なしで呼ぶと、このRunへ記録します |
| `/mmt/inputs`、`MMT_MODEL_FILE` | 取得済みのモデルの重み（読み取り専用） |
| `MMT_PARAMETERS_FILE` | パラメータのJSON |
| `MMT_INPUT_DATASET_DIRS` | 入力データセット版ごとの、取得済みの本体のディレクトリ（JSON） |
| `MMT_DATASET_VERSIONS_FILE` | 入力データセット版の情報 |
| `MMT_UPSTREAM_RUN_ID`、`MMT_UPSTREAM_RUN_FILE` | 上流Run（[ルールの連鎖](/models/automation#chain-evaluation-after-inference)のとき） |
| `MMT_RESUME_CHECKPOINT_DIR`など | 再開元のcheckpoint（[学習の途中再開](/models/checkpoints)のとき） |
| `/mmt/source` | 追加のソース（コンテナで、ソースを指定したとき。読み取り専用） |
| `/mmt/outputs`、`MMT_OUTPUTS_DIR` | 出力ファイルを書く場所 |
| `MMT_RESULT_FILE` | SDKを使わない実行の完了の宣言（`result.json`）を書くパス |

### SDKを使わずに結果を返す

SDKを入れていないコンテナでは、出力を`/mmt/outputs`に書き、最後に`result.json`を書きます。workerは終了後に宣言とファイルを照合し、ファイルをRunのArtifact`container/<path>`として保存します。

```json
{
  "version": 2,
  "complete": true,
  "artifacts": [{"path": "model/weights.bin", "sha256": "<64桁のhex>", "size": 1048576}],
  "metrics": [{"name": "train.loss", "value": 0.12, "step": 100}],
  "models": [{"path": "model/weights.bin"}]
}
```

- `sha256`と`size`は実際のファイルと一致させます。すべての出力を書き終えてから`result.json`を書きます。
- `models`で宣言した重みは、モデルの版として登録します。宣言できるのは学習とファインチューニングのRunだけで、workerのtokenに`registry:write`が必要です。
- `datasets`には`{datasetId, path, digest}`を書くと、出力をデータセット版として登録します。推論の出力を評価へ渡すときに使います。
- 出力ファイルが数千件あるときは、`result.json`に並べず、1行に1件`{"path","sha256","size"}`を書いたJSON Linesのファイルを`"artifactsManifest": "artifacts.jsonl"`で指します。

| 上限 | 値 |
| --- | --- |
| 出力ファイル数 | 10000（workerの`MMT_WORKER_MAX_OUTPUT_FILES`で変更） |
| `result.json` | 1MiB |
| メトリクス | 1000点 |
| `models`、`datasets` | 16件、64件 |

## 接続が切れたとき、止めたとき

- workerとtargetのSSHが切れても、targetの上でコードは動き続けます。workerは再接続して同じJobに戻り、続きのログを送ります。同じJobを二重に起動することはありません。
- workerを再起動しても、state directoryの記録から実行中のJobを引き継ぎます。state directoryを消さないでください。
- Jobを止めるのは、Jobsの［停止を要求］だけです。workerは実行中のプロセスにSIGTERMを送り、10秒で終わらなければSIGKILLで止めてから、Jobを「中止」で終えます。
- Jobのheartbeatが60秒途絶えると、Jobsに「応答なし」を表示します。Jobの状態とGPUの予約は変えません。workerのマシンで状態を確かめてから、停止や再実行を手で行ってください。
- workerの応答が120秒途絶えると、Computeの［Workers］で「オフライン」になります。通知で受け取るには、Projectの通知ルールで`worker.offline`を選びます（[通知](/admin/notifications)）。
