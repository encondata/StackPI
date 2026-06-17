"""StackPI engine entrypoint.

Runs the registration + heartbeat agent. Designed to be invoked by
systemd (`python -m app.main`) but can also be run directly for local
testing.
"""
import logging
import signal
import sys

from app.agent import run_agent
from app.config import get_settings

LOG_FORMAT = "%(asctime)s %(levelname)-7s [%(name)s] %(message)s"


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format=LOG_FORMAT,
        stream=sys.stdout,
    )


def _install_signal_handlers() -> None:
    def _graceful(_sig: int, _frame) -> None:  # type: ignore[no-untyped-def]
        logging.getLogger(__name__).info("Received termination signal; shutting down.")
        sys.exit(0)

    signal.signal(signal.SIGINT, _graceful)
    signal.signal(signal.SIGTERM, _graceful)


def main() -> None:
    _setup_logging()
    _install_signal_handlers()
    settings = get_settings()
    log = logging.getLogger(__name__)
    log.info(
        "Starting %s (env=%s) against API %s",
        settings.app_name, settings.environment, settings.api_base_url,
    )
    log.info("State file: %s", settings.state_file)
    run_agent(settings)


if __name__ == "__main__":
    main()
