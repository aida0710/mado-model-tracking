# 外部実行の設計案

状態：設計案（未実装）。2026-10-09までの議論をまとめたものです。実装した部分は、[worker.md](../worker.md)や[containers-automation.md](../containers-automation.md)などの手順書へ移し、この文書からは外します。

## 目的

- モデル版の登録時だけでなく、決めたきっかけ（フック）でコードを実行できるようにする。
- 実行はコンテナだけにする。実行先には、DockerかSingularity/Apptainerがあればよい。
- trackingと外部実行を分ける。trackingは、計算機やスパコンの事情を知らない。
- SSHで入るGPUサーバーと、いろいろなスパコンで動かす。OTPが必要なサイトや、CPUがArmのサイトも含む。
- 音声・動画・テキストの合成データを大量に作り（例：音声3000時間）、段階の間で受け渡す。

## 決めたこと

| 項目 | 決めたこと |
|---|---|
| パイプライン（DAG） | 作らない（保留）。フック、ドライバー、起動の経緯の記録で代わりにする |
| 実行の形 | コンテナだけにする。Python runtime（Jobごとのvenv）はやめる |
| 実行先 | SSHで入るGPUサーバー（Docker）と、スケジューラのあるスパコン（Singularity/Apptainer）の混在 |
| 実行先の設定 | 計算機ごとに、全体設定と個人設定を持つ |
| 資源の指定 | 対応表を持たない。計算機ごとのjob shellが、スケジューラの書き方に直す |
| 課金グループ | 持たない。必要なサイトでは、job shellに変数で渡す |
| Dockerの計算機 | 共用アカウントで動かす。利用者どうしの隔離はしない |
| OTPのあるサイト | 本人がログインして`mmt submit`で投入する。ログインノードには何も常駐させない |
| 状態の監視 | runnerが計算ノードからtrackingへ直接報告する。SSHでの監視はやめる |
| runner用API | 別のホスト名で公開する。受け付けるのは決めたpathとJob用tokenだけ |
| S3 | trackingが発行する署名付きURL（presigned URL）で、計算ノードから直接読み書きする |
| コードとimage | Forgejoを同梱する（git repo、branch、外部とのmirror、container registry、SSO） |
| imageのbuild | 各自のPCでbuildしてpushする。x86とArmの両方で使うならmulti-archにする |
| SFTP | 作らない |
| 人ごとの違い | job shellは1本にして、人ごとの値は変数で渡す。branchはコードの試行に使う |
| ドライバー | 利用者のコードから子Jobを作ることを認める（上限付き） |
| フック | 研究者全員が作れる。作った人の権限で動く |

## 今の実装（出発点）

- **自動実行**：きっかけは`model_registered`と`upstream_run_finished`の2つです。上流はルールごとに1つで、連鎖は5段までです（[containers-automation.md](../containers-automation.md)、[`modelAutomation.ts`](../../packages/contracts/src/schemas/modelAutomation.ts)）。
- **ComputeTarget**：trackingのDBに、SSHの接続情報（host、ユーザー、鍵のpath）を持ちます（[`execution.ts`](../../packages/contracts/src/schemas/execution.ts)）。
- **worker**：SSHで実行し、状態を見に行き、出力をtarで回収します（[worker.md](../worker.md)）。SSHは`BatchMode=yes`で、経由するホストを指定できません（[`transport.py`](../../python/src/mado_tracking/worker/transport.py)）。
- **応答途絶**：claimedかrunningのJobは、heartbeatが60秒届かないと応答途絶になります（[`workerLiveness.ts`](../../apps/api/src/domain/workerLiveness.ts)）。
- **Job限定token**：自分のRunにしか書けず、別のRunやJobは作れません（[worker.md](../worker.md)「実行コードにはJob限定tokenを渡す」）。
- **上限**：
  - 1つのJobの出力は既定1万ファイル（最大100万）
  - Artifactを中身とするDatasetVersionは1版10万ファイルまで
  - 実行先のdataset cacheは既定100GiB
- **署名付きURL**：取得には対応していません（[operations.md](../operations.md)）。
- **未確認の結合**：実GPU・実SIF・実SSHを通した確認は、まだしていません（[worker.md](../worker.md)「テストと型検証を実行する」）。

## 全体の構成

