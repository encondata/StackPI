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

settings = get_settings()


app = FastAPI(
    title="StackPI API",
    version="0.1.0",
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
