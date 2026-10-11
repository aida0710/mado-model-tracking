---
title: CLI
description: Python SDKに含まれるmado-tracking（オフライン記録の後送り）とmado-tracking-worker（workerの実行・導入・更新・診断）、API serverの管理コマンド。
---

# CLI

Python SDK（`mado-tracking`パッケージ）には、2つのコマンドが入っています。

| コマンド | 使う場所 | 内容 |
| --- | --- | --- |
| `mado-tracking` | 学習を動かすマシン | オフラインで記録したRunをAPIへ送る |
| `mado-tracking-worker` | workerのホスト | workerの実行、systemdへの導入、更新、状態の確認、診断 |

API serverの管理用のコマンドは、下の「API serverのコマンド」にまとめています。

## インストール

Python 3.11以降が必要です。仮想環境に入れます。

```sh
python3 -m venv ~/.venvs/mado-tracking
~/.venvs/mado-tracking/bin/pip install 'mado-tracking[telemetry]'
~/.venvs/mado-tracking/bin/mado-tracking --help
```

`[telemetry]`を付けると、GPUやCPUの使用率を記録する`psutil`と`nvidia-ml-py`も入ります。社内の配布先やwheelファイルから入れる場合は、`mado-tracking[telemetry]`の部分をそのURLやパスに置き換えます。SDKの使い方は[Python SDK](/tracking/sdk)を参照してください。

## mado-tracking

### mado-tracking sync

APIにつながらない環境で記録したRun（オフライン記録）を、APIへ送ります。途中で失敗しても、もう一度実行すれば続きから送ります。

```sh
export MMT_API_URL=https://tracking.example.com
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN

mado-tracking sync
mado-tracking sync --dry-run
mado-tracking sync ~/runs/offline --project-id <Project ID> --prune
```

| 引数・オプション | 内容 |
| --- | --- |
| `DIR`（複数可） | オフライン記録のディレクトリか、1つのRunのディレクトリ。省略すると`MMT_OFFLINE_DIR`、無ければ`~/.local/share/mado-tracking/offline` |
| `--dry-run` | APIに接続せず、送る内容だけを表示する |
| `--project-id` | このProjectのRunだけを送る |
| `--prune` | 送り終えたRunの記録を消す |

tokenには`runs:write`と`artifacts:write`のscopeが要ります。Runごとに1行、送った内容を表示します。

```text
<Run ID>  completed  batches=3 artifacts=2 present=0 media=0
```

| 2列目 | 意味 |
| --- | --- |
| `completed` | 最後まで送った（`already synced`は前回までに送り終えている） |
| `partial` | 記録は送ったが、Runの終了状態がまだ記録されていない。Runは実行中のまま |
| `recording` | まだ記録中のRunなので飛ばした |
| `failed` | 送信に失敗した。もう一度実行すると続きから送る |
| `pending` | `--dry-run`で、まだ送っていない分がある |
| `filtered` | `--project-id`と違うProjectのRunなので飛ばした |

| 終了コード | 意味 |
| --- | --- |
| 0 | すべて送れた（送るRunが無い場合も0） |
| 1 | 1つ以上のRunで失敗した |
| 2 | 設定の誤り（`MMT_API_URL`や`MMT_API_TOKEN`が無いなど） |

## mado-tracking-worker

workerはAPI serverとは別のプロセスで、Jobを受け取ってSSHの接続先やコンテナで実行します。導入の手順は[worker](/compute/worker)で説明します。ここではコマンドの一覧をまとめます。

```sh
mado-tracking-worker run [--once]
mado-tracking-worker install --api-url <URL> --worker-id <ID> [オプション]
mado-tracking-worker upgrade --worker-id <ID> (--version <バージョン> | --package-spec <指定>)
mado-tracking-worker status --worker-id <ID> [--json]
mado-tracking-worker doctor [--worker-id <ID>] [--ssh-key <パス>] [--known-hosts <パス>]
```

`install`、`upgrade`、`status`、`doctor`には、`--systemd-user`（既定。このアカウントのuser unit）か`--systemd-system`（system unit。rootで実行）を付けられます。

### run