```text
tracking（MMT）  Run・指標・Artifact・版・lineage・フック・Jobの記録
  │ 実行の依頼 ↓          ↑ 報告（runnerから直接）
launcher         SSHで入ってjob shellを動かすだけ（OTPのサイトは本人の mmt submit）
  └ job shell     サイトごとに書く。資源を確保してrunnerを起動する
     └ runner     計算ノード上。入力の取得、コンテナの起動、報告、出力のupload
        └ コンテナ startup command＋コード（/mmt/source）

Forgejo（同梱）   ジョブ雛形とコードのgit repo、container registry
SIF変換           imageのdigest×CPUの組ごとに1回変換して、S3へ置く
```

- trackingは「いつ・何を・どこで」動かすかを決めます。「どう動かすか」は持ちません。
- launcherは、今のworkerを投入だけに絞ったものです。SSHで入ってjob shellを動かしたら、そこで終わります。接続は保ちません。
- 実行の知識（スケジューラ、module、GPUの渡し方）は、job shellとrunnerの中に閉じます。

## trackingと実行側の受け渡し

### 依頼（tracking→実行側）

| 項目 | 内容 |
|---|---|
| image | digestに解決したもの |
| 雛形 | repoとcommit |
| startup command | コンテナの中で実行するargv |
| 入力 | モデル版、データセット版と担当shard、checkpoint、上流のRun、起動のきっかけになった本文 |
| 資源 | GPU数、制限時間、arrayの数 |
| 実行先と依頼者 | 実行先の名前、依頼した人 |
| 経緯 | 起動したもの（手動・フック・ドライバー）、元のイベント、親Job、連鎖の起点、深さ |
| 重複防止キー | 同じ依頼を二重に作らないためのキー |

### 報告（runner→tracking）

| 状態 | 意味 |
|---|---|
| 手動投入待ち | OTPのサイトで、本人の`mmt submit`を待っている |
| 投入済み | スケジューラの待ち行列にいる。スケジューラのジョブIDを記録する |
| GPU待ち | 直実行のホストで、空いたGPUを待っている |
| 実行中 | heartbeatを送っている |
| 終了・失敗・取消 | 終了コードを記録する |
| 時間切れ | 制限時間で止められた（SIGTERMを受けた） |
| 応答途絶 | 実行中にheartbeatが途切れた |

- 応答途絶の判定は、実行中のJobにだけ行います。投入済みのJobには、待ち行列にいてよい上限時間を任意で付けます。
- ログ、指標、出力の登録も、runnerが直接送ります。

### 取消

trackingは取消の印を付けるだけです。runnerがheartbeatの応答で印に気づいて止まります。待ち行列にいる間に取り消されたJobは、起動した直後に終わります。SSHで入れるサイトでは、launcherが取消コマンドで待ち行列から外すこともできます。

### 実行先の情報（実行側→tracking）

渡すのは名前、CPU（amd64/arm64）、runtime、GPUの有無、投入方式（自動/手動）だけです。trackingはこれを、imageのCPUの照合と画面の表示に使います。接続情報や鍵は、trackingに置きません。

## 実行側

### 実行先の設定

**全体設定**

管理者が管理するrepo（以下、サイトrepo）に、実行先ごとの`site.yaml`と`job.sh`を置き、版で管理します。Runには、どの版のjob shellで動いたかを記録します。

| `site.yaml`の項目 | 内容 |
|---|---|
| 投入方式 | `ssh`（launcherが投入する）か`manual`（本人が`mmt submit`で投入する） |
| 接続 | host、port、経由するホスト（0個以上）、known_hosts |
| アカウント方式 | 共用か本人か |
| CPU | `amd64`か`arm64` |
| runtime | `docker`、`apptainer`、`singularity` |
| GPUの渡し方 | 既定は`--nv`。管理者だけが変えられる |
| 作業ディレクトリ | 計算ノードから見える共有の場所 |
| 取消コマンド | 例：`qdel "$MMT_SCHEDULER_JOB_ID"` |
| array | job shellがスケジューラのarrayに対応しているか |
| 待ち行列の上限時間 | 任意 |
| GPU番号 | 直実行のホストだけ |

**個人設定**

本人が設定します。
- アカウント名
- 鍵：SSHで入る、本人アカウントのサイトだけに必要です。暗号化して保存し、使う間だけssh-agentへ読み込みます。OTPのサイトは本人が投入するので、鍵を預ける必要はありません。
- 変数（`MMT_VAR_*`）

**共用アカウントのDockerホスト**

