# スケジューラのないGPUホスト（Apptainer）

スケジューラのないGPUホスト（SSHで入るGPUサーバーや研究者のPC）で、Apptainer（またはSingularityCE）でコンテナを動かす例です。job shellはrunnerを起動してすぐ終わります。空いたGPUはrunnerが選びます（GPUの渡し方「runnerが選ぶ」）。Dockerのimageは、runnerがSIFへ変換して使います。共通の約束は[../../README.md](../../README.md)にあります。

## 用意するもの

- 共用アカウント（例: `mmt`）と、PATHの通った`apptainer`か`singularity`。
- 作業ディレクトリ（例: `/data/mmt`）。仕様の置き場、runner、imageの層とSIFのcache、GPUの貸し出しの記録が入るので、十分な空きのあるdiskにします。
- runnerを動かすPython（3.11以上）、`nvidia-smi`、`timeout`（coreutils）、`setsid`（util-linux）。Linuxを前提にしています。
- launcherから入るときは、計算機の詳細に出る公開鍵を、共用アカウントの`authorized_keys`に登録します。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`TMPDIR` | `/data/mmt/tmp` | `apptainer pull`がSIFを作る作業領域。runnerは`TMPDIR`をApptainerへ渡します。`/tmp`は狭いことが多いので、広いdiskへ向けます |
| `job.sh`の`STOP_GRACE_SECONDS` | `60` | 制限時間のSIGTERMの後、runnerが終わらないときにSIGKILLするまでの秒数 |

## Webに入れる値

雛形「スケジューラなしのGPUホスト（Apptainer）」を選ぶと、job shell、GPUの渡し方（runnerが選ぶ）、runtime（`apptainer`）が入り、取消コマンドは空、arrayは切った状態になります。そのほかは次の例のように入れます。共用アカウントの計算機なので、利用者がすることはありません。研究者のPCで手動投入にするときは、[direct-docker](../direct-docker/README.md)の「自分のPCで使う」と同じです。

| 全体設定 | 例の値 | 内容 |
|---|---|---|
| 投入方式 | 自動 | launcherがSSHで入って投入します |
| 接続先 | host `gpu-host-2.example.internal`、port 22 | known_hostsにはホストの行を入れます |
| ログインするアカウント | 共用のアカウント、`mmt` | 計算機の詳細に出る公開鍵を、このアカウントの`~/.ssh/authorized_keys`に登録します |
| 作業ディレクトリ | `/data/mmt` | ホストの上の場所。job shellの`TMPDIR`もこの下にします |
| runnerのPython | `/usr/bin/python3` | ホストのPython 3.11以上 |
| runnerから見たAPIのURL | `https://tracking.example.internal` | LANの中のホストなら、trackingのhostnameそのものを使えます |
| 選んでよいGPU | 空 | runnerが選んでよいGPU（番号かUUID）。空なら`nvidia-smi`が出す全部です |
| 1回に受け取る数 | `4` | launcherが1回の巡回で受け取るsubmissionの上限 |

## 動き

- imageの層とSIFのcacheは、runnerが作業ディレクトリの下に置きます（`APPTAINER_CACHEDIR`も作業ディレクトリの下に決めます）。SIFはimageのdigestとCPUの組ごとに一度だけ作り、使い回します。
- 選べるGPUより多くを要求するJobや、Apptainerが無いときは、runnerがJobの失敗として報告します。
- runnerは`setsid`で新しいsessionとして起動し、入出力をファイルへ向けるので、SSHが切れても動き続けます。出力は`$MMT_SPEC_DIR/runner.<番号>.log`です。
- 制限時間があれば、`timeout`が時間になったらrunnerへSIGTERMを送ります。制限時間はrunnerの起動から数えるので、GPUの空き待ちとSIFへの変換も含みます。
- registryの認証が要るimageは、launcherの`registry_secret_file`を、runnerが仕様の`secrets.json`経由で`apptainer pull`へ渡します（手動投入では渡りません）。
- 取消には待ち行列がないので、取消コマンドは要りません。runnerがheartbeatの応答で取消に気づき、コンテナを止めます。
- 計算機のarrayは切っておきます（[direct-docker](../direct-docker/README.md)と同じ理由です）。
- 共用アカウントでは、利用者どうしは隔離されません（job shellとrunnerは共用アカウントの権限で動きます）。job shellを変えられるのは、計算機の所有者と全体管理者だけです。
