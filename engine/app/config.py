from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "stackpi-engine"
    environment: str = "development"

    api_base_url: str = "https://api.serversherpa.com"
    # The on-device API the engine reads operator config from (e.g. the
    # heartbeat interval set on /config). Localhost; not the cloud.
    local_api_base: str = "http://127.0.0.1:8000"
    # Where the BaseCamp portal serves the /link?token=... page. Used to
    # prefix relative link_urls returned by /register/init so the QR encodes
    # a fully-qualified URL. The server-side STACKPI_LINK_URL_BASE is the
    # canonical fix; this is the Pi-side fallback while that's unset.
    pairing_link_base: str = "https://portal.serversherpa.com"
    state_file: str = "/var/lib/stackpi/state.json"

    heartbeat_interval_seconds: int = 30
    pairing_poll_interval_seconds: int = 5
    http_timeout_seconds: int = 15

    # Optional override; falls back to socket.gethostname() at runtime.
    device_name: Optional[str] = None

    model_config = SettingsConfigDict(
        env_prefix="STACKPI_",
        env_file=".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
