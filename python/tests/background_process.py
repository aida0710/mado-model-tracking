"""Real process fixtures whose children retain their entrypoint's output pipes."""

from __future__ import annotations


def entrypoint_with_background_child(
    *, ignore_sigterm: bool, redirected: bool = False, exit_code: int = 0
) -> str:
    child_source = f"""
import os, signal, sys, time
from pathlib import Path

def terminate(_signal, _frame):
    print('child cleanup stdout', flush=True)
    print('child cleanup stderr ' + os.environ['TEST_SECRET'], file=sys.stderr, flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, signal.SIG_IGN if {ignore_sigterm!r} else terminate)
Path('child.pid').write_text(str(os.getpid()))
print('child stdout ' + os.environ['TEST_SECRET'], flush=True)
print('child stderr ' + os.environ['TEST_SECRET'], file=sys.stderr, flush=True)
Path('child.ready').touch()
# This child must be stopped by the runner, well before this natural lifetime ends.
time.sleep(60)
"""
    redirection = ", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL" if redirected else ""
    return f"""
import subprocess, sys, time
from pathlib import Path

# Startup must be observed before the entrypoint exits or sends its final logs.
READY_POLL_SECONDS = 0.01
child = subprocess.Popen([sys.executable, '-c', {child_source!r}]{redirection})
while not Path('child.ready').exists():
    if child.poll() is not None:
        raise RuntimeError('Background child failed during startup')
    time.sleep(READY_POLL_SECONDS)
print('entrypoint exit={exit_code}', flush=True)
print('entrypoint stderr', file=sys.stderr, flush=True)
sys.exit({exit_code})
"""
