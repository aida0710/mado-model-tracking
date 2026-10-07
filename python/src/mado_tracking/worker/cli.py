"""Environment-based worker entrypoint; diagnostics are sanitized and never dump config."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal

from ..errors import ApiError, ConfigurationError
from .config import WorkerSettings
from .service import Worker


async def run(settings: WorkerSettings, *, once: bool) -> None:
    worker = Worker(settings)
    loop = asyncio.get_running_loop()
    for signal_number in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signal_number, worker.stopping.set)
    if not once:
        await worker.run_forever()
        return
    worker.journal.acquire_worker_lock()
    try:
        jobs = await worker.recover()
        if not jobs:
            job = await worker.api.claim(settings.worker_id, settings.target_ids)
            jobs = [job] if job is not None else []
        for job in jobs:
            await worker.run_job(job)
    finally:
        worker.journal.close()
        await worker.api.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Mado Model Tracking compute worker")
    parser.add_argument("--once", action="store_true", help="Recover / claim one batch, then exit")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = WorkerSettings.from_environment()
        asyncio.run(run(settings, once=arguments.once))
    except (ConfigurationError, ApiError) as error:
        logging.getLogger("mado_tracking.worker").error("%s", str(error))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