workerを前面で動かします。引数を付けずに`mado-tracking-worker`だけを実行した場合も`run`になります。設定は環境変数から読みます（`MMT_API_URL`、`MMT_API_TOKEN`、`MMT_WORKER_ID`、`MMT_WORKER_TARGET_IDS`、`MMT_WORKER_STATE_DIR`など。[環境変数](/reference/environment)の「worker」）。

| オプション | 内容 |
| --- | --- |
| `--once` | 保持中のJobを回収するか、Jobを1件受け取って終わるまで処理し、終了する |

コンテナでは、`MMT_API_TOKEN_FILE`に置いたファイルからtokenを読みます。

### install

環境変数のファイルとsystemdのunitを書き、`systemctl enable --now`で起動します。tokenは引数では受け取りません。ターミナルでは入力を隠して聞き、パイプなら標準入力から、または`--token-file`のファイルから読みます。

```sh
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.com \
  --worker-id gpu-host-1 \
  --target-ids "<Compute targetのID>"
loginctl enable-linger "$USER"
```

| オプション | 内容 |
| --- | --- |
| `--api-url`（必須） | API serverのURL |
| `--worker-id`（必須） | workerのID。英数字と`.` `_` `-`の64文字まで。再起動や更新をまたいで同じ値を使う |
| `--target-ids` | 担当するCompute targetのID（カンマ区切り）。省略すると許可されたすべて |
| `--state-dir` | 実行中のJobの記録（journal）を置くディレクトリ。入れ直しても同じ場所を使う |
| `--token-file` | tokenを読むファイル |
| `--python` | workerの仮想環境のPython（既定は実行中のPython） |
| `--service-user` | system unitを動かすアカウント |

user unitでは`~/.config/mado-tracking-worker/<worker-id>.env`（mode 600）と`~/.config/systemd/user/mado-tracking-worker@.service`を書きます。ログアウト後も動かすには`loginctl enable-linger`が要ります。system unitでは`/etc/mado-tracking-worker/<worker-id>.env`と`/var/lib/mado-tracking-worker/<worker-id>`を使います。

### upgrade

unitの仮想環境へ新しいバージョンを`pip install --upgrade`で入れ、unitを再起動します。実行中のJobは止まらず、再起動後のworkerが記録から引き継ぎます。pipが失敗したときは再起動しません。

```sh
mado-tracking-worker upgrade --worker-id gpu-host-1 --version 0.2.0
mado-tracking-worker upgrade --worker-id gpu-host-1 --package-spec /path/to/mado_tracking-0.2.0-py3-none-any.whl
```

### status

unitの状態、workerのlock、保持中のJobを表示します。`--json`でJSONを出します。unitが止まっているときは終了コード3です（`systemctl status`と同じ）。

```sh
mado-tracking-worker status --worker-id gpu-host-1
```

### doctor

設定を確かめます。errorがあれば終了コード1です。

```sh
mado-tracking-worker doctor --worker-id gpu-host-1 --ssh-key ~/.ssh/gpu_key --known-hosts ~/.ssh/known_hosts
```

確かめる内容は次のとおりです。

- 環境変数のファイルと記録のディレクトリの権限
- API serverへの到達（`/api/health`）
- tokenのscope（`GET /api/auth/token`。Job限定tokenは使えません）
- `~/.ssh`、秘密鍵（group・otherに権限が無いこと）、known_hosts（group・otherが書き込めないこと）

`--worker-id`を付けると導入済みの環境変数のファイルを読み、付けなければ今の環境変数を読みます。

## API serverのコマンド

API serverのリポジトリで実行します。Docker Composeでは`docker compose run --rm api`に続けて実行します。

| コマンド | 内容 |
| --- | --- |
| `npm run db:migrate` | DBのmigrationを適用する。更新のたびに、APIを入れ替える前に実行する |
| `npm run bootstrap-admin -w @mmt/api` | 初期管理者を作る、または管理者を復旧する（[認証方式とローカルアカウント](/admin/auth)） |
| `npm run preview-worker -w @mmt/api` | 長い音声・動画のプレビューを作るworkerを動かす。ffmpegとffprobeが要る |
| `npm run openapi:generate` | `docs/openapi.json`を作り直す（開発用） |
| `npm run db:seed` | 確認用の見本データを入れる。`AUTH_MODE=development`と`MMT_ALLOW_SEED=true`のときだけ |