job shellは管理者だけが書けるようにします。job shellはコンテナの外で、共用アカウントとして動きます。そのため、他の人のJobの秘密ファイルも読めてしまうからです。

### job shellの約束

| 方向 | 内容 |
|---|---|
| 受け取るもの | 環境変数の`MMT_SPEC_DIR`（仕様と秘密のファイルの場所。ファイルの権限は600）、`MMT_RUNNER`（runnerの実行ファイル）、`MMT_GPU_COUNT`、`MMT_WALLTIME`、`MMT_ARRAY_SIZE`、`MMT_VAR_*` |
| 返すもの | 標準出力の最後の行に、スケジューラのジョブIDだけを出す。直実行なら空でよい |
| 起動するもの | 最後にrunnerを起動する。コンテナを直接起動しない |

- 値は環境変数とファイルで渡し、スクリプトの文字列には埋め込みません。コマンドの注入を防ぐためです。
- 秘密は、引数やスケジューラのオプション（`qsub -v`など）で渡しません。ジョブの属性として保存され、管理者などから見えることがあるためです。
- IDを文の中に含めて出力するスケジューラもあるので、IDだけを取り出して出すのはjob shellの役目です。Grid Engineの`qsub`は、`-terse`を付けるとIDだけを出します。
- arrayの番号は、計算ノード側で0始まりの`MMT_ARRAY_INDEX`に直してからrunnerへ渡します。番号の範囲と始まりの値はスケジューラごとに違うので、直す処理はjob shellに置きます。

| スケジューラ | arrayの指定 | 番号が入る変数 |
|---|---|---|
| PBS | `-J` | `PBS_ARRAY_INDEX` |
| Slurm | `--array` | `SLURM_ARRAY_TASK_ID` |
| Grid Engine | `-t` | `SGE_TASK_ID` |
| Fujitsu TCS | `--bulk --sparam` | `PJM_BULKNUM` |

arrayに対応していない実行先では、launcherがN個の別々のジョブとして投入します。

PBSでの例です。オプションとmodule名はサイトに合わせて書き換えます。

```bash
#!/bin/bash
set -euo pipefail
qsub -l select=1:ngpus="$MMT_GPU_COUNT" -l walltime="$MMT_WALLTIME" \
  -o "$MMT_SPEC_DIR/scheduler.out" -e "$MMT_SPEC_DIR/scheduler.err" \
  -- /bin/bash -lc 'module load apptainer && exec "$1" "$2"' _ "$MMT_RUNNER" "$MMT_SPEC_DIR"
# PBSのqsubはジョブIDだけを出力するので、そのまま最後の行になる
```

### runner

- **配布**：x86用とArm用を用意し、Pythonを同梱します。サイトのmoduleには頼りません。launcherか`mmt submit`が、版ごとに作業ディレクトリへ置きます。
- **入力**：担当のshardだけを署名付きURLで取得し、サイトのcacheに置きます。今のdataset cacheの仕組みを使います。
- **SIF**：imageのdigest×CPUの組ごとにサイトのcacheへ置き、sha256を照合します。
- **コンテナの起動**：今の[`docker_container.py`](../../python/src/mado_tracking/worker/docker_container.py)と[`sif_container.py`](../../python/src/mado_tracking/worker/sif_container.py)の安全な起動手順（mountの制限、`--user`、環境変数の渡し方）を使います。
- **報告**：ログ、heartbeat、終了コードをtrackingへ送ります。出力は署名付きURLで、S3へ直接uploadします。
- **時間切れ**：終了の合図（SIGTERM）を受けたら、「時間切れ」と報告します。
- **直実行のDockerホストでのGPU**：runnerが空いたGPUを選びます。使用中かどうかは、動いているコンテナのlabelで判定します。選ぶ処理はホスト上のlockで1つずつ行います。コンテナはrunnerが落ちても動き続けるので、lockだけで判定すると、同じGPUを二重に割り当ててしまいます。

### OTPのサイト

投入の流れは次のとおりです。
1. 本人がOTPでログインし、`mmt submit --site <名前>`を実行します。
2. その人の「手動投入待ち」の依頼を取得し、仕様のファイルを書き出して、job shellで投入します。arrayは1回の投入にまとめます。
3. スケジューラのジョブIDをtrackingへ送って、終わります。何も常駐しません。
4. その後は、計算ノードのrunnerが直接報告します。

