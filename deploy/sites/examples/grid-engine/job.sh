#!/bin/sh
# Job shell for (Altair/Univa/Son of) Grid Engine. The option values follow TSUBAME4.0 and are
# examples only: adapt the site settings below (deploy/sites/examples/grid-engine/README.md).
#
# The launcher, or `mado-tracking submit`, runs this file on a login node with the request in
# MMT_* environment variables (deploy/sites/README.md). Request values never become script
# text: they reach qsub only as separate, validated arguments, and the batch script written
# below is a constant that reads them from its own environment on the compute node.
# Standard output carries only the scheduler job ID, on the last line; messages go to stderr.
set -eu
umask 077

# ---- Site settings ------------------------------------------------------------------------
# Time limit of a Job that sets none (h_rt is required on TSUBAME). Keep it within the maximum.
DEFAULT_WALLTIME_SECONDS=3600

# The resource type (TSUBAME: -l <type>=1) that holds the requested GPUs. A site with a
# consumable "gpu" complex requests "-l gpu=N" instead (README.md).
resource_type_for_gpus() {
  case "$1" in
    0) echo cpu_8 ;;      # 8 CPU cores, no GPU
    1) echo gpu_1 ;;      # 1 GPU, 8 cores
    2) echo node_h ;;     # 2 GPUs, half a node
    3 | 4) echo node_f ;; # a whole node (4 GPUs)
    *) return 1 ;;
  esac
}

# ---- Checks of the request ----------------------------------------------------------------
fail() {
  printf 'job.sh: %s\n' "$*" >&2
  exit 1
}

# A decimal integer without sign or leading zeros (shell arithmetic reads 010 as octal).
require_count() {
  case "$2" in
    '' | *[!0-9]* | 0?*) fail "$1 must be a decimal integer: '$2'" ;;
  esac
  [ "${#2}" -le 9 ] || fail "$1 is too large: $2"
}

# An absolute path whose characters pass through qsub's option lists unchanged.
require_path() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute path: '$2'" ;;
  esac
  case "$2" in
    *[!A-Za-z0-9._/+@-]*) fail "$1 has characters this job shell does not pass on: '$2'" ;;
  esac
}

# A scheduler option value such as a group name.
require_word() {
  case "$2" in
    '' | -* | *[!A-Za-z0-9._-]*) fail "$1 must be letters, digits, '.', '_' or '-': '$2'" ;;
  esac
}

format_hms() {
  printf '%02d:%02d:%02d\n' "$(($1 / 3600))" "$(($1 % 3600 / 60))" "$(($1 % 60))"
}

require_path MMT_SPEC_DIR "${MMT_SPEC_DIR:-}"
require_path MMT_RUNNER "${MMT_RUNNER:-}"
[ -d "$MMT_SPEC_DIR" ] || fail "MMT_SPEC_DIR is not a directory: $MMT_SPEC_DIR"
# The work directory is shared with the compute nodes: a runner missing here fails the
# submission now instead of a batch job that cannot start it.
[ -x "$MMT_RUNNER" ] || fail "MMT_RUNNER is not executable: $MMT_RUNNER"
require_count MMT_GPU_COUNT "${MMT_GPU_COUNT:-}"
require_count MMT_ARRAY_SIZE "${MMT_ARRAY_SIZE:-}"
[ "$MMT_ARRAY_SIZE" -ge 1 ] || fail "MMT_ARRAY_SIZE must be at least 1"
resource_type=$(resource_type_for_gpus "$MMT_GPU_COUNT") ||
  fail "a Job can use at most one node's GPUs here; it requested $MMT_GPU_COUNT"

# The job name only helps people reading qstat; the first Job ID is a UUID, and a Grid Engine
# job name must not start with a digit.
first_job_id=${MMT_JOB_IDS:-}
first_job_id=${first_job_id%%,*}
case "$first_job_id" in
  '' | *[!0-9A-Fa-f-]*) fail "MMT_JOB_IDS must start with a Job ID: '${MMT_JOB_IDS:-}'" ;;
esac
job_name="mmt-$(printf '%.8s' "$first_job_id")"

# The batch script needs the limit in seconds to warn the runner before h_rt.
if [ -n "${MMT_WALLTIME:-}" ]; then
  case "$MMT_WALLTIME" in
    *[!0-9:]* | *:*:*:*) fail "MMT_WALLTIME must be HH:MM:SS: '$MMT_WALLTIME'" ;;
    [0-9]*:[0-5][0-9]:[0-5][0-9]) walltime=$MMT_WALLTIME ;;
    *) fail "MMT_WALLTIME must be HH:MM:SS: '$MMT_WALLTIME'" ;;
  esac
  require_count MMT_WALLTIME_SECONDS "${MMT_WALLTIME_SECONDS:-}"
