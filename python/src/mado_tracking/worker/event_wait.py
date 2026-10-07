"""Wait for a shutdown event or the next heartbeat/poll interval."""

import asyncio


async def wait_interval(event: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(event.wait(), timeout=seconds)
    except TimeoutError:
        pass