- フックやドライバーがOTPのサイトへの依頼を作ったら、本人に通知します。フックを作る画面でも、手動で投入する実行先であることを示します。
- OTPのサイトでは、自動化は投入の手前で止まります。arrayにまとめて、投入の回数を減らすことが前提です。

### image

- **build**：各自のPCでbuildし、Forgejoのregistryへpushします。x86とArmの両方で使うなら、`docker buildx build --platform linux/amd64,linux/arm64`でmulti-archにします。Apple SiliconのMacでは、Arm版はそのまま作れますが、x86版はエミュレーションになります。
- **照合**：依頼を作るときに、tagをdigestへ解決して記録し、実行先のCPU向けのimageが含まれているかを照合します。Apptainerは、CPUの合わないimageでも変換してしまい、実行して初めて失敗するためです。
- **SIFへの変換**：サーバー側で`apptainer pull --arch`を使います。変換するだけでコンテナを実行しないので、別のCPU向けでもエミュレーションは要りません。変換したSIFはS3に置き、runnerが署名付きURLで取得します。
- **Dockerホストでの取得**：読み取り専用のpull tokenを使い、registryから直接pullします。
- **base image**：公式のもの（SDK入り、amd64とarm64）を用意します。研究者はその上に、差分の層だけを積みます。

## tracking側

### フック

研究者全員が作れて、作った人の権限で動きます。設定は変えられず、変えるときは新しい版にします（今の自動実行ルールと同じです）。参照する雛形は、作ったときのcommitに固定するのを既定にし、branchの最新を追う設定も選べるようにします。

| きっかけ | 重複判定の単位 | 注意点 |
|---|---|---|
| 手動・起動API | 要求ID | LAN内のシステムからの起動もこれで受ける |
| モデル登録 | フック×版 | 今の自動実行ルールを移す。学習の成功を待つ点と、過去の版へ遡らない点は今と同じ |
| Runの終了 | フック×Run（最初の終了だけ） | MLflowのRunは終了と再開を繰り返すことがあるので、最初の終了だけにする。そのフックが起点の連鎖に属するRunでは起動しない |
| arrayの終了 | フック×array | 全部終わったら1回だけ起動する |
| checkpointの保存 | フック×checkpoint | SDKで登録したcheckpointだけを対象にする。MLflowのcheckpointは、Runが終わるまでファイルが足され続け、完了の時点が無いため。「毎回」「k個ごと」「最新だけ」「実行中なら飛ばす」から選ぶ |
| 外部webhook | フック×配信ID | 後の段階で作る。署名を検証し、回数を制限し、本文はファイルで渡す |

- 連鎖の深さの上限と、同じフックが1つの連鎖の中で2回起動しない規則を、フックとドライバーの両方にかけます。
- フックごとに、1時間あたりの起動回数の上限を付けます。
- **外部webhookの受け方**
  - LAN内のシステムからなら、token付きの起動APIで足ります。
  - GitHubのようなインターネット上のサービスでも、LAN内にself-hosted runnerを置けば、受け口を公開せずに起動APIを呼べます。
  - 受け口が必要になったら、runner用APIと同じedgeで、署名を検証する受け口だけを公開します。

### ドライバー

- 子Jobを作れるのは、起動時に「子Jobを作ってよい」と指定したJobのtokenだけです。
- 子Jobの数、深さ、同時実行数に上限を付けます。親を取り消すと、子Jobも止めます。
- SDKに`submit(spec, key=...)`、`wait()`、`map(shards)`を用意します。
  - `key`を付けておけば、ドライバーを再起動しても、同じ子Jobを二重に作りません。
  - `wait()`はlong pollで待ちます。
- 画面では親子関係を木で表示します。これがパイプラインの図の代わりになります。
- ドライバーは、CPUだけの直実行ホストで動かすのを既定にします。スパコンの計算ノードで動かすと、待っている間も資源を使い、制限時間で止められるためです。

### データ

- **形式**：合成データは、非圧縮のtar shardにします（1サンプル分のファイルを同じ名前でまとめる、WebDatasetの形）。Madoは非圧縮tarの中の音声・動画を、必要な部分だけ取得して再生できるので、そのまま中身を見られます。
- **登録**：shardの一覧（uri、サイズ、sha256、サンプル数）をmanifestにまとめ、参照のDatasetVersionとして登録します。版のdigestは、manifestのhashにします。
- **受け渡し**：段階の間はこの版で受け渡し、下流は担当のshardだけを取得します。こうすれば、dataset cacheの上限に当たりません。
- **保存先**：Madoが扱うbucketにします。
- **規模の目安**：音声3000時間を24kHz・16bit・モノラルで作ると、約520GBになります。1GBのshardなら約520個で、64並列なら1つのJobあたり8個ほどです。

