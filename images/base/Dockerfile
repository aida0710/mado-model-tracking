# Official base image for mado ML Tracking Jobs: a GPU framework image for amd64 and arm64,
# the mado-tracking SDK, and the /mmt paths the runner mounts. Project images add only their own
# dependencies on top of it (images/base/README.md). Build from the repository root, which holds
# the SDK in python/:
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f images/base/Dockerfile \
#     -t forge.example.org/mmt/base:pytorch-25.10 --push .
#
# The default is NVIDIA's PyTorch image (multi-arch). Its tag decides the CUDA version and the
# lowest GPU driver the sites need; pick it with --build-arg BASE_IMAGE=... (README.md).
ARG BASE_IMAGE=nvcr.io/nvidia/pytorch:25.10-py3
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
LABEL org.opencontainers.image.title="mado ML Tracking base" \
  org.opencontainers.image.description="GPU framework image with the mado-tracking SDK for Jobs" \
  org.opencontainers.image.base.name="${BASE_IMAGE}"

# Optional SDK extras, comma separated (for example "telemetry"). Empty installs the SDK alone,
# so the base image keeps the framework's own versions of numpy, Pillow and the like.
ARG MMT_SDK_EXTRAS=""
COPY python /tmp/mado-tracking-python
RUN sdk=/tmp/mado-tracking-python \
  && if [ -n "$MMT_SDK_EXTRAS" ]; then sdk="$sdk[$MMT_SDK_EXTRAS]"; fi \
  && python3 -m pip install --no-cache-dir "$sdk" \
  && rm -rf /tmp/mado-tracking-python \
  && python3 -c "import mado_tracking"

# The runner starts the container as the submitting account (docker --user, Apptainer), which has
# no entry in this image, so HOME is writable by any uid. The /mmt paths are the runner's mount
# points (inputs, context, source and datasets read-only, outputs read-write); they exist in the
# image because some Apptainer installations bind only onto existing directories.
ARG MMT_UID=10001
ARG MMT_GID=10001
RUN groupadd --gid "$MMT_GID" mmt \
  && useradd --uid "$MMT_UID" --gid mmt --no-create-home --home-dir /home/mmt --shell /bin/bash mmt \
  && install -d -m 1777 /home/mmt \
  && install -d -m 755 /mmt /mmt/inputs /mmt/context /mmt/outputs /mmt/source /mmt/datasets
# Apptainer replaces HOME with the host's, so caches go to /tmp, which every runtime makes writable.
ENV HOME=/home/mmt \
  XDG_CACHE_HOME=/tmp/mmt-cache
USER mmt
