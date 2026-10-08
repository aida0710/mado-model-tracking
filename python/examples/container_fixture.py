"""Register a CPU Docker fixture that needs no SDK inside its image."""

from __future__ import annotations

import os

from mado_tracking import Client, DockerRuntime

# The shell uses only BusyBox tools; it closes input-copy.json before publishing the manifest.
FIXTURE_SCRIPT = r"""
set -eu
test -r "$MMT_JOB_CONTEXT_FILE"
test -r "$MMT_DATASET_VERSIONS_FILE"
test "$PWD" = /tmp
if printf tampered >> /mmt/context/context.json 2>/dev/null; then exit 20; fi
if [ -n "$MMT_MODEL_FILE" ]; then
  if printf tampered >> "$MMT_MODEL_FILE" 2>/dev/null; then exit 21; fi
  cat "$MMT_MODEL_FILE" > "$MMT_OUTPUTS_DIR/input-copy.json"
else
  printf '{"fixture":"cpu"}\n' > "$MMT_OUTPUTS_DIR/input-copy.json"
fi
printf 'container-ready\n'
printf '%s\n' "$MMT_API_TOKEN"
sleep "${1:-0}"
checksum=$(sha256sum "$MMT_OUTPUTS_DIR/input-copy.json" | cut -d ' ' -f 1)
size=$(wc -c < "$MMT_OUTPUTS_DIR/input-copy.json" | tr -d ' ')
printf '{"version":1,"complete":true,'\
'"artifacts":[{"path":"input-copy.json","sha256":"%s","size":%s,"mimeType":"application/json"}],'\
'"metrics":[{"name":"fixture.score","value":0.9,"step":1}]}' \
  "$checksum" "$size" > "$MMT_OUTPUTS_DIR/manifest.partial"
mv "$MMT_OUTPUTS_DIR/manifest.partial" "$MMT_RESULT_FILE"
"""


def main() -> None:
    runtime: DockerRuntime = {
        "kind": "docker",
        "image": os.environ["MMT_EXAMPLE_DOCKER_IMAGE"],
        "workingDirectory": "/tmp",
    }
    with Client() as client:
        code = client.register_code(
            os.environ["MMT_PROJECT_ID"],
            name="CPU container fixture",
            version="v1",
            source=None,
            runtime=runtime,
            entrypoint=["/bin/sh", "-c", FIXTURE_SCRIPT, "mmt-fixture", "0"],
            supported_model_families=["linear"],
            task_types=["inference", "evaluation"],
        )
    print(f"codeVersionId={code['id']}")


if __name__ == "__main__":
    main()