### 失敗と時間切れ

「時間切れ」になったJobは、最新のcheckpointから、決めた回数まで自動で投入し直します。今ある再試行と、checkpointからの再開（[api-contract.md](../api-contract.md)「学習の途中再開」）を使います。

## ジョブの雛形（git repo）

1つのrepoを1つの雛形にします。

```yaml
# mmt-job.yaml（名前は仮）
image: forge.example.org/team/tts-gen:2026-10   # 依頼時にdigestへ解決して記録する
command: ["python", "-m", "gen.run", "--config", "configs/base.yaml"]
resources: { gpus: 1, walltime: "12:00:00", array: 64 }
outputs:
  dataset: { name: synth-speech, format: webdataset }
```

- コードは同じrepoに置き、`/mmt/source`にマウントします。
- 試行は人ごとのbranchで行います。Runには、repoとcommitを必ず記録します。
- 外部のremoteとは、Forgejoのmirrorで同期します。
- Workbenchでの編集は、いずれbranchへのcommitにします。今の「固定したcommitに変更を重ねる」方式（[workbench.md](../workbench.md)）は、これで置き換えます。
- SFTPは作りません。repoのファイルを直接書き換えると、いつcommitしたことになるのかが決まらないためです。編集はgitかForgejoの画面で、出力の閲覧はMadoで行います。
- 秘密はrepoに入れず、Projectか個人のsecretとして渡します。

## 作らないもの

| 作らないもの | 代わり |
|---|---|
| パイプライン（DAG） | フック、ドライバー、起動の経緯の記録 |
| 資源の対応表、課金グループ | job shell |
| gitサーバー、registry、SFTPの自作 | Forgejo |
| ログインノードに常駐するagent | `mmt submit` |
| Python runtime | 公式のbase image |
| SSHでの監視と出力の回収 | runnerからの直接の報告とupload |

## 今のコードからの移り方

| 今 | これから |
|---|---|
| workerがSSHで監視し、出力をtarで回収する | launcherは投入だけを行い、runnerが報告とuploadを行う |
| ComputeTargetをtrackingのDBに保存する | 実行側のサイトrepoと個人設定に移す。trackingには実行先の情報だけを渡す |
| GPUの予約をtrackingのDBで管理する | 直実行のホストで、runnerが割り当てる |
| ArtifactはすべてAPIを経由してuploadする | 大きいものは署名付きURLで直接uploadする |
| 自動実行ルール | フック |
| Task | ジョブの雛形と起動画面 |
| Python runtime | 公式のbase image |
| SweepはTaskからJobを作る | Sweepは依頼を作る。探索の制御はtrackingに残す |

## 進め方

| 段階 | 内容 | 終わりの条件 |
|---|---|---|
| M0 | 実機で確認する（SSHのGPUサーバー1台、OTPのないスパコン1つ、Miyabi-Gで`mmt submit`の流れ） | 3か所でコンテナが動き、GPUが見え、結果がRunに残る |
| M1 | 分離の土台を作る（依頼と報告、runnerからの直接の報告、runner用APIの公開、launcher、job shell、`mmt submit`） | SSHで監視しなくても、Jobが最後まで記録される |
| M2 | Forgejoの同梱、ジョブの雛形、imageのCPUの照合、SIFへの変換、base image | 手元でbuildしたimageが、x86とArmの両方で動く |
| M3 | array、shard、署名付きURL | 音声3000時間規模の生成を、手動起動で回せる |
| M4 | フック（自動実行ルールから移行）、ドライバー、時間切れからの再投入 | 登録・Runの終了・checkpointをきっかけに、依頼が作られる |
| M5 | 外部webhook、pilot job（サイトの規則が許す場合） | — |

M3をM4より先にするのは、フックやドライバーが作るJobも、arrayとshardの上で動くためです。

## 実装の状況（2026-10-09）

M1・M3・M4の大部分と、M2・M5の一部を実装しました（APIの詳細は[api-contract.md](../api-contract.md)の「外部の計算機（site）」「フックとドライバー」、使い方は[sites.md](../sites.md)と[hooks.md](../hooks.md)）。実機（M0）ではまだ確かめていません。

