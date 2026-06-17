# StackPI_v2

StackPI_v2 is a Raspberry Pi 5 deployable full-stack application built around a Python backend, a separate Python worker service, a Next.js admin dashboard, PostgreSQL for persistence, and Nginx as the reverse proxy.

The project is designed to be developed primarily on macOS and deployed to a Raspberry Pi through a repeatable GitHub pull plus bash deploy workflow. The deployment model favors native Linux services with `systemd` over containers for a simpler, lighter-weight v1 on a single Pi host.

## Setup (fresh Raspberry Pi)

Provision a fresh Pi from scratch with one command. Run it **as the `csg` user** (it uses `sudo` where root is needed), with the USB snapshot drive plugged in at `/dev/sda1`:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/main/deploy/bootstrap.sh | bash
```

The [`deploy/bootstrap.sh`](deploy/bootstrap.sh) script:

1. Installs `git`
2. Clones the repo into `/home/csg/StackPI_v2`
3. Runs [`deploy/install.sh`](deploy/install.sh) — system packages + Node 20 (NodeSource) + pgweb
4. Runs [`deploy/scripts/setup-pg-memcluster.sh`](deploy/scripts/setup-pg-memcluster.sh) — RAM Postgres cluster + USB snapshots
5. Runs [`deploy/deploy.sh`](deploy/deploy.sh) — builds API/engine/portal, installs `systemd` units, applies migrations

**Requirements:** the Pi user must be `csg`, and the USB snapshot drive must be present at `/dev/sda1`.

**Options (env vars):** `REPO_URL`, `BRANCH`, `TARGET_DIR`, and `SKIP_DB=1` (skip the database step for a dry run without the USB).

**One manual follow-up** — enable the kiosk display session once the Pi is at `multi-user.target` with the display manager disabled:

```bash
sudo systemctl enable --now stackpi-kiosk
```

**Updating an already-provisioned Pi:** re-run the same one-liner (it fast-forwards the checkout), or just `bash ~/StackPI_v2/deploy/deploy.sh`.

## Recommended Stack

### Backend

- FastAPI for inbound and internal APIs
- Python for the logic engine / worker service
- Pydantic for request and response validation
- SQLAlchemy 2.x for database access
- Alembic for schema migrations

### Frontend

- Next.js with TypeScript
- App Router
- Tailwind CSS
- `shadcn/ui` or a similar component kit for admin UI primitives

### Data and Ops

- PostgreSQL for storage
- Nginx as the reverse proxy
- `systemd` for service management on the Raspberry Pi
- GitHub as the deployment source of truth

## Why This Stack

This system appears orchestration-heavy, integration-heavy, and database-heavy rather than focused on low-level compute performance. That makes Python the better fit for development speed, maintainability, and operational simplicity.

Next.js is the preferred choice for the portal because it builds on React knowledge, supports a mature admin interface ecosystem, and provides a clear path for scaling the dashboard into a full application instead of a thin generated admin surface.

Nginx is used as the reverse proxy to stay consistent with the reverse proxy already in use elsewhere in the operator's infrastructure.

## High-Level Architecture

Run the app as separate services:

- Nginx
- FastAPI API service
- Python logic-engine worker
- PostgreSQL
- Next.js portal

Request and processing flow:

1. An inbound request reaches FastAPI through Nginx.
2. FastAPI validates the request and writes state to PostgreSQL.
3. FastAPI creates work items, status records, or both.
4. The Python worker processes long-running business logic.
5. The dashboard reads state through API endpoints backed by PostgreSQL.

This separation keeps long-running or failure-prone work out of request handlers and makes scaling, debugging, and restart behavior easier to reason about.

## Repository Layout

Suggested repo structure:

```text
project-root/
  api/
    app/
    tests/
  engine/
    app/
    tests/
  portal/
    src/
    public/
  db/
    migrations/
  deploy/
    bootstrap-pi.sh
    deploy.sh
    services/
      app-api.service
      app-engine.service
      app-portal.service
    nginx/
      stackpi.conf
  scripts/
  docs/
    project-spec.md
  .env.example
  README.md
```

Folder responsibilities:

- `api/`: FastAPI routes, schemas, auth, API models, and HTTP-facing logic
- `engine/`: business rules, queue or job processing, and scheduled/background tasks
- `portal/`: Next.js admin dashboard
- `db/`: Alembic migrations and database setup artifacts
- `deploy/`: Raspberry Pi bootstrap scripts, deploy scripts, Nginx config, and `systemd` units
- `scripts/`: local utility scripts for development and operations
- `docs/`: project planning and architecture documentation

## Deployment Model

The initial target is a single Raspberry Pi host running native Linux services:

- Nginx as a system service
- PostgreSQL as a system service
- FastAPI as a `systemd` unit
- Python worker as a `systemd` unit
- Next.js as a `systemd` unit

This keeps v1 simple to inspect and debug. The long-term deployment path should still be scriptable and reproducible from a fresh Pi.

## Development Workflow

- Build and iterate primarily on macOS
- Use the Pi as the real deployment and integration target
- Push changes to GitHub
- Pull changes onto the Pi
- Run a repeatable deploy script

Avoid manually building the full system on the Pi first and trying to automate later. A scripted deployment path should exist from the beginning.

## First Implementation Milestones

Recommended build order:

1. Scaffold the repo structure
2. Stand up a FastAPI health endpoint
3. Stand up PostgreSQL connectivity and migrations
4. Create the worker skeleton
5. Create the Next.js admin shell
6. Wire Nginx routes
7. Add `systemd` unit files
8. Write `bootstrap-pi.sh`
9. Write `deploy.sh`

## Project Brief

Build a Raspberry Pi 5 deployable full-stack application using FastAPI for the API, a separate Python worker service for the logic engine, Next.js with TypeScript for the admin dashboard, PostgreSQL for persistence, and Nginx as the reverse proxy. Develop primarily on macOS, deploy to the Pi via GitHub pull plus bash deploy scripts, use `systemd` for service management, keep the project in its own repo, and structure the codebase so a fresh Pi can be bootstrapped entirely from scripts.

## Next Step

The next practical step is to scaffold the repository layout and add the first working slice:

- FastAPI health check
- database wiring
- worker process skeleton
- Next.js admin shell
- deployment placeholders for Nginx and `systemd`

## Current Status

The first backend slice is now defined in `api/`:

- FastAPI project metadata in [api/pyproject.toml](/Users/jrh1812/Desktop/StackPI_v2/api/pyproject.toml)
- app entrypoint in [api/app/main.py](/Users/jrh1812/Desktop/StackPI_v2/api/app/main.py)
- settings in [api/app/config.py](/Users/jrh1812/Desktop/StackPI_v2/api/app/config.py)
- smoke test in [api/tests/test_health.py](/Users/jrh1812/Desktop/StackPI_v2/api/tests/test_health.py)
