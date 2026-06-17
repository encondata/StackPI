# API

FastAPI application code lives here.

## Structure

- `app/` contains the application package
- `tests/` contains API tests
- `pyproject.toml` defines the API service dependencies

## Local Run

From the repository root:

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

The service will start on `http://127.0.0.1:8000` by default.

## First Endpoint

- `GET /health`

Expected response:

```json
{
  "status": "ok",
  "service": "stackpi-api",
  "environment": "development"
}
```

## Tests

```bash
cd api
source .venv/bin/activate
pytest
```
