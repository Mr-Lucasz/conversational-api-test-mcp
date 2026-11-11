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
checks[13]{id,result,detail}:
  V-options,pass,status 200 in 655ms
  V-post,skipped,state-changing (POST)
  V-put,skipped,state-changing (PUT)
  V-patch,skipped,state-changing (PATCH)
  V-delete,skipped,state-changing (DELETE)
  A-none,pass,status 401 in 605ms
  A-invalid,fail,status 200 in 605ms
  D-baseline,pass,status 200 in 142ms
  D-content-type,pass,"content-type \"application/json\", body is JSON"
  D-captures,pass,""
  E-no-5xx,pass,""
  E-no-leak,pass,""
  R-duration,pass,142ms
failures[1]{id,title,expected,actual,note}:
  A-invalid,Request with an invalid token is rejected,"status in [401, 403]",status 200 in 605ms,"{\"authenticated\":true,\"token\":\"[REDACTED]\"}"
hint: "4 state-changing probes not sent; ask the user, then rerun with includeDestructive: true"
```

</details>

How this was recorded: a script drove the built server over MCP stdio and saved the tool output shown above, unedited. Vander's reply was then written by Claude from that output, following the `vander` prompt. Every number in the reply comes from the output; timings will differ on your machine.

## Three bets

**1. The agent chooses; the server executes.** The agent picks a `requestId`, and the server builds and sends the request from the YAML. There is no hand-written `curl` in the chat to get subtly wrong, and the same call gives the same request tomorrow.

**2. Tokens are a budget.** `responseDetail`, `jsonPathSelect` and `maxBodyChars` decide how much of a response comes back; `execute_api_flow` runs a whole scenario in one call; results are encoded as [TOON](https://github.com/toon-format/spec) rather than JSON.

**3. A heuristic is worth more than a personality.** Vander is a persona, but what he does is fixed: a checklist built by code and verdicts computed from status codes and timings. Research on personas in prompts found they do not, by themselves, make a model more accurate ([sources](#where-the-ideas-come-from)), so the personality is there for the conversation and the rigour lives in `run_vander_checks`.

## How it works

You test an API by talking to your agent. Three pieces make that possible:

| Piece | Where | What it is | If you know Postman |
|-------|-------|------------|---------------------|
| **Definitions** | `.mcp/api/*.yaml` | Your requests, described once and committed with the code. | The collection |
| **Secrets and environments** | `.env.mcp.local` | Base URLs, tokens and passwords. Stays on your machine. | The environment |
| **The conversation** | Your MCP client | You ask in plain language; the agent calls this server; the server sends the request. | Send, Runner and the Tests tab |

## Getting started

Requires **Node.js ≥ 20**.

**1. Build the server and register it in your MCP client.**

```bash
npm ci
npm run build
```

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

That is the VS Code format. Cursor and Claude Code read the same entry under `"mcpServers"` instead of `"servers"`, without the `"type"` line.

**2. Open the project whose API you want to test and say `hi Vander`.**

He explains the setup, checks which pieces your project already has, and offers to create the missing ones. Accepting runs `init_workspace`, which writes the three things below and never overwrites a file that exists. You can also create them by hand.

**3. The `.mcp/api/` folder and your first YAML.** One file per service. Each request gets an `id`, which is how you and the agent refer to it.

```yaml
# .mcp/api/weather.yaml
version: "1"
service: weather
base_url: "{{BASE_URL}}"
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
flows:
  smoke:
    steps:
      - requestId: forecast
        assert:
          status: 200
          jsonPathExists: $.days
```

You rarely have to write this by hand. **Paste a cURL command, paste a whole Postman collection (the exported JSON), or point at an OpenAPI / Insomnia file, and the server writes the YAML for you.** Tokens that come along are moved to `.env.mcp.local` and replaced by `{{VARIABLE}}`, so the YAML stays safe to commit.

**4. The `.env.mcp.local` file.** Create it at the project root, next to `.mcp/`. It holds what `{{...}}` stands for. **You fill it in yourself, it must be in `.gitignore`, and its values never go into the chat.**

```dotenv
# .env.mcp.local
BASE_URL=https://api.example.com/v1
CLIENT_ID=...
CLIENT_SECRET=...
STAGING_BASE_URL=https://staging.example.com/v1
```

A prefix turns one YAML into several environments: after "use staging", `{{BASE_URL}}` reads `STAGING_BASE_URL` first and falls back to `BASE_URL`.

**5. Ask.** No file to write yet? `init_workspace` drops in a demo against httpbin.org that runs without any secret, and [`examples/`](examples/) has three more you can copy into `.mcp/api/`.

## Coming from Postman

You do not rebuild your requests. You hand over what you already have — a cURL command or an exported collection — and keep working from the chat. Everything below was run against the built server; the outputs are what it returned.

**Where everything ends up.** All of it sits in the project whose API you are testing, not in this repository:

```text
your-project/
├── .mcp/
│   └── api/
│       ├── orders.yaml              # one YAML per service: commit it
│       └── shop.yaml
├── .env.mcp.local                   # base URLs, tokens, passwords: never commit it
├── .gitignore                       # contains .env.mcp.local
└── shop.postman_collection.json     # your export: read, never changed
```

### Paste a cURL

> **You:** turn this into a request called `create_order`, in `orders.yaml`
>
> ```bash
> curl -X POST "https://httpbin.org/anything/orders?source=app" \
>   -H "Authorization: Bearer demo-token-123" \
>   -H "Content-Type: application/json" \
>   -d '{"item":"notebook","quantity":2}'
> ```

The agent calls `import_curl`, which answers:

```text
definition: .mcp/api/orders.yaml
created: true
requestId: create_order
method: POST
url: "https://httpbin.org/anything/orders"
secretsMovedToEnvFile[1]: CREATE_ORDER_TOKEN
```

and writes this file. The query string became `params`, the JSON body became `body`, and the token is gone from it:

```yaml
# .mcp/api/orders.yaml
version: "1"
base_url: https://httpbin.org
endpoints:
  - id: create_order
    method: POST
    path: /anything/orders
    headers:
      Content-Type: application/json
    params:
      source: app
    body:
      item: notebook
      quantity: 2
    auth: Bearer {{CREATE_ORDER_TOKEN}}
```

The token itself was appended to `.env.mcp.local` as `CREATE_ORDER_TOKEN=...`, and `.env.mcp.local` was added to `.gitignore` if it was not there. From here on it is "run `create_order`".

### Hand over a collection

Export the collection from Postman (*Export → Collection v2.1*) and either drop the JSON in the project or paste its content in the chat.

> **You:** here is my Postman collection, `shop.postman_collection.json`. Convert it to `shop.yaml`.

The agent calls `convert_legacy_to_canonical`, which answers:

```text
outputPath: .mcp/api/shop.yaml
source: postman
losses[1]{code,message}:
  POSTMAN_PRE_REQUEST_SCRIPTS,"Some pre-request script lines could not be translated and will not run. Requests: Create order."
endpointCount: 2
```

```yaml
# .mcp/api/shop.yaml
version: "1"
service: Shop
base_url: "{{base_url}}"
variables:
  base_url: https://httpbin.org
  rid: "{{$uuid}}"              # from pm.environment.set("rid", …{{$guid}}…)
endpoints:
  - id: postman_0_List_orders
    method: GET
    path: /anything/orders?status=open
    description: List orders
    headers:
      X-Request-Id: "{{rid}}"
    assert:                      # from the pm.test blocks
      status: 200
      maxDurationMs: 1000
      checks:
        - path: $.args.status
          equals: open
  - id: postman_1_Create_order
    method: POST
    path: /anything/orders
    description: Create order
    body:
      item: notebook
      quantity: 2
    headers:
      Content-Type: application/json
    assert:
      status: 200
    capture:                     # from pm.environment.set("orderItem", pm.response.json().json.item)
      orderItem: $.json.item
```

Every request in the collection, folders included, is now an endpoint. The `losses` list is the server telling you what it left behind, and the conversion needs a few minutes of finishing — ask the agent to do it, it previews each change before writing:

| What you had in Postman | What the import does | How to finish |
|-------------------------|----------------------|---------------|
| The host in each URL | Becomes `base_url`, taken from the collection variable used as host (`{{baseUrl}}/orders`) or from the first absolute URL. With neither, `base_url` stays empty and `losses` reports `POSTMAN_BASE_URL_UNRESOLVED`. | Nothing, when it was found. Otherwise "set `base_url` to `https://api.example.com`", or put `BASE_URL=...` in `.env.mcp.local` and use `{{BASE_URL}}`. |
| The **Authorization** tab (collection, folder or request) | Converted per request, following Postman's inheritance (`inherit`, `noauth`): Bearer and Basic become `auth`, Digest becomes `digest_auth`, API Key becomes a header or a param. Literal credentials go to `.env.mcp.local`. Other types (OAuth 2.0, AWS, …), and Basic built from `{{variables}}`, are reported as `POSTMAN_AUTH_UNSUPPORTED`. | Nothing for the converted ones. For the rest, `auth: Bearer {{TOKEN}}`, plus `capture` + `auth_dependency` when a login request produces the token. |
| Pre-request scripts | Generated values become variables: `uuid.v4()`, `crypto.randomUUID()` and `{{$guid}}` → `{{$uuid}}`, `Date.now()` → `{{$timestamp}}`, `new Date().toISOString()` → `{{$isoTimestamp}}`, literals as they are. Any other line (signatures, `pm.sendRequest`, …) is reported in `losses`, naming the requests. | `capture` + `auth_dependency` for tokens fetched by a script; the rest by hand. |
| Tests (`pm.test`) | Translated to `assert`: `to.have.status`, `responseTime` below, and on body paths `eql`, `include`, `lengthOf`, `exist`, `above`/`below`, `match`. `pm.environment.set("x", jsonData.a.b)` becomes `capture`. Collection and folder scripts apply to every request below them. What is left is reported in `losses`, naming the requests. | `assert` by hand for the rest — see [value checks](#value-checks). |
| Dynamic variables | `{{$guid}}` / `{{$randomUUID}}` become `{{$uuid}}`; `{{$timestamp}}` (seconds in Postman) becomes `{{$timestampSeconds}}`. | — |
| Request names | Become ids such as `postman_0_List_orders`. | "Rename it to `list_orders`." |
| Query string | Stays inline in `path`; disabled params are dropped. | Works as it is; move it to `params` if you want to vary it. |
| Bodies | `raw` becomes `body`, `x-www-form-urlencoded` becomes `form`, GraphQL becomes a `{ query, variables }` body. `form-data` and binary files are not mapped and are reported as `POSTMAN_BODY_MODE`, naming the requests. | Rewrite those as `form` or `body`. |
| Disabled headers and params | Left out, as Postman leaves them out of the request. | — |
| Postman environments | Imported with `import_postman_environment` ("import `staging.postman_environment.json` as STAGING"): each enabled value goes to `.env.mcp.local` as `STAGING_<key>`, picked once `set_environment STAGING` is active. Existing keys are kept; values are never echoed back. | Postman exports initial values only: fill in the empty ones it reports. |

The collection file is only read. Keep it, delete it, or leave it out of git — the YAML is the source of truth from now on.

When you ask the agent to look for something to import without naming a file, `discover_legacy_api_sources` searches the project for `*postman*.json`, `collection*.json`, `openapi*.{yaml,yml,json}`, `swagger*.{yaml,yml}` and `insomnia*.{json,yaml}`. A file with another name is converted when you give its path.

### A day of work, in prompts

| Moment | You say |
|--------|---------|
| First time in the project | "hi Vander, set this project up" |
| Bringing requests in | "turn this cURL into a request called `create_order`" · "convert `shop.postman_collection.json`" |
| Tidying an import | "set `base_url` to …" · "rename `postman_0_List_orders` to `list_orders`" · "these requests use the token from `login`" |
| Running | "run `list_orders`" · "run it on staging" · "show me what `create_order` would send" |
| Chaining | "create an order, then fetch it by the id that came back" · "save that as a flow called `smoke`" |
| Checking | "check that it returns 200 and `$.items` is not empty" · "run the smoke flow" |
| Reviewing | "Vander, is `create_order` solid?" |

## What you can ask

Each line is something you would otherwise do by hand in an API client.

| You say | What happens | In Postman you would |
|---------|--------------|----------------------|
| "Here is my Postman collection" + the JSON, or the path to it | Converts a collection, an OpenAPI spec or an Insomnia export to YAML. | Import |
| "Turn this cURL into a request" + the command | Creates the request in a YAML; any token in it goes to `.env.mcp.local`. | Import → Raw text |
| "Run `forecast`" | Sends that one request and summarises the response. | Click Send |
| "Run the smoke flow" | Runs the requests of a flow in order, stopping at the first failure. | Collection Runner |
| — (in CI) `npx conversational-api-test-mcp run` | Runs every flow and writes a JUnit report; fails the job on a failing step. | Newman / Postman CLI |
| "Import `staging.postman_environment.json` as STAGING" | Copies its values to `.env.mcp.local` under `STAGING_`. | Import → Environment |
| "Check the response matches the `Order` schema in `openapi.yaml`" | Validates the body against that schema. | `tv4` / `ajv` in Tests |
| "Log in and list the orders" | Runs the login first, keeps the token, uses it, and logs in again on a `401`. | Pre-request script |
| "Create a post, then fetch it by the id that came back" | Captures a value from one response and uses it in the next request. | `pm.environment.set` in Tests |
| "Use staging" | Switches the active environment for the following requests. | Environment dropdown |
| "Check that it returns 200 and has a `days` field" | Asserts on status and on a JSONPath. | `pm.test` in Tests |
| "Start the export and wait until it is ready" | Polls a request until a field appears. | `setNextRequest` loop |
| "Show me what `forecast` would send" | Builds the request without sending it, credentials hidden. | Console |
| "Add a request that creates an order with these fields" | Writes a new entry to the YAML, showing a preview first. | New request |
| "Run the smoke eval of the assistant" | Sends each question several times and passes it on a pass rate; checks answers, citations and latency by code. | — |
| "Vander, is `forecast` solid?" | Reviews the endpoint on six axes and reports evidence. | — |

## Tools

| Tool | Purpose |
|------|---------|
| `list_api_definitions` | List YAMLs under `.mcp/api/` (glob, pagination, sort, field projection). |
| `summarize_api_definition` | Cheap triage: endpoint ids, variable keys, flow names. |
| `read_api_definition` | Full, validated definition. |
| `execute_api_request` | Run one endpoint. |
| `execute_api_flow` | Run several endpoints in one call — inline `steps` or a `flowName` declared in the YAML. |
| `dry_run_request` | Show the request that would be sent, without sending it. |
| `assert_response` | Assert on the last response: status, latency and value checks. |
| `run_eval` | Evaluate an endpoint whose answer varies (LLM / RAG / search): cases × repeats, pass rate, optional samples for the agent to judge. |
| `set_environment` | Select the active environment (`CURRENT_ENV`). |
| `set_environment_variable` / `get_environment_variable` | Session variables. |
| `explain_request_context` | Which variable keys are available from where. |
| `init_workspace` | Create `.mcp/api/`, a demo definition, the `.env.mcp.local` template and the `.gitignore` line. |
| `upsert_canonical_api_definition` | Create / append definitions (dry-run by default). |
| `reorganize_mcp_api_definitions` | Merge many YAMLs into fewer (plan, then apply). |
| `summon_vander` | Hands the agent the Vander persona when you address him by name. |
| `plan_vander_checks` / `run_vander_checks` | VANDER review of one endpoint: checklist, then automatic execution — one row per check, the id prefix being the axis. |
| `import_curl` | Turn a pasted `curl` command into a request in a YAML. |
| `discover_legacy_api_sources` / `convert_legacy_to_canonical` | Import Postman, OpenAPI or Insomnia — from a file or from pasted text. |
| `import_postman_environment` | Copy a Postman environment export into `.env.mcp.local`, optionally under an environment prefix. |

Every tool publishes MCP annotations: the read-only ones say so (clients can run them without asking), and the ones that send HTTP or replace files are marked as such.

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

In clients without prompt support — or when you would rather just talk — say his name: "hi Vander, review `whoami`". The server's instructions tell the agent to call `summon_vander`, which hands it the same brief.

The check tools work without the persona too:

- `plan_vander_checks` returns the checklist for a `requestId` and sends nothing.
- `run_vander_checks` executes the automatic checks and returns pass / fail / skipped per check (the id prefix is the axis), with the detail of each failure listed apart. Probes never capture variables. Anything that sends `POST`, `PUT`, `PATCH` or `DELETE` is **skipped unless `includeDestructive: true`**, so reviewing a write endpoint is an explicit decision.

VANDER builds on Stuart Ashman's VADER heuristic and adds an explicit Negative axis — see [where the ideas come from](#where-the-ideas-come-from).

## Definitions

### Variables and environments

`{{KEY}}` is resolved from, in increasing priority: YAML `variables` → `.env.mcp.local` → session variables (captures and `set_environment_variable`).

- After `set_environment` (e.g. `STAGING`), `{{BASE_URL}}` resolves `STAGING_BASE_URL` first and falls back to `BASE_URL`.
- Unresolved placeholders are left as literal `{{KEY}}` so the problem is visible.
- Macros: `{{$uuid}}`, `{{$timestamp}}` (ms), `{{$timestampSeconds}}`, `{{$isoTimestamp}}`, `{{$date}}`, `{{$date:YYYY-MM-DD HH:mm:ss}}`.
- `{{env.NAME}}` reads the server's `process.env`, but only for names listed in `MCP_API_ENV_PASSTHROUGH`.

### Requests

- `base_url` may carry a path prefix (`https://host/api/v1`); `path` is appended to it. An absolute `path` overrides `base_url`.
- `params` is sent as the query string; `headers`, `body` (JSON) and `form` (URL-encoded) are interpolated.
- `capture` maps a session variable name to a JSONPath on the response; `assert` checks status, latency and values — see [value checks](#value-checks).

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

### Value checks

`assert` (on a request, on a flow step, or through `assert_response`) takes `status`, `jsonPathExists`, `maxDurationMs` and a list of `checks`. Each check reads the value at a JSONPath `path` — or the whole body as text when `path` is omitted — and every operator in it must hold. All failing checks are reported, not just the first.

| Operator | Holds when |
|----------|------------|
| `contains` / `containsAny` / `notContains` | The text has all of / one of / none of the given strings. |
| `matches` | The text matches the regular expression. |
| `ignoreCase` | Makes the four above case-insensitive. |
| `equals` | The value is exactly this (any JSON value). |
| `min` / `max` | The number is within the bounds. |
| `minLength` / `maxLength` | The string or list has that many characters / items. |
| `includesAll` / `includesAny` | The list at `path` holds all of / one of these values. With `minRatio`, `includesAll` needs only that share of them — retrieval recall. |
| `subsetOf` | Every value at `path` also appears at this other JSONPath — citations among the retrieved documents. |

An operator the server does not know is an error when the YAML is read, never a silent pass.

`schema` checks the whole JSON body against a JSON Schema — written inline, or taken from a file in the project with a JSON pointer, usually your OpenAPI spec:

```yaml
assert:
  status: 200
  schema: openapi.yaml#/components/schemas/Order   # or an inline { type: object, required: [id] }
```

OpenAPI 3.0 and 3.1 both work (`nullable`, internal `$ref`s, `format`s). A failure names the path and the rule, e.g. `schema: /customer must have required property 'name'`. The file is re-read when it changes.

### Evals: endpoints whose answer varies

A request to an LLM, a RAG or a search endpoint can come back different every time, so one green run proves little. An eval sends one request over several **cases**, each **repeated**, and passes a case on its **pass rate**:

```yaml
evals:
  smoke:
    requestId: ask
    repeat: 3          # each case is sent 3 times
    passRate: 0.66     # and passes when 2 of the 3 runs satisfy `expect`
    expect:            # applied to every case
      status: 200
      maxDurationMs: 8000
      checks:
        - path: $.citations
          subsetOf: $.sources[*].id      # no invented citation
    judge:             # optional: samples for the agent to grade
      answerPath: $.answer
      contextPath: $.sources[*].text
      questionVariable: question
    cases:
      - name: refund_window
        variables: { question: How many days do I have to ask for a refund? }
        reference: 30 days from delivery.
        expect:
          checks:
            - { path: $.answer, contains: "30" }
            - { path: $.sources[*].id, includesAll: [policy-refunds, faq-returns], minRatio: 0.5 }
      - name: out_of_scope
        variables: { question: Who will win the next election? }
        expect:
          checks:
            - { path: $.answer, matches: "(don't|do not|cannot) (know|answer)", ignoreCase: true }
            - { path: $.citations, maxLength: 0 }
```

Run it with "run the smoke eval" (`run_eval` + `evalName`), or pass `requestId` and `cases` inline. The result has one row per case (`passed: 2/3`, latency, how many different answers came back), the distinct failures with how often each happened, and p50 / p95 latency.

Two kinds of verdict come out of it, and they are kept apart:

- **Checked by code** — everything under `expect`. Same input, same verdict: status, latency, words that must or must not appear, a refusal for out-of-scope questions, expected documents among the retrieved ones, citations that point at retrieved documents.
- **Judged by the agent** — with `judge`, the result carries one sample per case (question, answer, retrieved passages, reference) and a rubric: `faithfulness`, `relevance`, `context_relevance`, `correctness`, or criteria in your own words. The server calls no model; the agent you are talking to does the grading, so the verdict depends on that model and is reported as judgement.

Things to know:

- Every run is a real request, usually a paid one. `run_eval` refuses to start when cases × repeat exceeds `maxRequests` (default 30).
- Eval runs do not capture variables or replace the session's last response; `auth_dependency` still logs in when needed.
- A streamed answer (`text/event-stream`) is folded into `{ text, eventCount, events }`, so `$.text` is the answer and `events` keeps what was not a text delta (sources, usage, stop reason). Set `sse.textPath` on the request when the delta sits somewhere unusual.
- [`examples/rag.example.yaml`](examples/rag.example.yaml) is a complete starting point.

## Running in CI

The same package runs your flows from a terminal, so the YAML that the agent uses also gates a pipeline:

```bash
npx conversational-api-test-mcp run --env STAGING --reporter junit --out reports/api.xml
```

- With no file, every definition under `.mcp/api/` is read and each of its `flows` runs (a file with no flows is skipped and listed). `--flow smoke` picks flows, `--request get_user` runs single requests, and `--all-endpoints` runs every request one by one — POST and DELETE included.
- `--env` works as `set_environment`; secrets come from `.env.mcp.local` or, in CI, from a step that writes it from your secret store.
- `--reporter` is `pretty` (default), `json` or `junit` (one testsuite per flow, one testcase per step, read by GitHub Actions, GitLab, Jenkins and Azure DevOps). `--bail` stops at the first failing flow.
- Exit code `0` when everything passed, `1` when a step failed, `2` for a usage error or nothing to run.

```yaml
# .github/workflows/api.yml (excerpt)
- run: printf '%s\n' "$ENV_MCP_LOCAL" > .env.mcp.local
  env: { ENV_MCP_LOCAL: "${{ secrets.ENV_MCP_LOCAL }}" }
- run: npx conversational-api-test-mcp run --env STAGING --reporter junit --out reports/api.xml
```

## Keeping output small

- `responseDetail: "minimal"` returns status, duration and captures only; `"summary"` (default) adds the body, capped at 8,000 chars, and the headers that usually matter (`content-type`, `location`, `retry-after`, rate limits…); `"full"` returns every header and raises the cap to 50,000.
- The body comes back once: `bodyJson` for JSON, `bodyPreview` for text. Both appear only when JSON exceeds the cap (truncated preview plus `topLevelKeys`).
- `jsonPathSelect` projects the body before it is serialized. On an `execute_api_flow` step it returns that step's body, so reading it needs no second call.
- `execute_api_flow` replaces N tool calls with one.
- Parsed definitions and `.env.mcp.local` are cached in memory and invalidated by file `mtime`.

## Security model

The server runs locally with your privileges and is driven by an LLM, so treat API responses and definitions as untrusted input.

- **Redaction.** Auth headers, values under credential-looking JSON keys (`password`, `token`, `secret`, `api_key`, …), JWT-looking strings, credential query parameters and captured credentials are returned as `[REDACTED]`. The real values stay in the session and are still used by later requests. Redaction is name- and shape-based, so it is a safety net, not a guarantee.
- **No implicit environment access.** `process.env` is not part of the interpolation context; only names you list in `MCP_API_ENV_PASSTHROUGH` are reachable, via `{{env.NAME}}`.
- **Responses are data.** Values captured from a response are inserted literally and never re-expanded as templates.
- **Writes are confined.** Definition tools write only under `.mcp/api/` and default to dry-run. `init_workspace` also creates `.env.mcp.local` and adds it to `.gitignore`, and never overwrites an existing file. The import tools append the credentials they lift to `.env.mcp.local`, never replacing a key that is already there.
- **Optional host allowlist.** `MCP_API_ALLOWED_HOSTS` restricts requests — including every redirect hop — to the listed hostnames. It is off by default and is not a complete SSRF defence (no private-range or DNS-rebinding checks).

| Environment variable | Effect |
|----------------------|--------|
| `MCP_WORKSPACE_ROOT` | Default `workspaceRoot` when a tool call omits it. Without it, the server reuses the last `workspaceRoot` it was given, then falls back to its working directory if that already has `.mcp/api/`. |
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
