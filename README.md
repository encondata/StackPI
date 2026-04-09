# StackPI_v2

StackPI_v2 is a Raspberry Pi 5 deployable full-stack application built around a Python backend, a separate Python worker service, a Next.js admin dashboard, PostgreSQL for persistence, and Caddy as the reverse proxy.

The project is designed to be developed primarily on macOS and deployed to a Raspberry Pi through a repeatable GitHub pull plus bash deploy workflow. The deployment model favors native Linux services with `systemd` over containers for a simpler, lighter-weight v1 on a single Pi host.

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
- Caddy as the reverse proxy
- `systemd` for service management on the Raspberry Pi
- GitHub as the deployment source of truth

## Why This Stack

This system appears orchestration-heavy, integration-heavy, and database-heavy rather than focused on low-level compute performance. That makes Python the better fit for development speed, maintainability, and operational simplicity.

Next.js is the preferred choice for the portal because it builds on React knowledge, supports a mature admin interface ecosystem, and provides a clear path for scaling the dashboard into a full application instead of a thin generated admin surface.

Caddy is recommended over Nginx for a single-host deployment because its configuration and HTTPS story are usually simpler for this kind of setup.

## High-Level Architecture

Run the app as separate services:

- Caddy
- FastAPI API service
- Python logic-engine worker
- PostgreSQL
- Next.js portal

Request and processing flow:

1. An inbound request reaches FastAPI through Caddy.
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
    caddy/
      Caddyfile
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
- `deploy/`: Raspberry Pi bootstrap scripts, deploy scripts, Caddy config, and `systemd` units
- `scripts/`: local utility scripts for development and operations
- `docs/`: project planning and architecture documentation

## Deployment Model

The initial target is a single Raspberry Pi host running native Linux services:

- Caddy as a system service
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
6. Wire Caddy routes
7. Add `systemd` unit files
8. Write `bootstrap-pi.sh`
9. Write `deploy.sh`

## Project Brief

Build a Raspberry Pi 5 deployable full-stack application using FastAPI for the API, a separate Python worker service for the logic engine, Next.js with TypeScript for the admin dashboard, PostgreSQL for persistence, and Caddy as the reverse proxy. Develop primarily on macOS, deploy to the Pi via GitHub pull plus bash deploy scripts, use `systemd` for service management, keep the project in its own repo, and structure the codebase so a fresh Pi can be bootstrapped entirely from scripts.

## Next Step

The next practical step is to scaffold the repository layout and add the first working slice:

- FastAPI health check
- database wiring
- worker process skeleton
- Next.js admin shell
- deployment placeholders for Caddy and `systemd`
