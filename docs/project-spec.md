# Project Spec

## Overview

StackPI_v2 is a full-stack application intended to run on a Raspberry Pi 5 as a single-host deployment target. The system should support inbound API requests, asynchronous or long-running business logic, an admin dashboard, persistent storage, and a deployment model that can be fully bootstrapped from scripts.

The development environment is macOS. The production and integration target is Raspberry Pi OS or another Debian-based Linux distribution suitable for the Pi.

## Goals

- Build a maintainable full-stack system that is easy to develop locally
- Keep deployment simple enough to manage on a single Raspberry Pi host
- Separate request handling from long-running business logic
- Ensure the system can be bootstrapped on a fresh Pi with scripts
- Support a clean GitHub-based pull-and-deploy workflow

## Non-Goals For V1

- Kubernetes orchestration
- Multi-host clustering
- Complex service mesh or container orchestration
- A Python-generated admin UI
- Premature optimization around low-level compute throughput

## Core Technology Decisions

### API Service

- Framework: FastAPI
- Language: Python
- Responsibilities:
  - inbound request handling
  - validation
  - persistence initiation
  - status exposure
  - internal API endpoints as needed

### Logic Engine / Worker

- Language: Python
- Responsibilities:
  - background processing
  - business rules
  - retries and long-running tasks
  - scheduled or deferred work

### Admin Dashboard

- Framework: Next.js
- Language: TypeScript
- Router: App Router
- Rendering strategy:
  - prefer server components by default
  - use client components only where interactivity is needed

### Data Layer

- Database: PostgreSQL
- Migrations: Alembic
- ORM / DB toolkit: SQLAlchemy 2.x

### Reverse Proxy

- Caddy

### Service Management

- `systemd`

## Architecture

The system runs as separate services on the same host:

- `caddy`
- `api`
- `engine`
- `portal`
- `postgresql`

High-level flow:

1. Caddy receives external traffic.
2. Caddy routes API traffic to FastAPI and dashboard traffic to Next.js.
3. FastAPI validates requests and writes persistent state to PostgreSQL.
4. FastAPI records work items or state transitions for asynchronous processing.
5. The Python worker reads those work items and executes business logic.
6. The portal reads system state through API endpoints backed by the database.

## Service Boundaries

### API

Owns:

- HTTP contracts
- authentication and authorization
- input validation
- response formatting
- request lifecycle state changes

Should not own:

- long-running orchestration inside request handlers
- UI rendering
- deployment-specific proxy logic

### Engine

Owns:

- business workflows
- background execution
- retryable operations
- integration-heavy logic

Should not own:

- public HTTP endpoint handling
- browser UI

### Portal

Owns:

- admin-facing user interface
- operational views
- management workflows
- status, logs, and controls exposed to operators

Should not own:

- direct database access from the browser
- core business workflow execution

## Repository Layout

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
  .env.example
  README.md
```

## Environment Strategy

Use environment variables for service configuration, with a checked-in `.env.example` describing all required values.

Likely environment categories:

- database connection settings
- API secrets and auth config
- worker tuning and polling config
- app hostnames and ports
- deployment-specific paths

## Deployment Strategy

### Source of Truth

GitHub is the source of truth for deployable code.

### Deployment Flow

1. Develop on macOS.
2. Commit and push to GitHub.
3. Pull the repo onto the Raspberry Pi.
4. Run a repeatable deploy script.
5. Restart or reload services through `systemd` as needed.

### Bootstrap Requirement

A fresh Raspberry Pi should be bootstrappable from scripts in the repository. That means the repo should eventually include:

- package installation steps
- service unit installation
- Caddy configuration installation
- environment file guidance
- app build and restart flow

## Operational Model

The initial deployment is single-host and service-based.

Expected production services:

- `caddy`
- `postgresql`
- `stackpi-api`
- `stackpi-engine`
- `stackpi-portal`

## Suggested V1 Dependencies

### Backend

- FastAPI
- Pydantic
- SQLAlchemy 2.x
- Alembic
- `uvicorn` for serving FastAPI

### Frontend

- Next.js
- TypeScript
- Tailwind CSS
- `shadcn/ui` or similar

### Ops

- Caddy
- PostgreSQL
- `systemd`

## Initial Milestones

1. Create the repository layout
2. Add a FastAPI application with a `/health` endpoint
3. Add PostgreSQL connectivity and migration support
4. Add a worker service skeleton with a simple processing loop
5. Add a Next.js admin shell with a basic status page
6. Add Caddy routes for API and portal traffic
7. Add `systemd` unit files for each app service
8. Add `bootstrap-pi.sh`
9. Add `deploy.sh`

## Acceptance Criteria For Early Milestone

The first meaningful vertical slice is complete when:

- the API service starts locally
- `/health` returns a valid success response
- the database connection initializes successfully
- the worker process starts and logs its heartbeat
- the Next.js portal renders a basic admin shell
- Caddy can proxy API and portal routes correctly in a deployment-like setup

## Risks And Tradeoffs

### Why Not C++

C++ would add complexity in exchange for performance benefits that do not appear central to the project’s likely bottlenecks. For orchestration-heavy, integration-heavy, and persistence-heavy systems, Python usually provides a better speed-to-value tradeoff.

### Why Not Docker First

Docker may be useful later, but for a single Raspberry Pi host, native services are simpler to inspect, lighter to run, and easier to debug during early development.

### Why Separate Worker From API

Separating request handling from background execution reduces request latency risk and isolates failures from long-running logic.

## Recommended Next Action

Scaffold the repo and implement the first end-to-end skeleton:

- FastAPI app
- worker process
- Next.js app
- migration setup
- deployment placeholders
