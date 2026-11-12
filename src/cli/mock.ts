import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { glob } from "tinyglobby";
import { snapshotFile } from "../assertion/snapshot.js";
import { readApiDefinitionFile } from "../canonical/io.js";
import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import { sampleFromSchema } from "../contract/sample.js";
import { mcpApiDir } from "../workspace/paths.js";
import type { RunCliIo } from "./run.js";

export const MOCK_USAGE = `Usage: conversational-api-test-mcp mock [definition.yaml ...] [options]

Serves the endpoints of the YAML definitions as a mock API, so a frontend or a CI job can
run without the real one. Each endpoint answers, in order of preference: its \`mock\`
block, the body recorded by a values snapshot, a sample built from its assert.schema, or
an empty JSON object.

Options:
  --port <n>         Port to listen on (default 4010).
  --delay <ms>       Wait this long before each answer.
  --workspace <dir>  Project root holding .mcp/api/ (default: current directory).
  -h, --help         Show this help.`;

type Route = {
  id: string;
  file: string;
  method: string;
  pattern: RegExp;
  names: string[];
  ep: EndpointDefinition;
};

type MockAnswer = { status: number; headers: Record<string, string>; body: unknown; source: string };

/** `/pets/{{pet_id}}` or `/pets/{pet_id}` → a regex with one group per placeholder. */
function routeFor(path: string, basePath: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const clean = path.split("?")[0] ?? path;
  const body = clean
    .split(/(\{\{[^}]+\}\}|\{[^}]+\})/)
    .map((part) => {
      const m = /^\{\{?([^}]+)\}?\}$/.exec(part);
      if (m) {
        names.push(m[1] as string);
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const base = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { pattern: new RegExp(`^(?:${base})?${body.replace(/\/$/, "")}/?$`), names };
}

/** The path part of the definition's base URL (`/v1`), after its own variables. */
function basePathOf(def: ApiDefinitionYaml): string {
  let url = def.base_url ?? "";
  for (const [k, v] of Object.entries(def.variables ?? {})) {
    url = url.replaceAll(`{{${k}}}`, v);
  }
  if (/\{\{/.test(url)) return "";
  try {
    return new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** Replaces `{{name}}` in strings of `value` with the path parameters of the request. */
function fill(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (m, k: string) => params[k] ?? m);
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, params)]));
  }
  return value;
}

export function mockAnswerFor(
  ep: EndpointDefinition,
  workspaceRoot: string,
  params: Record<string, string>,
): MockAnswer {
  const status = ep.mock?.status ?? ep.assert?.status ?? (ep.method === "POST" ? 201 : 200);
  const headers = { "content-type": "application/json", ...(ep.mock?.headers ?? {}) };
  if (ep.mock?.body !== undefined) {
    return { status, headers, body: fill(ep.mock.body, params), source: "mock" };
  }
  const snap = ep.assert?.snapshot;
  if (snap && typeof snap === "object" && snap.mode === "values") {
    const file = snapshotFile(workspaceRoot, snap.name);
    if (existsSync(file)) {
      try {
        const stored = JSON.parse(readFileSync(file, "utf8")) as { body?: unknown };
        return { status, headers, body: stored.body, source: "snapshot" };
      } catch {
        // fall through to the schema
      }
    }
  }
  if (ep.assert?.schema !== undefined) {
    try {
      return { status, headers, body: sampleFromSchema(ep.assert.schema, workspaceRoot), source: "schema" };
    } catch {
      // fall through
    }
  }
  return { status, headers, body: status === 204 ? undefined : {}, source: "empty" };
}

