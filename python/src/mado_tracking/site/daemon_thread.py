"""Await a blocking call that runs in a daemon thread.

asyncio.to_thread uses the loop's executor, whose threads the interpreter waits for at exit; a
runner stopped by its scheduler must be able to finish while a download is still blocked.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any, TypeVar

Result = TypeVar("Result")


def _set_result(future: asyncio.Future[Result], result: Result) -> None:
    if not future.done():
        future.set_result(result)


def _set_exception(future: asyncio.Future[Any], error: BaseException) -> None:
    if not future.done():
        future.set_exception(error)


async def run_in_daemon_thread(function: Callable[[], Result], *, name: str = "mmt-runner") -> Result:
    loop = asyncio.get_running_loop()
    future: asyncio.Future[Result] = loop.create_future()

    def target() -> None:
        try:
            result = function()
        except BaseException as error:
            # The error belongs to the awaiting coroutine, like asyncio.to_thread's.
            outcome: tuple[Callable[..., None], Any] = (_set_exception, error)
        else:
            outcome = (_set_result, result)
        try:
            loop.call_soon_threadsafe(outcome[0], future, outcome[1])
        except RuntimeError:
            # The loop closed while this thread ran; nobody waits for the result any more.
            pass

    threading.Thread(target=target, name=name, daemon=True).start()
    return await future
