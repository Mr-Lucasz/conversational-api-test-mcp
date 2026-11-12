# Changelog

All notable changes to this project. Dates are when the change reached `main`.

## 0.3.0 — Unreleased

Testing the tests, contracts and security.

### Added

- **`mutate_assertions`**: mutation testing for asserts. Breaks each real response of a flow in realistic ways (a field dropped, changed type, `null`, an empty list, a changed value, status 500/404, 10x slower) and reports a score plus, for every surviving mutation, an assert that would catch it.
- **BOLA probes**: a definition can declare `roles` (one `Authorization` value per identity). Vander calls endpoints that address one object as every role not in `allow_roles`, expecting 401/403/404.
- **Negative probes from the body**: wrong type, `null`, empty string and an unknown extra field for each body field. With `body_schema`, also values past `minLength`/`maxLength`/`minimum`/`maximum`, outside the `enum` or in a bad `format`.
- **`assert.snapshot`**: records the body on the first run (`.mcp/snapshots/<name>.json`) and reports drift later. `shape` mode (default) compares keys and types, `values` mode masks UUIDs, dates, JWTs and long hex ids, `ignore` drops JSONPaths. `run --update-snapshots` accepts changes.
- **`check_contract_drift`**: sends a definition's requests and validates status and body against the operation documented in an OpenAPI / Swagger file, and lists spec operations no request covers.
- **`infer_crud_flows`**: proposes (or writes) create → read → update → read → delete → read-again flows; the final read must answer 404/410.
- **HAR import** in `convert_legacy_to_canonical`: the API calls of the main host become endpoints and a `recorded` flow; Authorization and Cookie become placeholders.
- **`mock` subcommand**: `npx conversational-api-test-mcp mock` serves the definitions, answering from `mock` blocks, value snapshots or samples built from `assert.schema`.
- **`export_contract`**: OpenAPI 3.1, Arazzo 1.0 workflows (captures as step outputs) and Pact v3 draft contracts, under `.mcp/contracts/`.
- **`tracing`**: sends a W3C `traceparent` with every request and reports the trace id (per flow step, and in CI failures), with an optional link template.

### Changed

- Converting an OpenAPI file turns `{param}` into `{{param}}`, copies request body examples and points `assert.schema` and `body_schema` back into the spec.
- The Vander plan replaces the manual "wrong types / boundaries" and "unknown extra field" ideas with automatic probes, and the "another user's token" idea with BOLA probes when `roles` is declared.

## 0.2.0 — 2026-11-11

### Added

- `assert.schema`: validate JSON bodies against an inline JSON Schema or a schema in a workspace file (`openapi.yaml#/components/schemas/Order`), OpenAPI 3.0 and 3.1.
- `run` subcommand: runs flows from a terminal or CI, with `pretty`, `json` and JUnit reporters and exit codes for gating a job.
- Postman test and pre-request scripts are translated to `assert`, `capture` and generated variables where the pattern is known.
- `import_postman_environment`: copies a Postman environment export into `.env.mcp.local`, optionally under an environment prefix.
- MCP tool titles and annotations (read-only, sends HTTP, replaces files).

### Fixed

- Postman import: the Authorization tab, urlencoded and GraphQL bodies are converted.
