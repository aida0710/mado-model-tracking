#!/bin/sh
# Job shell for PBS Professional. The option values follow ABCI 3.0 and are examples only:
# adapt the site settings below (deploy/sites/examples/pbs/README.md).
#
# The launcher, or `mado-tracking submit`, runs this file on a login node with the request in
# MMT_* environment variables (deploy/sites/README.md). Request values never become script
# text: they reach qsub only as separate, validated arguments, and the batch script written
# below is a constant that reads them from its own environment on the compute node.
# Standard output carries only the scheduler job ID, on the last line; messages go to stderr.
set -eu
umask 077

# ---- Site settings ------------------------------------------------------------------------
# Time limit of a Job that sets none. Keep it within the queue's maximum.
DEFAULT_WALLTIME_SECONDS=3600
# One Job runs on one node, so it can use at most the GPUs of one node.
MAX_GPUS_PER_NODE=8

# The resource type (ABCI: -q) that holds the requested GPUs. A site with generic PBS resources
# drops -q and requests "-l select=1:ngpus=N" instead (README.md).
resource_type_for_gpus() {
  case "$1" in
    0) echo rt_HC ;; # CPUs only
    1) echo rt_HG ;; # one GPU on a shared node
    *) echo rt_HF ;; # a whole node
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
[ "$MMT_GPU_COUNT" -le "$MAX_GPUS_PER_NODE" ] ||
  fail "a Job can use at most $MAX_GPUS_PER_NODE GPUs (one node) here; it requested $MMT_GPU_COUNT"

# The job name only helps people reading qstat; the first Job ID is a UUID.
first_job_id=${MMT_JOB_IDS:-}
first_job_id=${first_job_id%%,*}
case "$first_job_id" in
  '' | *[!0-9A-Fa-f-]*) fail "MMT_JOB_IDS must start with a Job ID: '${MMT_JOB_IDS:-}'" ;;
esac
job_name="mmt-$(printf '%.8s' "$first_job_id")"

if [ -n "${MMT_WALLTIME:-}" ]; then
  case "$MMT_WALLTIME" in
    *[!0-9:]* | *:*:*:*) fail "MMT_WALLTIME must be HH:MM:SS: '$MMT_WALLTIME'" ;;
    [0-9]*:[0-5][0-9]:[0-5][0-9]) walltime=$MMT_WALLTIME ;;
    *) fail "MMT_WALLTIME must be HH:MM:SS: '$MMT_WALLTIME'" ;;
  esac
else
  walltime=$(format_hms "$DEFAULT_WALLTIME_SECONDS")
fi

# Per-person value from the personal settings: the ABCI group charged for the Job (-P).
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
: "${MMT_SPEC_DIR:?}" "${MMT_RUNNER:?}" "${MMT_ARRAY_SIZE:?}"

# Site settings: make the container runtime available to the runner, and let the compute node
# reach the runner API when it has no direct route to the internet. Examples only.
# source /etc/profile.d/modules.sh
# module load singularitypro
# export https_proxy=http://proxy.example.org:3128 HTTPS_PROXY=http://proxy.example.org:3128

# Submitted with -J 0-(N-1), so PBS_ARRAY_INDEX already counts from 0.
if [ "$MMT_ARRAY_SIZE" -gt 1 ]; then
  MMT_ARRAY_INDEX=$PBS_ARRAY_INDEX
else
  MMT_ARRAY_INDEX=0
fi
export MMT_ARRAY_INDEX

# PBS sends SIGTERM at the time limit (then SIGKILL after the queue's kill_delay); the runner
# stops its container and ends the Job as timed_out.
exec "$MMT_RUNNER" "$MMT_SPEC_DIR"
BATCH
chmod 700 "$batch_file"

# ---- Submission ---------------------------------------------------------------------------
resource_type=$(resource_type_for_gpus "$MMT_GPU_COUNT")
# -r n: tracking retries Jobs itself; a rerun by PBS would start a second runner for the Job.
set -- -N "$job_name" -P "$MMT_VAR_GROUP" -q "$resource_type" -l select=1 \
  -l "walltime=$walltime" -r n -j oe -S /bin/bash -v MMT_SPEC_DIR,MMT_RUNNER,MMT_ARRAY_SIZE
if [ "$MMT_ARRAY_SIZE" -gt 1 ]; then
  # PBS replaces ^array_index^ with each subjob's index.
  set -- "$@" -J "0-$((MMT_ARRAY_SIZE - 1))" -o "$MMT_SPEC_DIR/scheduler.^array_index^.log"
else
  set -- "$@" -o "$MMT_SPEC_DIR/scheduler.log"
fi

# qsub prints only the ID (12345.server, or 12345[].server for an array); stdin is closed so
# that qsub never reads the rest of this script when it arrives on standard input.
output=$(qsub "$@" "$batch_file" </dev/null)
scheduler_job_id=$(printf '%s\n' "$output" | sed -n '$p')
case "$scheduler_job_id" in
  '' | *[!]A-Za-z0-9._@[-]*) fail "qsub printed no job ID: '$output'" ;;
esac
printf '%s\n' "$scheduler_job_id"
