#!/bin/sh
# Job shell for a GPU host reached over SSH that runs containers with Docker and has no
# scheduler (README.md). The runner leases free GPUs itself (gpu_assignment = "lease") and
# reports to tracking; this script only starts it detached from the SSH session and returns.
#
# The launcher runs this file on the host with the request in MMT_* environment variables
# (../../README.md). Request values never become script text: the runner script written below is
# a constant that reads them from its environment.
# Standard output stays empty: a direct host has no scheduler job ID. Messages go to stderr.
set -eu
umask 077

# ---- Site settings ------------------------------------------------------------------------
# After the time limit's SIGTERM, the runner is killed if it is still running this long later.
STOP_GRACE_SECONDS=60

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

require_path() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute path: '$2'" ;;
  esac
  case "$2" in
    *[!A-Za-z0-9._/+@-]*) fail "$1 has characters this job shell does not pass on: '$2'" ;;
  esac
}

require_path MMT_SPEC_DIR "${MMT_SPEC_DIR:-}"
require_path MMT_RUNNER "${MMT_RUNNER:-}"
[ -d "$MMT_SPEC_DIR" ] || fail "MMT_SPEC_DIR is not a directory: $MMT_SPEC_DIR"
# A runner that cannot start would never report, so this fails the submission instead.
[ -x "$MMT_RUNNER" ] || fail "MMT_RUNNER is not executable: $MMT_RUNNER"
require_count MMT_ARRAY_SIZE "${MMT_ARRAY_SIZE:-}"
[ "$MMT_ARRAY_SIZE" -ge 1 ] || fail "MMT_ARRAY_SIZE must be at least 1"
if [ -n "${MMT_WALLTIME_SECONDS:-}" ]; then
  require_count MMT_WALLTIME_SECONDS "$MMT_WALLTIME_SECONDS"
  [ "$MMT_WALLTIME_SECONDS" -ge 1 ] || fail "MMT_WALLTIME_SECONDS must be at least 1"
fi
# The runner checks MMT_GPU_COUNT against the GPUs it may lease and Docker itself, and reports a
# Job that can never start here as failed.

# ---- Runner script ------------------------------------------------------------------------
runner_file="$MMT_SPEC_DIR/run.sh"
cat >"$runner_file" <<'RUNNER'
#!/bin/sh
# Written by job.sh. Constant text: the request reaches it only as the environment.
set -u
: "${MMT_SPEC_DIR:?}" "${MMT_RUNNER:?}" "${MMT_ARRAY_INDEX:?}" "${MMT_STOP_GRACE_SECONDS:?}"
if [ -z "${MMT_WALLTIME_SECONDS:-}" ]; then
  exec "$MMT_RUNNER" "$MMT_SPEC_DIR"
fi
# No scheduler enforces the time limit here: timeout sends the runner SIGTERM when it is up, and
# the runner stops its container and ends the Job as timed_out. The limit counts from this
# start, so the time the runner waits for free GPUs is part of it. --foreground signals only the
# runner, which stops the container itself.
exec timeout --foreground --signal=TERM --kill-after="$MMT_STOP_GRACE_SECONDS" \
  "$MMT_WALLTIME_SECONDS" "$MMT_RUNNER" "$MMT_SPEC_DIR"
RUNNER
chmod 700 "$runner_file"

# ---- Start ---------------------------------------------------------------------------------
# Each member of an array gets its own runner, which waits for its GPUs on this host.
MMT_STOP_GRACE_SECONDS=$STOP_GRACE_SECONDS
export MMT_STOP_GRACE_SECONDS
index=0
while [ "$index" -lt "$MMT_ARRAY_SIZE" ]; do
  MMT_ARRAY_INDEX=$index
  export MMT_ARRAY_INDEX
  log_file="$MMT_SPEC_DIR/runner.$index.log"
  # A new session and closed descriptors let the SSH session end while the runner goes on.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$runner_file" </dev/null >>"$log_file" 2>&1 &
  else
    nohup "$runner_file" </dev/null >>"$log_file" 2>&1 &
  fi
  index=$((index + 1))
done
