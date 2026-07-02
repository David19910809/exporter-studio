# Exporter Lifecycle Management Platform MVP

This repository contains a runnable MVP for an Exporter Lifecycle Management Platform (ELMP). It models:

- Official repository metadata and read-only sync.
- Enterprise base versions.
- Patch DSL parsing, compiling, validation, and application.
- Git and semantic diff output.
- Plugin registration metadata.
- Build and upgrade simulation APIs.
- A lightweight UI for patch DAG, diffs, metric changes, and conflicts.

## Run

```powershell
npm start
```

Open `http://localhost:3000`.

## Test

```powershell
npm test
```

## API

- `POST /api/official/sync`
- `POST /api/patch/create`
- `POST /api/patch/apply`
- `GET /api/diff`
- `POST /api/build`
- `POST /api/upgrade/simulate`
- `GET /api/registry`
- `GET /api/graph`

Data is stored under `.elmp/` so the platform can be tried locally without external services.