設計から変えたこと:

| 設計 | 実装 | 理由 |
|---|---|---|
| ComputeTargetを実行側へ移す | ComputeTargetに`executor='site'`を足し、接続設定を持たないsiteとして残す | ssh/localの実行先と同じ一覧・権限・Job画面を使えます。siteは名前・CPU・runtime・投入方式だけを持ちます |
| SIFへの変換はtracking側 | runnerがsiteの上で`apptainer pull --arch`し、cacheを使い回す | 全部のスパコンが外へ通信できるので、変換したSIFを運ぶより速く、trackingに大きいファイルが溜まりません |
| ジョブの雛形・siteの設定はYAML（`site.yaml`） | TOML（`mmt-job.toml`、launcherの`launcher.toml`の`[[sites]]`） | Python標準のtomllibで読め、依存を増やしません |
| 署名付きURLでの直接upload | 既存のupload session（再開可能、part単位）をJob tokenで使う | 保存先ごとの署名を作る仕組みが要るので後回しにしました |
| Python runtimeをbase imageへ置き換える | ssh/localではPython runtimeを残し、siteはコンテナだけ | 今のworkerの利用者を壊さないためです |

まだ作っていないもの: 署名付きURL、pilot job、MLflowの`checkpoints/step-N/`でのフック、手動投入のsiteで待ち行列から外す仕組み（取り消したJobのrunnerは起動してもtokenが401になるのですぐ終わります）、arrayの一括作成（今は1件ずつ検証して作るので、数千件では作成に数十秒かかります）。

## 残るリスクと確認すること

- OTPのサイトでは、投入のたびに人の操作が要ります。arrayにまとめて、回数を減らします。
- runner用APIを外へ公開します。Job用token以外は拒否し、受け付けるpathを限ります。
- 共用アカウントのDockerホストでは、利用者どうしを隔離しません（了承済み）。job shellは管理者だけが書けるようにします。
- 1人あたりの投入数、arrayの上限、制限時間、ログインノードでの処理の規則は、サイトごとに違うので、それぞれ確かめます。
- ForgejoのライセンスはGPLv3以降です。別のサービスとして同梱しますが、配布の形を決めるときに確かめます。

## 参考：サイトの違いの例

「—」は未確認です。

| サイト | スケジューラ | CPU | ログイン | コンテナ |
|---|---|---|---|---|
| ABCI 3.0 | PBS Professional（グループの指定`-P`が必須。arrayは`-J`で最大75000） | x86_64 | 鍵（アクセスサーバー経由） | SingularityCE/PRO |
| TSUBAME4.0 | Altair Grid Engine（`h_rt`の指定が必須） | x86_64 | 鍵 | Apptainer |
| 富岳 | Fujitsu TCS（`pjsub`。バルクジョブは`PJM_BULKNUM`） | Arm（A64FX） | — | — |
| Miyabi-G | — | Arm（GH200のGrace） | 鍵と毎回のOTP（2025年1月の資料） | — |

- [ABCI 3.0 Getting Started](https://docs.abci.ai/v3/en/getting-started/)、[Job Execution](https://docs.abci.ai/v3/en/job-execution/)、[Containers](https://docs.abci.ai/v3/en/containers/)
- [TSUBAME4.0 移行ガイド](https://www.t4.cii.isct.ac.jp/docs/migration.en/pdf/migration.en.pdf)、[FAQ](https://www.t4.cii.isct.ac.jp/docs/faq.en/)
- [富岳 Bulk Job](https://www.r-ccs.riken.jp/fugaku/docs/user-guide/sys-use/user-guide-use-1.49/build/en/JobExecution/BulkJob.html)
- [Miyabi: Introduction](https://www.cc.u-tokyo.ac.jp/en/supercomputer/miyabi/system.php)、[初回ログイン資料（2025年1月）](https://www.cc.u-tokyo.ac.jp/events/seminar/files/20250116-5.pdf)
- [Slurm: Job Array Support](https://slurm.schedmd.com/job_array.html)
- [Apptainer: pull](https://apptainer.org/docs/user/1.5/cli/apptainer_pull.html)
- [Forgejo: Container Registry](https://forgejo.org/docs/latest/user/packages/container/)、[Repository Mirrors](https://forgejo.org/docs/v17.0/user/repo-mirror/)
- [GitHub Docs: Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
