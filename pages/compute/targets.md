---
title: Compute target
description: Jobを実行するGPUマシンをCompute targetとして登録する。SSHの接続先、GPUの指定、Docker・Singularity・Apptainerの準備と、workerによる接続確認。
---

# Compute target

![プロジェクトのCompute。自分が使えるコンピュータの一覧とWorkers](/images/compute-targets.png)

Compute targetは、Jobを実行するマシンの登録です。コンピュータのうち、SSHとLocalのものを指します。SSHの接続先、使えるGPU、対応するRuntime（Python、Docker、Singularity、Apptainer）、作業ディレクトリを登録します。targetへの接続とJobの実行はworkerが行い、API serverはtargetへ接続しません。

targetは全体設定の「コンピュータ」で足し、公開範囲（PublicかPrivate）で誰のJobが動くかを決めます。公開範囲と所有者の考え方は[コンピュータと公開範囲](/compute/computers)を参照してください。

```text
API server ← worker（SSH鍵・known_hostsを持つ） → Compute target（GPUマシン）
```

## こんなときに向いています

- 研究室や社内のGPUマシンで、Taskや自動実行のJobを動かしたい
- GPUを1枚ずつ予約して、Job同士が同じGPUを取り合わないようにしたい
- 依存関係をDockerイメージやSIFファイルに固めて動かしたい
- 最初のJobを流す前に、SSH、Python、Docker、GPUが使えるかをまとめて確かめたい

## targetを用意する

ここではUbuntuのGPUマシンをtargetにする例で説明します。targetのマシンでターミナルを開き、次を実行します。

### PythonとGitを入れる

targetには、workerが送るsupervisor用にPython 3.11以上が必要です。Python runtimeでは、Jobごとにvenvを作って依存パッケージを入れます。

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git
python3 --version
```

`python3 --version`が3.11未満なら、3.11以上のPythonを別に入れて、そのパスをtargetの［Python実行パス］に指定します。

### Dockerを使う場合

```bash
sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER"   # SSHで接続するユーザーをdockerグループに入れる
```

グループの変更は、次にログインしたときから有効になります。SSHでログインし直して`docker version`を実行し、ServerのVersionまで表示されることを確かめます。

- workerは`--network host`でコンテナを起動します。コンテナ内から`127.0.0.1`へ接続すると、target自身を指します。
- 読み取り専用のmountにLinux kernel 5.12以上が必要です。`uname -r`で確かめます。
- rootless DockerとUser namespaceのremapでは確認していません。

GPUをDockerで使う場合は、NVIDIAドライバに加えてNVIDIA Container Toolkitを入れます。

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Apptainerを使う場合

```bash
sudo add-apt-repository -y ppa:apptainer/ppa
sudo apt-get update
sudo apt-get install -y apptainer
apptainer --version
```

SingularityとApptainerは、`exec`の`--cleanenv`、`--containall`、`--no-home`、`--no-mount`、`--no-eval`、`--pwd`と、GPU用の`--nv`に対応したバージョンが必要です。古いバージョンでは接続確認でNGになります。

### workerからSSHで入れるようにする

SSHの秘密鍵とknown_hostsは、workerを動かすマシンに置きます。targetの登録には、そのファイルのパスだけを入力します。workerのマシンでターミナルを開き、次を実行します。`gpu-host-1.example.internal`と`mmt`は、targetのホスト名とSSHユーザーに置き換えてください。

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mmt_worker_ed25519 -N ''
chmod 600 ~/.ssh/mmt_worker_ed25519
ssh-copy-id -i ~/.ssh/mmt_worker_ed25519.pub mmt@gpu-host-1.example.internal
ssh-keyscan -p 22 gpu-host-1.example.internal > ~/.ssh/mmt_known_hosts
ssh-keygen -lf ~/.ssh/mmt_known_hosts
```

最後のコマンドで表示されたフィンガープリントを、targetで`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`を実行した結果と比べ、一致することを確かめてください。workerは未知のホスト鍵や変わったホスト鍵を受け入れません（`StrictHostKeyChecking=yes`）。

## targetを登録する {#register-a-target}

![［コンピュータを追加］のダイアログ（SSHのtarget）](/images/compute-target-dialog.png)

