#!/bin/sh
# Job shell for Slurm. The partition, CPU count and account variable are examples only: adapt
# the site settings below (deploy/sites/examples/slurm/README.md).
#
# The launcher, or `mado-tracking submit`, runs this file on a login node with the request in
# MMT_* environment variables (deploy/sites/README.md). Request values never become script
# text: they reach sbatch only as separate, validated arguments, and the batch script written
# below is a constant that reads them from its own environment on the compute node.
# Standard output carries only the scheduler job ID, on the last line; messages go to stderr.
set -eu
umask 077

# ---- Site settings ------------------------------------------------------------------------
PARTITION=gpu
CPUS_PER_TASK=8
# One Job runs on one node, so it can use at most the GPUs of one node.
MAX_GPUS_PER_NODE=8
# Time limit of a Job that sets none. Keep it within the partition's MaxTime.
DEFAULT_WALLTIME_SECONDS=3600
# Slurm sends SIGTERM this long before the time limit, so the runner can stop its container
# and end the Job as timed_out before SIGKILL.
TIMEOUT_NOTICE_SECONDS=120

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

# An absolute path whose characters pass through sbatch's options unchanged.
require_path() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute path: '$2'" ;;
  esac
  case "$2" in
    *[!A-Za-z0-9._/+@-]*) fail "$1 has characters this job shell does not pass on: '$2'" ;;
  esac
}

# A scheduler option value such as an account name.
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
[ "$MMT_GPU_COUNT" -le "$MAX_GPUS_PER_NODE" ] ||
  fail "a Job can use at most $MAX_GPUS_PER_NODE GPUs (one node) here; it requested $MMT_GPU_COUNT"

# The job name only helps people reading squeue; the first Job ID is a UUID.
first_job_id=${MMT_JOB_IDS:-}
first_job_id=${first_job_id%%,*}
case "$first_job_id" in
  '' | *[!0-9A-Fa-f-]*) fail "MMT_JOB_IDS must start with a Job ID: '${MMT_JOB_IDS:-}'" ;;
esac
job_name="mmt-$(printf '%.8s' "$first_job_id")"

# Slurm also reads HH:MM:SS with more than 24 hours.
if [ -n "${MMT_WALLTIME:-}" ]; then
  case "$MMT_WALLTIME" in
    *[!0-9:]* | *:*:*:*) fail "MMT_WALLTIME must be HH:MM:SS: '$MMT_WALLTIME'" ;;
    [0-9]*:[0-5][0-9]:[0-5][0-9]) walltime=$MMT_WALLTIME ;;
    *) fail "MMT_WALLTIME must be HH:MM:SS: '$MMT_WALLTIME'" ;;
  esac
else
  walltime=$(format_hms "$DEFAULT_WALLTIME_SECONDS")
fi

command -v sbatch >/dev/null 2>&1 || fail "sbatch is not in PATH on this login node"

# ---- Batch script (runs on the compute node) ----------------------------------------------
batch_file="$MMT_SPEC_DIR/batch.sh"
cat >"$batch_file" <<'BATCH'
#!/bin/bash
# Written by job.sh. Constant text: the request reaches it only as the environment exported by
# sbatch. Keep the work before the runner small: a script that stops here leaves the Job
# "submitted" in tracking until the site's queue timeout, because only the runner reports.
set -u
: "${MMT_SPEC_DIR:?}" "${MMT_RUNNER:?}" "${MMT_ARRAY_SIZE:?}"

# Site settings: make the container runtime available to the runner, and let the compute node
# reach the runner API when it has no direct route to the internet. Examples only.
# module load apptainer
# export https_proxy=http://proxy.example.org:3128 HTTPS_PROXY=http://proxy.example.org:3128

# Submitted with --array=0-(N-1), so SLURM_ARRAY_TASK_ID already counts from 0.
if [ "$MMT_ARRAY_SIZE" -gt 1 ]; then
  MMT_ARRAY_INDEX=$SLURM_ARRAY_TASK_ID
else
  MMT_ARRAY_INDEX=0
fi
export MMT_ARRAY_INDEX

# --signal=B:TERM@<seconds> reaches this process, the runner, before the time limit.
exec "$MMT_RUNNER" "$MMT_SPEC_DIR"
BATCH
chmod 700 "$batch_file"

# ---- Submission ---------------------------------------------------------------------------
# --no-requeue: tracking retries Jobs itself; a requeue by Slurm would start a second runner.
set -- --parsable --job-name="$job_name" --partition="$PARTITION" --nodes=1 --ntasks=1 \
  --cpus-per-task="$CPUS_PER_TASK" --time="$walltime" \
  --signal="B:TERM@$TIMEOUT_NOTICE_SECONDS" --no-requeue --export=ALL
if [ "$MMT_GPU_COUNT" -gt 0 ]; then
  set -- "$@" --gres="gpu:$MMT_GPU_COUNT"
fi
# Per-person value from the personal settings, when the site charges an account.
if [ -n "${MMT_VAR_ACCOUNT:-}" ]; then
  require_word MMT_VAR_ACCOUNT "$MMT_VAR_ACCOUNT"
  set -- "$@" --account="$MMT_VAR_ACCOUNT"
fi
if [ "$MMT_ARRAY_SIZE" -gt 1 ]; then
  # Slurm replaces %A with the array's job ID and %a with the task index.
  set -- "$@" --array="0-$((MMT_ARRAY_SIZE - 1))" --output="$MMT_SPEC_DIR/scheduler.%A_%a.log"
else
  set -- "$@" --output="$MMT_SPEC_DIR/scheduler.%j.log"
fi

# --parsable prints "<job ID>" or "<job ID>;<cluster>"; stdin is closed so that sbatch never
# reads the rest of this script when it arrives on standard input.
output=$(sbatch "$@" "$batch_file" </dev/null)
scheduler_job_id=$(printf '%s\n' "$output" | sed -n '$p')
scheduler_job_id=${scheduler_job_id%%;*}
case "$scheduler_job_id" in
  '' | *[!0-9_]*) fail "sbatch printed no job ID: '$output'" ;;
esac
printf '%s\n' "$scheduler_job_id"