export async function loadRoutes(workspaceRoot: string, files: string[]): Promise<Route[]> {
  const paths = files.length
    ? files.map((f) => resolve(workspaceRoot, f))
    : (await glob("**/*.{yaml,yml}", { cwd: mcpApiDir(workspaceRoot), absolute: true }))
        .filter((f) => !/[\\/]_catalog\.ya?ml$/.test(f))
        .sort();
  const routes: Route[] = [];
  for (const file of paths) {
    const def = readApiDefinitionFile(file);
    const basePath = basePathOf(def);
    for (const ep of def.endpoints) {
      routes.push({
        id: ep.id,
        file: relative(workspaceRoot, file).replaceAll("\\", "/"),
        method: ep.method,
        ...routeFor(ep.path, basePath),
        ep,
      });
    }
  }
  // Literal paths first, so `/pets/mine` is not taken by `/pets/{{id}}`.
  return routes.sort((a, b) => a.names.length - b.names.length);
}

export function startMockServer(opts: {
  workspaceRoot: string;
  routes: Route[];
  port: number;
  delayMs?: number;
  log?: (line: string) => void;
}): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = (req.method ?? "GET").toUpperCase();
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    };
    // Drain the request body; the mock does not look at it.
    req.resume();
    req.on("end", () => {
      const send = () => {
        if (method === "OPTIONS" && !opts.routes.some((r) => r.method === "OPTIONS" && r.pattern.test(url.pathname))) {
          res.writeHead(204, cors).end();
          return;
        }
        const wanted = method === "HEAD" ? ["HEAD", "GET"] : [method];
        let match: { route: Route; params: Record<string, string> } | undefined;
        for (const m of wanted) {
          for (const route of opts.routes) {
            const hit = route.method === m ? route.pattern.exec(url.pathname) : null;
            if (hit) {
              match = {
                route,
                params: Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(hit[i + 1] ?? "")])),
              };
              break;
            }
          }
          if (match) break;
        }
        if (!match) {
          opts.log?.(`${method} ${url.pathname} → 404 (no endpoint)`);
          res.writeHead(404, { ...cors, "content-type": "application/json" }).end(
            JSON.stringify({ error: "no mocked endpoint for this method and path" }),
          );
          return;
        }
        const answer = mockAnswerFor(match.route.ep, opts.workspaceRoot, match.params);
        opts.log?.(`${method} ${url.pathname} → ${answer.status} (${match.route.id}, ${answer.source})`);
        res.writeHead(answer.status, { ...cors, ...answer.headers });
        res.end(method === "HEAD" || answer.body === undefined ? undefined : JSON.stringify(answer.body));
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => {
      const addr = server.address();
      resolvePromise({ server, port: typeof addr === "object" && addr ? addr.port : opts.port });
    });
  });
}

/** Entry point of `mock`: resolves once the server listens; returns an exit code on errors. */
export async function runMockCli(
  argv: string[],
  io: RunCliIo,
): Promise<{ code: number; server?: Server }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string" },
        delay: { type: "string" },
        workspace: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n\n${MOCK_USAGE}\n`);
    return { code: 2 };
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(`${MOCK_USAGE}\n`);
    return { code: 0 };
  }
  const port = Number(values.port ?? 4010);
  const delayMs = values.delay ? Number(values.delay) : undefined;
  if (!Number.isInteger(port) || port < 0 || (delayMs !== undefined && !(delayMs >= 0))) {
    io.stderr("--port and --delay take numbers\n");
    return { code: 2 };
  }
  const workspaceRoot = resolve(values.workspace ?? process.cwd());
  let routes: Route[];
  try {
    routes = await loadRoutes(workspaceRoot, positionals);
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return { code: 2 };
  }
  if (!routes.length) {
    io.stderr("no endpoints to mock\n");
    return { code: 2 };
  }
  const { server, port: bound } = await startMockServer({
    workspaceRoot,
    routes,
    port,
    delayMs,
    log: (line) => io.stdout(`${line}\n`),
  });
  io.stdout(`mocking ${routes.length} endpoints on http://localhost:${bound}\n`);
  for (const r of routes) io.stdout(`  ${r.method.padEnd(7)} ${r.ep.path}  (${r.id})\n`);
  return { code: 0, server };
}
