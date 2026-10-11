# 公式のbase image

Jobのコンテナの土台にする公式のimageです（[設計案](../../docs/design/external-execution.md)「image」）。研究者は、この上に自分の依存だけを差分の層として積みます。

| 入っているもの | 内容 |
|---|---|
| GPUのframework | 既定はNVIDIAのPyTorch（`nvcr.io/nvidia/pytorch:25.10-py3`。CUDA 13.0、PyTorch 2.9、Python 3.12、amd64とarm64） |
| SDK | このrepoの`python/`から入れた`mado-tracking`（依存はhttpxだけ） |
| `/mmt`のmount point | runnerがmountする`/mmt/inputs`・`/mmt/context`・`/mmt/source`・`/mmt/datasets`（読み取りだけ）と`/mmt/outputs`。bindの先が無いと失敗するApptainerがあるため、imageに作っておきます |
| 利用者 | `mmt`（uid 10001）。`HOME=/home/mmt`はどのuidでも書けます。cacheは`XDG_CACHE_HOME=/tmp/mmt-cache` |

runnerは、コンテナを投入したアカウントのuidで起動します（Dockerは`--user`、Apptainerは本人）。imageの`USER`が使われるのは、手元で`docker run`したときだけです。Apptainerは`HOME`をホストの値に置き換えるので、cacheは`/tmp`の下に置きます。

## buildしてForgejoのregistryへpushする

repoの最上位で実行します（`python/`をimageへ写すため）。

```bash
docker login forge.example.org          # passwordにはForgejoのアクセストークン（write:package）
docker buildx build --platform linux/amd64,linux/arm64 \
  -f images/base/Dockerfile \
  -t forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0 \
  --push .
docker buildx imagetools inspect forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0   # linux/amd64 と linux/arm64
```

- 複数のplatformを1つのtagにまとめるには、containerdのimage storeを使うDocker（Docker Desktopの既定）か、`docker buildx create --name mmt --driver docker-container --use`で作ったbuilderが要ります。
- tagには、土台のバージョンとSDKのバージョンを入れます。同じtagを上書きしないでください。依頼のときにtagはdigestへ解決して記録されるので、過去のRunは元のimageのままですが、どの中身かを人が追えなくなります。
- registryとの認証は[Forgejoの説明](../../deploy/forgejo/README.md)にあります。

### Apple Silicon（arm64）のMacでは

- arm64はそのままの速さでbuildできます。amd64はエミュレーション（QEMU）で動くので、`RUN`の多いimageでは遅くなります。
- NGCのimageは1つのplatformで圧縮して約8〜11 GBあるので、最初のpullとpushにも時間がかかります。
- 遅すぎるときは、platformごとに別のマシンで作り、最後に1つのtagにまとめます。

  ```bash
  # Apple Silicon で
  docker buildx build --platform linux/arm64 -f images/base/Dockerfile -t forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0-arm64 --push .
  # x86 の Linux で
  docker buildx build --platform linux/amd64 -f images/base/Dockerfile -t forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0-amd64 --push .
  # どちらかで
  docker buildx imagetools create -t forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0 \
    forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0-amd64 forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0-arm64
  ```

- x86のLinuxでarm64を作るときは、先にQEMUを登録します（`docker run --privileged --rm tonistiigi/binfmt --install arm64`）。

## 土台の選び方

`--build-arg BASE_IMAGE=...`で土台を変えます。NGCのtagごとに、必要なGPUドライバーのバージョンが違います。サイトの`nvidia-smi`でバージョンを確かめ、NGCのrelease notesと照らします。

| `BASE_IMAGE` | CUDA | NGCが前提とするドライバー |
|---|---|---|
| `nvcr.io/nvidia/pytorch:25.10-py3`（既定） | 13.0 | 580 |
| `nvcr.io/nvidia/pytorch:26.08-py3` | 13.4 | 615 |

データセンター向けのGPUでは、古いドライバーでもCUDAの前方互換で動く場合があります（NGCのrelease notesの「Driver Requirements」）。CPUだけのJob向けには、Python 3.11以上の小さいimage（例: `python:3.12-slim-bookworm`）も土台にできます。

SDKの追加の依存は`--build-arg MMT_SDK_EXTRAS=telemetry`（psutilとnvidia-ml-py。コンテナの中からsystem metricsを送るとき）のように入れます。既定では入れず、土台のバージョンのnumpyなどをそのまま使います。

## 研究者のimage（差分の層だけ）

```dockerfile
FROM forge.example.org/mmt/base:pytorch-25.10-sdk0.1.0
# aptとpipはrootで入れ、最後に利用者を戻します。
USER root
RUN apt-get update && apt-get install -y --no-install-recommends sox && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
USER mmt
# Forgejoの画面で、imageをこのrepoのPackagesに表示します。
LABEL org.opencontainers.image.source=https://forge.example.org/team/tts-gen
```

- コードはimageに入れません。runnerが雛形のrepoのcommitを`/mmt/source`にmountします。imageには依存だけを入れるので、コードを変えるたびにbuildし直す必要がありません。
- NGCのimageはpipの制約ファイル（`PIP_CONSTRAINT=/etc/pip/constraint.txt`）でtorchなどのバージョンを固定しています。`requirements.txt`がそれと合わないと、pipが失敗します。torchのバージョンを変えたいときは、別の`BASE_IMAGE`を選びます。
- 実行先のCPU（コンピュータの`cpuArch`）向けのimageが含まれている必要があります。富岳やMiyabi-GなどArmのサイトで使うimageは、arm64を含めてbuildします。Apptainerのサイトでは、runnerがimageのdigestとCPUの組ごとに一度だけSIFへ変換して使い回します。
- 手元で確かめます。

  ```bash
  docker run --rm --gpus all forge.example.org/team/tts-gen:2026-10 \
    python3 -c "import torch, mado_tracking; print(torch.cuda.is_available())"
  ```
