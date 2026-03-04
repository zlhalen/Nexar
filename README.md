# Nexar Code

A white-box AI coding assistant for developers (frontend + backend).

English / [简体中文](./README_zh.md)

![Nexar Demo](docs/images/demo.png)

## Project Status

- Current stage: `v1.0 Alpha`
- Updated on: `2026-03-04`
- Note: The project is still under continuous optimization, mainly around stability, controllability, and execution transparency.

## What This Version Can Do

Based on the current codebase, the main capabilities are:

- Workspace file management: list tree, read/write files, create, delete, rename.
- Workspace switching: frontend can switch backend `workspace_root`.
- Multi-provider AI access: `OpenAI`, `Claude`, and `Custom (OpenAI-compatible)`.
- Closed-loop execution: `plan -> execute actions -> re-plan`, with run status tracking.
- Execution control: `pause / resume / cancel`.
- Terminal sessions: create session, send input, read output, resize, close session.
- Dev UI: file tree + editor + chat + diff + terminal.

## Architecture Overview

- Frontend: `React + TypeScript + Vite + Monaco + xterm`
- Backend: `FastAPI + Pydantic`
- Key routes:
  - `/api/files/*` files and workspace
  - `/api/ai/*` model calls and run state machine
  - `/api/terminal/*` terminal session management

## Quick Start

### 1) Start Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `backend/.env` and configure at least one model (for example `OPENAI_API_KEY`).

Back to repo root and run:

```bash
cd ..
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### 2) Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Default URL: `http://localhost:3000` (with `/api` proxied to `http://localhost:8000`).

## Environment Variables (Backend)

See `backend/.env.example`:

- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`
- `CUSTOM_API_KEY` / `CUSTOM_BASE_URL` / `CUSTOM_MODEL`
- `WORKSPACE_ROOT`

## Current Optimization Focus

These are active ongoing improvements:

- Planner stability and action quality (fewer invalid actions and retries).
- Long-conversation context handling (history compression and token cost control).
- Error reporting quality for terminal/file operations (easier debugging).
- Frontend settings page completion (some tabs are still placeholders).
- Keeping docs/examples aligned with code to reduce drift.

## Known Boundaries

- This is still Alpha; APIs and data structures may change.
- No full automated test matrix yet; regression still relies heavily on manual verification.
- Environment setup/init commands are intentionally skipped in closed-loop execution to avoid accidental environment changes.

## Contributing

Issues and PRs are welcome. Please include:

- Reproduction steps
- Expected result vs actual result
- Relevant logs (backend `logs/`)

## License

MIT