SSH・Localのtargetを足せるのは全体管理者です。足した人がそのtargetの所有者になり、設定を変えられるのは所有者と全体管理者です。研究者が自分で足せるのは、外部のコンピュータ（site）だけです（[外部のコンピュータ（site）](/compute/sites)）。

1. 右上のユーザーメニューの［全体設定］から、サイドバーの［コンピュータ］を開きます（`/settings/computers`）。
2. ［コンピュータを追加］を押します。
3. 次の項目を入力します。

| 項目 | 入力例 | 内容 |
| --- | --- | --- |
| 名前 | `gpu-host-1` | 画面とTaskの選択肢に表示する名前 |
| Executor | SSH | 通常はSSHです。Local（開発専用）は開発モードでだけ選べます。Site（外部のコンピュータ。[外部のコンピュータ（site）](/compute/sites)）も選べます |
| 公開範囲 | Public | Private（既定）では、所有者と、所有者が作ったService AccountのJobだけが動きます。どのProjectのJobも動かすならPublicにします（[公開範囲](/compute/computers#visibility)） |
| Host、Port | `gpu-host-1.example.internal`、`22` | targetのSSHの接続先 |
| SSHユーザー | `mmt` | SSHで接続するユーザー |
| SSH鍵のパス | `/home/worker/.ssh/mmt_worker_ed25519` | workerのマシン上の秘密鍵のパス |
| known_hostsのパス | `/home/worker/.ssh/mmt_known_hosts` | workerのマシン上のknown_hostsのパス |
| 作業ディレクトリ | `/data/mmt-jobs` | target上でJobのファイルを置く場所。SSHユーザーが書き込めるディレクトリ |
| Python実行パス | `python3` | target上のPython 3.11以上 |
| 対応Runtime | Python、Docker | このtargetで動かせるRuntime |
| GPU ID（1行に1件） | `0`<br>`1` | Jobに割り当ててよいGPUの番号。空ならCPUだけのtarget |
| 同時実行数 | `2` | このtargetで同時に動かすJobの上限 |
| データセットの転送 | workerが中継する | 入力データセットの取得方法（後述） |
| データセットのcache上限（GiB） | `100` | target上のデータセットのcacheの上限 |

4. ［保存］を押します。一覧に追加され、その下にtargetの詳細が開きます。
5. 続けて、後述の［接続を確認］でtargetが使えることを確かめます。

接続先や鍵のパスなどの接続情報は、所有者と全体管理者にだけ表示します。

### GPUの割り当て

Taskや自動実行ルールでGPU IDを選ぶと、そのJobの間はアプリ内でそのGPUを予約し、ほかのJobに割り当てません。選ばなければCPUだけで実行します。

- Dockerでは、予約したGPUだけを`--gpus device=...`で渡します。コンテナ内のCUDAの番号は`0`から振り直されます。
- SingularityとApptainerでは`--nv`と`CUDA_VISIBLE_DEVICES`で、CUDAから見えるGPUを予約したものに絞ります。デバイス自体の分離ではありません。
- 予約はこのアプリのJob同士の排他です。ほかの人がSSHで直接使うGPUや、別のジョブスケジューラーが使うGPUまでは防げません。共有のマシンでは、このアプリ専用のGPUと作業ディレクトリを決めて登録してください。
- 状態が確認できないJobのGPUは、自動で解放しません。

### 入力データセットの転送

| データセットの転送 | 動作 | 向いている場面 |
| --- | --- | --- |
| workerが中継する（既定） | workerがAPIから取得し、1本のtarでtargetへ送ります | GPUマシンからAPI serverへ直接届かない |
| targetがAPIから直接取得する | targetがJob限定tokenでAPIから取得します | targetからAPIへ届き、workerを経由すると遅い |

取得したデータセットは、作業ディレクトリの`.mmt-cache/datasets/`に置き、同じバージョンを次のJobでも使います。cacheが上限を超えると、最後に使ったのが古いものから消します。実行中のJobが使っているものは消しません。データセットバージョンの詳細は[データセット](/data/datasets)を参照してください。

### targetの変更と無効化

全体設定の「コンピュータ」の一覧で、［コンピュータを編集］を押して設定を変えます。変えられるのは所有者と全体管理者です。待機中・実行中のJobが参照しているあいだは、接続先、Runtime、GPU、データセットの設定を変更できません。Jobが終わってから保存してください。

一覧の［無効にする］を押すか、編集の［有効］のチェックを外すと、新しいJobの割り当て先から外れます。実行中のJobは、workerが引き続き管理します。

## 接続を確認する {#check-the-connection}

![接続確認の結果（見本のLocalのコンピュータ）](/images/compute-target-check.png)

最初のJobを流す前に、全体設定の「コンピュータ」の［接続を確認］で、targetの準備ができているかを確かめます。確認はそのtargetを担当するworkerが、自分のSSH鍵で行います。接続確認は、所有者と全体管理者が行えます。

1. 全体設定の「コンピュータ」の一覧で、targetの行の［接続を確認］を押します。一覧の下に、targetの詳細と［接続確認］の欄が開きます。
2. 欄の右上の［接続を確認］を押します。workerが確認を受け取ると、状態が変わります。
3. 項目ごとの結果を確かめます。NGの項目は［対処］の欄に直し方を表示します。

確認する項目は次のとおりです。

| 項目 | 確かめること |
| --- | --- |
| SSH接続 | 鍵とknown_hostsでtargetへ接続できるか |
| Python | ［Python実行パス］のPythonが3.11以上か |
| venv、pip | Jobごとのvenvを作り、パッケージを入れられるか |
| git | Gitのソースを取得できるか |
| Docker | CLIがあり、daemonに接続できるか。権限が無いのか、daemonが止まっているのかを分けて表示します |
| Apptainer、Singularity | CLIがあり、必要なオプションに対応しているか |
| GPU（nvidia-smi） | `nvidia-smi`が報告するGPUのindex、名前、メモリ |
| 作業ディレクトリ | SSHユーザーが書き込めるか、空き容量 |
| APIへの到達 | targetからAPI serverへ届くか |

Localのtargetでは、最初の項目が「SSH接続」の代わりに「コマンドの起動」になります。

結果の［OK］は使えること、［NG］はそのままではJobが失敗すること、［なし］はRuntimeやGitのような任意の道具が入っていないことを表します。

確認で見つかったGPUとRuntimeは、［設定の候補］に表示します。候補を選んで［選んだ候補を保存］を押したときだけ、targetの［GPU ID］と［対応Runtime］が変わります。

確認はtargetに何も残しません。作業ディレクトリも作りません。

### 確認が終わらないとき

| 表示 | 原因と対処 |
| --- | --- |
| 5分以内にclaimしたworkerがありません | このtargetを担当するworkerが動いていません。workerの`MMT_WORKER_TARGET_IDS`（`install`の`--target-ids`）にtargetのIDが入っているかを確かめます |
| workerから結果が届きませんでした | workerが確認の途中で止まりました。workerのログを確かめます |
| SSH接続がNG（鍵の権限） | workerのマシンに鍵かknown_hostsが無いか、鍵の権限が600ではありません。workerのマシンで`mado-tracking-worker doctor`を実行して確かめます |
| APIへの到達がNG | targetからworkerの`MMT_API_URL`へ届きません。Jobの記録に必要なので、経路とURLを見直します |

`MMT_WORKER_TARGET_IDS`を設定していないworkerは、Jobは処理しますが、接続確認は受け取りません。

## Workersを見る

プロジェクトの［Compute］には、このProjectで自分が使えるコンピュータの一覧（読むだけ）と［Workers］が出ます。［Workers］には、このProjectに接続しているworkerの接続状態、バージョン、ホスト名、最終応答、担当Job数を表示します。120秒以上応答が無いworkerは「オフライン」になります。workerの導入は[workerの導入と常駐](/compute/worker)を参照してください。

## 権限

| 操作 | 必要な権限 |
| --- | --- |
| 全体設定の「コンピュータ」ですべてのtargetを見る | ログインしている人（使えないものは名前・種類・所有者・公開範囲・状態だけ） |
| プロジェクトのComputeとWorkersを見る | viewer以上 |
| SSH・Localのtargetを足す | 全体管理者 |
| targetの変更・公開範囲の変更・有効と無効の切り替え、接続確認 | 所有者か全体管理者 |
| targetでJobを動かす | Publicは誰でも。Privateは所有者と、所有者が作ったService Account |
| 外部のコンピュータ（site）の登録・変更 | 誰でも足せます。変更は所有者か全体管理者（[外部のコンピュータ（site）](/compute/sites)） |
