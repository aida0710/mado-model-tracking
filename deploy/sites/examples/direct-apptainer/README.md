# スケジューラのないGPUホスト（Apptainer）

SSHで入るGPUサーバーで、Apptainer（またはSingularityCE）でコンテナを動かす例です。スケジューラはなく、job shellはrunnerを起動してすぐ終わります。空いたGPUはrunnerが選びます（`gpu_assignment = "lease"`）。Dockerのimageは、runnerがSIFへ変換して使います。共通の約束は[../../README.md](../../README.md)にあります。

## 用意するもの

- 共用アカウント（例: `mmt`）と、PATHの通った`apptainer`か`singularity`。
- `work_dir`（例: `/data/mmt`）。仕様の置き場、runner、imageの層とSIFのcache、GPUの貸し出しの記録が入るので、十分な空きのあるdiskにします。
- runnerを動かすPython（3.11以上）、`nvidia-smi`、`timeout`（coreutils）、`setsid`（util-linux）。
- launcherから入る鍵。共用アカウントの`authorized_keys`に、launcherの公開鍵だけを置きます。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`TMPDIR` | `/data/mmt/tmp` | `apptainer pull`がSIFを作る作業領域。runnerは`TMPDIR`をApptainerへ渡します。`/tmp`は狭いことが多いので、広いdiskへ向けます |
| `job.sh`の`STOP_GRACE_SECONDS` | `60` | 制限時間のSIGTERMの後、runnerが終わらないときにSIGKILLするまでの秒数 |
| `site.toml`の`gpu_ids` | `[]` | runnerが選んでよいGPU（番号かUUID）。空なら`nvidia-smi`が出す全部です |
| `site.toml` | — | `target_id`、`[sites.connection]`（共用アカウントの`user`と`identity_file`）、`work_dir`、`runner_python`、`runner_api_url`、`max_active_submissions` |

## 動き

- imageの層とSIFのcacheは、runnerが`work_dir`の下に置きます（`APPTAINER_CACHEDIR`も`work_dir`の下に決めます）。SIFはimageのdigestとCPUの組ごとに一度だけ作り、使い回します。
- 選べるGPUより多くを要求するJobや、Apptainerが無いときは、runnerがJobの失敗として報告します。
- runnerは`setsid`で新しいsessionとして起動し、入出力をファイルへ向けるので、SSHが切れても動き続けます。出力は`$MMT_SPEC_DIR/runner.<番号>.log`です。
- 制限時間があれば、`timeout`が時間になったらrunnerへSIGTERMを送ります。制限時間はrunnerの起動から数えるので、GPUの空き待ちとSIFへの変換も含みます。
- registryの認証が要るimageは、`site.toml`の`registry_secret_file`を、runnerが仕様の`secrets.json`経由で`apptainer pull`へ渡します。
- 取消には待ち行列がないので、`cancel_command`は要りません。runnerがheartbeatの応答で取消に気づき、コンテナを止めます。
- 計算機の`supportsArray`は切っておきます（[direct-docker](../direct-docker/README.md)と同じ理由です）。
- 共用アカウントなので、利用者どうしは隔離されません。job shellは管理者だけが書き換えられるようにします。