else
  MMT_WALLTIME_SECONDS=$DEFAULT_WALLTIME_SECONDS
  walltime=$(format_hms "$MMT_WALLTIME_SECONDS")
fi
export MMT_WALLTIME_SECONDS

# Per-person value from the personal settings: the TSUBAME group charged for the Job (-g).
require_word MMT_VAR_GROUP "${MMT_VAR_GROUP:-}"

command -v qsub >/dev/null 2>&1 || fail "qsub is not in PATH on this login node"

# ---- Batch script (runs on the compute node) ----------------------------------------------
batch_file="$MMT_SPEC_DIR/batch.sh"
cat >"$batch_file" <<'BATCH'
#!/bin/bash
# Written by job.sh. Constant text: the request reaches it only as the environment passed with
# qsub -v. Keep the work before the runner small: a script that stops here leaves the Job
# "submitted" in tracking until the site's queue timeout, because only the runner reports.
set -u
: "${MMT_SPEC_DIR:?}" "${MMT_RUNNER:?}" "${MMT_ARRAY_SIZE:?}" "${MMT_WALLTIME_SECONDS:?}"

# Site settings: make the container runtime available to the runner, and let the compute node
# reach the runner API when it has no direct route to the internet. Examples only.
# module load apptainer
# export https_proxy=http://proxy.example.org:3128 HTTPS_PROXY=http://proxy.example.org:3128

# Submitted with -t 1-N: Grid Engine task IDs start at 1.
if [ "$MMT_ARRAY_SIZE" -gt 1 ]; then
  MMT_ARRAY_INDEX=$((SGE_TASK_ID - 1))
else
  MMT_ARRAY_INDEX=0
fi
export MMT_ARRAY_INDEX

# h_rt ends the job with SIGKILL and no warning, so the runner gets SIGTERM this long before
# the limit; it then stops its container and ends the Job as timed_out.
TIMEOUT_NOTICE_SECONDS=120
"$MMT_RUNNER" "$MMT_SPEC_DIR" &
runner_pid=$!
trap 'kill -TERM "$runner_pid" 2>/dev/null' TERM
notice_pid=
if [ "$MMT_WALLTIME_SECONDS" -gt "$TIMEOUT_NOTICE_SECONDS" ]; then
  # The timer ends its sleep when it is stopped, so no process outlives this script.
  (
    trap 'kill "$sleep_pid" 2>/dev/null; exit 0' TERM
    sleep "$((MMT_WALLTIME_SECONDS - TIMEOUT_NOTICE_SECONDS))" &
    sleep_pid=$!
    wait "$sleep_pid" && kill -TERM "$runner_pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  notice_pid=$!
fi
# A trapped signal ends wait early; wait again until the runner has exited.
status=0
while kill -0 "$runner_pid" 2>/dev/null; do
  wait "$runner_pid"
  status=$?
done
if [ -n "$notice_pid" ]; then
  kill "$notice_pid" 2>/dev/null
fi
exit "$status"
BATCH
chmod 700 "$batch_file"

# ---- Submission ---------------------------------------------------------------------------
# -r n: tracking retries Jobs itself; a rerun by Grid Engine would start a second runner.
# Grid Engine itself replaces $TASK_ID in the log path (it stays "undefined" outside an array).
# shellcheck disable=SC2016
set -- -terse -N "$job_name" -g "$MMT_VAR_GROUP" -l "$resource_type=1" -l "h_rt=$walltime" \
  -r n -j y -o "$MMT_SPEC_DIR/"'scheduler.$TASK_ID.log' -S /bin/bash \
  -v MMT_SPEC_DIR,MMT_RUNNER,MMT_ARRAY_SIZE,MMT_WALLTIME_SECONDS
if [ "$MMT_ARRAY_SIZE" -gt 1 ]; then
  set -- "$@" -t "1-$MMT_ARRAY_SIZE"
fi

# -terse prints "<job ID>", or "<job ID>.1-N:1" for an array; the array is canceled by its job
# ID. stdin is closed so that qsub never reads the rest of this script from standard input.
output=$(qsub "$@" "$batch_file" </dev/null)
scheduler_job_id=$(printf '%s\n' "$output" | sed -n '$p')
scheduler_job_id=${scheduler_job_id%%.*}
case "$scheduler_job_id" in
  '' | *[!0-9]*) fail "qsub printed no job ID: '$output'" ;;
esac
printf '%s\n' "$scheduler_job_id"
