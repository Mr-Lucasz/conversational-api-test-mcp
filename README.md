# Conversational API Test MCP

[Português](README.pt-BR.md)

**An API test bench your AI agent can drive — and a QA engineer named Vander to drive it.**

Most API tools assume a human at the keyboard. This one assumes an agent: you describe your API once in YAML, and the agent runs requests, chains them, and reviews endpoints through a testing heuristic, while the server keeps three promises the agent cannot keep on its own — the request sent is exactly the one declared, the answer costs few tokens, and your credentials never enter the conversation.

It is an [MCP](https://modelcontextprotocol.io) server over stdio. It works with Cursor, VS Code + GitHub Copilot, Claude Code, and any other MCP stdio client.

## What a session looks like

A real run, recorded on 2026-10-07 against [httpbin.org](https://httpbin.org) with the definition in [`examples/httpbin.example.yaml`](examples/httpbin.example.yaml). Only safe methods were sent.

> **You:** `/vander` `.mcp/api/httpbin.yaml` `whoami`
>
> **Vander:** Vander here. Reviewing `GET /bearer` on httpbin.org. The plan has 13 automatic checks; 4 of them would send POST, PUT, PATCH or DELETE, so I left those out.
>
> 8 passed, 1 failed, 4 skipped.
>
> - **V** ✅ `OPTIONS` → `200`. POST / PUT / PATCH / DELETE not sent.
> - **A** ❌ No credentials → `401`, as it should be. But `Bearer vander-invalid-token` → `200` with `"authenticated": true`.
> - **N** ⚪ Nothing to negate: no body, no query parameters, no id in the path.
> - **D** ✅ Baseline `200`, `application/json` with a JSON body, `$.authenticated` present.
> - **E** ✅ No `5xx`, and nothing leaked in the `401`.
> - **R** ✅ 196 ms against a 1000 ms budget. One sample, not a load test.
>
> One finding: the endpoint accepts any bearer token. It checks that a token is present, not that it is valid. For an echo service like httpbin that is to be expected; on a real API it is the difference between authentication and a header check.
>
> Not tested: the four state-changing verbs, an expired token, another user's token, rate limiting.

<details>
<summary>The tool output behind that reply (<code>run_vander_checks</code>, verbatim)</summary>

```text
endpoint:
  id: whoami
  method: GET
  path: /bearer
summary:
  pass: 8
  fail: 1
  skipped: 4
  manual: 6
axes[5]:
  - axis: V
    name: Verbs
    checks[5]:
      - id: V-options
        title: OPTIONS does not cause a server error
        result: pass
        expected: status not5xx
        actual: status 200 in 656ms
      - id: V-post
        title: POST (not declared for this path) is rejected
        result: skipped
        note: "sends POST (state-changing); rerun with includeDestructive: true"
      - id: V-put
        title: PUT (not declared for this path) is rejected
        result: skipped
        note: "sends PUT (state-changing); rerun with includeDestructive: true"
      - id: V-patch
        title: PATCH (not declared for this path) is rejected
        result: skipped
        note: "sends PATCH (state-changing); rerun with includeDestructive: true"
      - id: V-delete
        title: DELETE (not declared for this path) is rejected
        result: skipped
        note: "sends DELETE (state-changing); rerun with includeDestructive: true"
  - axis: A
    name: Authorization
    checks[2]:
      - id: A-none
        title: Request without credentials is rejected
        result: pass
        expected: "status in [401, 403]"
        actual: status 401 in 435ms
      - id: A-invalid
        title: Request with an invalid token is rejected
        result: fail
        expected: "status in [401, 403]"
        actual: status 200 in 142ms
        note: "{\"authenticated\":true,\"token\":\"[REDACTED]\"}"
  - axis: D
    name: Data
    checks[3]:
      - id: D-baseline
        title: Request as declared succeeds
        result: pass
        expected: status 2xx
        actual: status 200 in 196ms
      - id: D-content-type
        title: Content-Type matches the body actually returned
        result: pass
        expected: Content-Type consistent with the body
        actual: "content-type \"application/json\", body is JSON"
      - id: D-captures
        title: Every captured JSONPath exists in the response
        result: pass
  - axis: E
    name: Errors
    checks[2]{id,title,result}:
      E-no-5xx,No probe made the server answer 5xx,pass
      E-no-leak,Error bodies do not leak stack traces or database errors,pass
  - axis: R
    name: Responsiveness
    checks[1]{id,title,result,expected,actual}:
      R-duration,Baseline answers within the duration budget,pass,<= 1000ms,196ms
```

</details>

How this was recorded: a script drove the built server over MCP stdio and saved the tool output shown above, unedited. Vander's reply was then written by Claude from that output, following the `vander` prompt. Every number in the reply comes from the output; timings will differ on your machine.

## Three bets

**1. The agent chooses; the server executes.** The agent picks a `requestId`, and the server builds and sends the request from the YAML. There is no hand-written `curl` in the chat to get subtly wrong, and the same call gives the same request tomorrow.

**2. Tokens are a budget.** `responseDetail`, `jsonPathSelect` and `maxBodyChars` decide how much of a response comes back; `execute_api_flow` runs a whole scenario in one call; results are encoded as [TOON](https://github.com/toon-format/spec) rather than JSON.

**3. A heuristic is worth more than a personality.** Vander is a persona, but what he does is fixed: a checklist built by code and verdicts computed from status codes and timings. Research on personas in prompts found they do not, by themselves, make a model more accurate ([sources](#where-the-ideas-come-from)), so the personality is there for the conversation and the rigour lives in `run_vander_checks`.

## Quick start

Requires **Node.js ≥ 20**.

```bash
npm ci
npm run build
```

Register the server in your MCP client, pointing at `dist/index.js`:

```json
{
  "servers": {
    "conversational-api-test-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/conversational-api-test-mcp/dist/index.js"]
    }
  }
}
```

In the project you want to test, create `.mcp/api/` and add a definition (see [`examples/default.example.yaml`](examples/default.example.yaml)):

```yaml
version: "1"
service: weather
base_url: "{{BASE_URL}}"
flows:
  smoke:
    steps:
      - get_token
      - requestId: forecast
        assert:
          jsonPathExists: $.days
endpoints:
  - id: get_token
    method: POST
    path: /oauth/token
    form:
      grant_type: client_credentials
      client_id: "{{CLIENT_ID}}"
      client_secret: "{{CLIENT_SECRET}}"
    capture:
      TOKEN: $.access_token
  - id: forecast
    method: GET
    path: /forecast
    params:
      city: lisbon
    auth: Bearer {{TOKEN}}
    auth_dependency: get_token
```

Put secrets in **`.env.mcp.local`** at the workspace root and **never commit it**:

```dotenv
BASE_URL=https://api.example.com/v1
CLIENT_ID=...
CLIENT_SECRET=...
STAGING_BASE_URL=https://staging.example.com/v1
```

Then ask the agent explicitly, e.g. *"run the `smoke` flow from `.mcp/api/weather.yaml` through the MCP"*.

## Tools

| Tool | Purpose |
|------|---------|
| `list_api_definitions` | List YAMLs under `.mcp/api/` (glob, pagination, sort, field projection). |
| `summarize_api_definition` | Cheap triage: endpoint ids, variable keys, flow names. |
| `read_api_definition` | Full, validated definition. |
| `execute_api_request` | Run one endpoint. |
| `execute_api_flow` | Run several endpoints in one call — inline `steps` or a `flowName` declared in the YAML. |
| `dry_run_request` | Show the request that would be sent, without sending it. |
| `assert_response` | Assert on the last response (`status`, `jsonPathExists`). |
| `set_environment` | Select the active environment (`CURRENT_ENV`). |
| `set_environment_variable` / `get_environment_variable` | Session variables. |
| `explain_request_context` | Which variable keys are available from where. |
| `upsert_canonical_api_definition` | Create / append definitions (dry-run by default). |
| `reorganize_mcp_api_definitions` | Merge many YAMLs into fewer (plan, then apply). |
| `plan_vander_checks` / `run_vander_checks` | VANDER review of one endpoint: checklist, then automatic execution grouped by axis. |
| `discover_legacy_api_sources` / `convert_legacy_to_canonical` | Import Postman, OpenAPI or Insomnia files. |

Recommended order: `list_api_definitions` → `summarize_api_definition` → `set_environment` (if needed) → `execute_api_request` or `execute_api_flow`.

## Vander

**Vander** is a persona shipped as an MCP prompt: a senior API QA engineer you talk to instead of issuing tool calls yourself. In clients that expose MCP prompts it shows up as a command (for example `/vander`), optionally with a definition path and an endpoint id. He reviews an endpoint through the **VANDER** heuristic:

| Axis | Question | Checked automatically |
|------|----------|-----------------------|
| **V**erbs | What does the path do with methods it does not declare? | Undeclared methods are rejected (405/404/501); `OPTIONS` does not error. |
| **A**uthorization | Who can call it? | No credentials and an invalid token are rejected (401/403). |
| **N**egative | What happens with bad input? | Each top-level body field removed in turn is rejected (4xx). |
| **D**ata | Does the response say what it should? | Baseline succeeds, `Content-Type` matches the body, captured JSONPaths exist. |
| **E**rrors | Does it fail well? | Malformed JSON is a client error; no probe causes a 5xx or leaks a stack trace. |
| **R**esponsiveness | Is it fast enough? | Baseline answers within `maxDurationMs` (default 1000). |

Each axis also carries `manual` ideas (other users' tokens, boundary values, idempotency, rate limiting…) that Vander explores with the regular tools.

The two tools work without the prompt too:

- `plan_vander_checks` returns the checklist for a `requestId` and sends nothing.
- `run_vander_checks` executes the automatic checks and returns pass / fail / skipped per axis. Probes never capture variables. Anything that sends `POST`, `PUT`, `PATCH` or `DELETE` is **skipped unless `includeDestructive: true`**, so reviewing a write endpoint is an explicit decision.

VANDER builds on Stuart Ashman's VADER heuristic and adds an explicit Negative axis — see [where the ideas come from](#where-the-ideas-come-from).

## Definitions

### Variables and environments

`{{KEY}}` is resolved from, in increasing priority: YAML `variables` → `.env.mcp.local` → session variables (captures and `set_environment_variable`).

- After `set_environment` (e.g. `STAGING`), `{{BASE_URL}}` resolves `STAGING_BASE_URL` first and falls back to `BASE_URL`.
- Unresolved placeholders are left as literal `{{KEY}}` so the problem is visible.
- Macros: `{{$uuid}}`, `{{$timestamp}}`, `{{$date}}`, `{{$date:YYYY-MM-DD HH:mm:ss}}`.
- `{{env.NAME}}` reads the server's `process.env`, but only for names listed in `MCP_API_ENV_PASSTHROUGH`.

### Requests

- `base_url` may carry a path prefix (`https://host/api/v1`); `path` is appended to it. An absolute `path` overrides `base_url`.
- `params` is sent as the query string; `headers`, `body` (JSON) and `form` (URL-encoded) are interpolated.
- `capture` maps a session variable name to a JSONPath on the response; `assert` checks `status` and/or `jsonPathExists`.

### Auth

- `auth: Bearer {{TOKEN}}` sets the `Authorization` header.
- `auth_dependency: <endpoint id>` runs that endpoint first when its captured variables are missing, and again after a `401` (disable with `auth_retry_on_401: false`).
- `digest_auth: { username, password }` performs HTTP Digest.

### Flows

Each step is an endpoint id or an object:

```yaml
flows:
  create_and_wait:
    steps:
      - create_job
      - requestId: get_job
        poll: { untilJsonPath: "$.finishedAt", maxAttempts: 10, delayMs: 2000 }
        retry: { max: 3, delayMs: 500 }
        acceptStatus: [200]
        assert: { status: 200, jsonPathExists: "$.result" }
        optional: false
```

## Keeping output small

- `responseDetail: "minimal"` returns status, duration and captures only; `"summary"` (default) adds a body preview capped at 8,000 chars; `"full"` raises the cap to 50,000.
- `jsonPathSelect` projects the body before it is serialized.
- `execute_api_flow` replaces N tool calls with one.
- Parsed definitions and `.env.mcp.local` are cached in memory and invalidated by file `mtime`.

## Security model

The server runs locally with your privileges and is driven by an LLM, so treat API responses and definitions as untrusted input.

- **Redaction.** Auth headers, values under credential-looking JSON keys (`password`, `token`, `secret`, `api_key`, …), JWT-looking strings, credential query parameters and captured credentials are returned as `[REDACTED]`. The real values stay in the session and are still used by later requests. Redaction is name- and shape-based, so it is a safety net, not a guarantee.
- **No implicit environment access.** `process.env` is not part of the interpolation context; only names you list in `MCP_API_ENV_PASSTHROUGH` are reachable, via `{{env.NAME}}`.
- **Responses are data.** Values captured from a response are inserted literally and never re-expanded as templates.
- **Writes are confined** to `.mcp/api/` and default to dry-run.
- **Optional host allowlist.** `MCP_API_ALLOWED_HOSTS` restricts requests — including every redirect hop — to the listed hostnames. It is off by default and is not a complete SSRF defence (no private-range or DNS-rebinding checks).

| Environment variable | Effect |
|----------------------|--------|
| `MCP_WORKSPACE_ROOT` | Default `workspaceRoot` when a tool call omits it. |
| `MCP_API_ALLOWED_HOSTS` | Comma-separated hostnames requests may target. Unset = any host. |
| `MCP_API_ENV_PASSTHROUGH` | Comma-separated env var names (trailing `*` = prefix) exposed to `{{env.NAME}}`. Unset = none. |
| `MCP_API_MAX_RESPONSE_BYTES` | Response size cap. Default 10 MB. |
| `MCP_API_REVEAL_SECRETS` | `true` disables redaction. Local debugging only. |

## Where the ideas come from

Nothing here was invented from scratch. This is what the project borrows, from whom, and what it changes.

| Idea in this project | Source | What was taken, and what was changed |
|----------------------|--------|--------------------------------------|
| The VANDER axes | Stuart Ashman, [*VADER – a REST API test heuristic*](https://qa-matters.com/2016/07/30/vader-a-rest-api-test-heuristic/) (QA Matters, 2016) | The five original axes — Verbs, Authorization, Data, Errors, Responsiveness — are his. This project adds **N**egative as a sixth and turns part of each axis into executable checks. |
| The Negative axis | Gwen Diagram & Ash Winter's BINMEN (Boundary, Invalid entries, NULL, Method, Empty, Negative), as listed in the Ministry of Testing [*Test Heuristics Cheat Sheet*](https://www.ministryoftesting.com/articles/ab1cd85c) | The framing of negative input as its own concern. Only "missing field" is automated today; the rest are offered as manual ideas. |
| Splitting input from output concerns | Amber Race's POISED (Parameters, Output, Interop, Security, Errors, Data), same cheat sheet | Informs the manual ideas under Data and Negative. |
| Which probes are "destructive" | [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) §9.2.1 (safe methods) | `GET`, `HEAD` and `OPTIONS` are sent freely; every other method needs `includeDestructive`. |
| Expected statuses | RFC 9110 §15.5.6 (`405`), §15.6.2 (`501`), §15.5.2 (`401`), §15.5.4 (`403`) | An undeclared method should get `405` or `501` (`404` is also accepted); missing or bad credentials should get `401` or `403`. |
| What the Authorization axis looks for | [OWASP API Security Top 10 – 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), API2 Broken Authentication | Automated: no credentials, invalid token. API1 and API5 (object- and function-level authorization) need a second identity, so they stay manual. |
| Host allowlist, response size cap | OWASP API7 (Server Side Request Forgery) and API4 (Unrestricted Resource Consumption) | Applied to this server itself, since it makes requests on an agent's behalf. |
| Vander as an MCP prompt | [MCP specification, Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) | Prompts are "user-controlled": the user picks them explicitly, typically as a slash command. That is why the persona is opt-in rather than baked into every conversation. |
| Persona for tone, code for verdicts | Zheng et al., [*When "A Helpful Assistant" Is Not Really Helpful*](https://arxiv.org/abs/2311.10054) (Findings of EMNLP 2024) | They report that adding a persona to the system prompt did not improve accuracy over no persona. So nothing Vander asserts depends on the persona. |
| TOON output | [TOON specification](https://github.com/toon-format/spec) | Used as-is for tool results. Its authors report the largest savings on uniform arrays and little or none on deeply nested data; this project has not benchmarked it independently. |

VANDER is this project's name for the extended heuristic and has no affiliation with the authors above.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Empty definition list | Is `workspaceRoot` absolute and correct? Does `.mcp/api/` contain `.yaml` files? |
| `401` | `set_environment`, the endpoint's `auth_dependency`, captures, `.env.mcp.local`. |
| `{{KEY}}` sent literally | Key name, environment prefix (`STAGING_*`), or — for shell variables — `MCP_API_ENV_PASSTHROUGH`. |
| A value shows as `[REDACTED]` | Expected for credentials. It is still used in requests. |

## Development

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run dev` | Run from source with `tsx`. |
| `npm test` | Run the test suite (`vitest`). |
| `npm run lint` | ESLint. |

## License

[MIT](LICENSE)
