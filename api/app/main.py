from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings
from app.db import router as db_router
from app.local import router as local_router
from app.portal_data import (
    router as portal_data_router,
    system_events_router,
)
from app.rfid import router as rfid_router
from app.rfid_ingest import router as rfid_ingest_router
from app.screens import router as screens_router
from app.settings import router as settings_router
from app.setup import router as setup_router
from app.alerts import router as alerts_router
from app.audio import router as audio_router
from app.update import router as update_router
from app.notifier import router as notify_router

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Status snapshot multicast broadcaster (5s heartbeat + on-change).
    from app import status_broadcast  # noqa: PLC0415
    from app import tz_auto  # noqa: PLC0415

    task = status_broadcast.start()
    tz_task = tz_auto.start()
    try:
        yield
    finally:
        await tz_auto.stop(tz_task)
        await status_broadcast.stop(task)


app = FastAPI(
    title="StackPI API",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(local_router)
app.include_router(settings_router)
app.include_router(db_router)
app.include_router(rfid_router)
app.include_router(rfid_ingest_router)
app.include_router(screens_router)
app.include_router(portal_data_router)
app.include_router(system_events_router)
app.include_router(setup_router)
app.include_router(alerts_router)
app.include_router(audio_router)
app.include_router(update_router)
app.include_router(notify_router)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "message": "StackPI API is running",
    }


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.environment,
    }
