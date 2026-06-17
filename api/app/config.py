from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "stackpi-api"
    environment: str = "development"
    api_host: str = "127.0.0.1"
    api_port: int = 8000

    # BaseCamp API the engine pairs against — also used by /local/* actions
    # that need to call BaseCamp directly (deregister).
    api_base_url: str = "https://api.serversherpa.com"
    http_timeout_seconds: int = 15

    # Path the engine writes its registration state to. Read by /local/status.
    state_file: str = "/var/lib/stackpi/state.json"

    model_config = SettingsConfigDict(
        env_prefix="STACKPI_",
        env_file=".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
