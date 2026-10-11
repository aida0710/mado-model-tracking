# スケジューラのないGPUホスト（Docker）

スケジューラのないGPUホスト（SSHで入るGPUサーバーや研究者のPC）で、Dockerでコンテナを動かす例です。job shellはrunnerを起動してすぐ終わります。空いたGPUはrunnerが選びます（GPUの渡し方「runnerが選ぶ」）。共通の約束は[../../README.md](../../README.md)にあります。

## 用意するもの

- 共用アカウント（例: `mmt`）。docker groupに入れ、`docker info`が通るようにします。Docker daemonはローカルのUnix socketで使います（runnerがbind mountを使うため）。
- 作業ディレクトリ（例: `/data/mmt`）。仕様の置き場、runner、cache、GPUの貸し出しの記録が入るので、十分な空きのあるdiskにします。
- runnerを動かすPython（3.11以上）、`nvidia-smi`、`timeout`（coreutils）、`setsid`（util-linux）。Linuxを前提にしています。
- launcherから入るときは、コンピュータの詳細に出る公開鍵を、共用アカウントの`authorized_keys`に登録します。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`STOP_GRACE_SECONDS` | `60` | 制限時間のSIGTERMの後、runnerが終わらないときにSIGKILLするまでの秒数 |

## Webに入れる値

雛形「スケジューラなしのGPUホスト（Docker）」を選ぶと、job shell、GPUの渡し方（runnerが選ぶ）、runtime（`docker`）が入り、取消コマンドは空、arrayは切った状態になります。そのほかは次の例のように入れます。共用アカウントのコンピュータなので、利用者がすることはありません。

| 全体設定 | 例の値 | 内容 |
|---|---|---|
| 投入方式 | 自動 | launcherがSSHで入って投入します。launcherから入れないPCは下の「自分のPCで使う」 |
| 接続先 | host `gpu-host-1.example.internal`、port 22 | known_hostsにはホストの行を入れます |
| ログインするアカウント | 共用のアカウント、`mmt` | コンピュータの詳細に出る公開鍵を、このアカウントの`~/.ssh/authorized_keys`に登録します |
| 作業ディレクトリ | `/data/mmt` | ホストの上の場所 |
| runnerのPython | `/usr/bin/python3` | ホストのPython 3.11以上 |
| runnerから見たAPIのURL | `https://tracking.example.internal` | LANの中のホストなら、trackingのhostnameそのものを使えます |
| 選んでよいGPU | `0`〜`3`（1行に1つ） | runnerが選んでよいGPU（番号かUUID）。空なら`nvidia-smi`が出す全部です |
| 1回に受け取る数 | `8` | launcherが1回の巡回で受け取るsubmissionの上限 |

## 自分のPCで使う

launcherから入れないPCは、自分のコンピュータとして追加し、投入方式を手動にします（接続先とアカウントは要りません。PCの上で`mado-tracking submit`を実行した人のアカウントで動きます）。作業ディレクトリ・runnerのPython・選んでよいGPUは上と同じように入れます。

```sh
export MMT_API_URL=https://tracking.example.org MMT_API_TOKEN=<自分のAPI token>
mado-tracking submit --site <コンピュータのID> --watch        # 止めるまで、待っている自分のJobを投入する
mado-tracking submit --site <コンピュータのID> --watch --all  # 共有したProjectのメンバーのJobも投入する
```

`--all`のJobも、PCの所有者のアカウントで動きます。共有するProjectは、そのメンバーのコードを自分のPCで動かしてよい範囲にしてください。`--all`で受け取るのは、使ったtokenのProjectのJobだけです（書き込みのtokenはProjectごとに作るため）。複数のProjectに共有したときは、Projectごとにそのtokenで`--watch --all`を動かします。

## 動き

- runnerは、ホスト全体のlockの下で空いたGPUを選びます。動いているMadoのコンテナが持つGPUも使用中と数えるので、runnerが落ちた後に残ったコンテナのGPUを二重に貸しません。
- 選べるGPUより多くを要求するJobや、Dockerに届かないときは、runnerがJobの失敗として報告します。
- runnerは`setsid`で新しいsessionとして起動し、入出力をファイルへ向けるので、SSHが切れても動き続けます。出力は`$MMT_SPEC_DIR/runner.<番号>.log`です。
- 制限時間があれば、`timeout`が時間になったらrunnerへSIGTERMを送ります。制限時間はrunnerの起動から数えるので、GPUの空き待ちも含みます。
- 取消には待ち行列がないので、取消コマンドは要りません。runnerがheartbeatの応答で取消に気づき、コンテナを止めます。
- コンピュータのarrayは切っておきます。launcherがarrayの全員を1つずつ投入します。入れた場合も、このjob shellはrunnerを人数分起動し、それぞれがGPUの空きを待ちます。
- 共用アカウントでは、利用者どうしは隔離されません（job shellとrunnerは共用アカウントの権限で動きます）。job shellを変えられるのは、コンピュータの所有者と全体管理者だけです。
