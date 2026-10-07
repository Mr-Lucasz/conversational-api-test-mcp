import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { apiDefinitionYamlSchema, type ApiDefinitionYaml } from "./schema.js";

export function parseApiDefinitionYaml(content: string): ApiDefinitionYaml {
  const raw = parseYaml(content, { merge: true });
  return apiDefinitionYamlSchema.parse(raw);
}

export function stringifyApiDefinitionYaml(def: ApiDefinitionYaml): string {
  return stringifyYaml(def, { lineWidth: 0 });
}

/**
 * Cache de definições parseadas/validadas por caminho absoluto, invalidada por `mtimeMs`.
 * O processo MCP é long-lived por sessão (mesmo padrão do SessionStore em memória), então
 * evita reler/reparsear/revalidar (Zod) o YAML inteiro a cada `execute_api_request`.
 */
const definitionCache = new Map<
  string,
  { mtimeMs: number; def: ApiDefinitionYaml }
>();

export function readApiDefinitionFile(path: string): ApiDefinitionYaml {
  const key = resolve(path);
  const mtimeMs = statSync(key).mtimeMs;
  const cached = definitionCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.def;
  }
  const content = readFileSync(key, "utf8");
  const def = parseApiDefinitionYaml(content);
  definitionCache.set(key, { mtimeMs, def });
  return def;
}

/** Test helper: força releitura na próxima chamada (usado quando um teste reescreve o mesmo caminho). */
export function clearApiDefinitionCacheForTests(): void {
  definitionCache.clear();
}

export function writeApiDefinitionFile(path: string, def: ApiDefinitionYaml): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, stringifyApiDefinitionYaml(def), "utf8");
}

/** Copy existing file to `{path}.bak.{timestamp}`; returns backup path or null if file did not exist. */
export function backupApiDefinitionFileIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const bak = `${path}.bak.${Date.now()}`;
  copyFileSync(path, bak);
  return bak;
}

/**
 * Write YAML atomically (temp in same directory, then replace). Windows-safe replace.
 * Prefer this for new write tools; `writeApiDefinitionFile` kept for callers that rely on sync semantics.
 */
export function writeApiDefinitionFileAtomic(path: string, def: ApiDefinitionYaml): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = join(
    dir,
    `.${basename(path)}.tmp.${randomBytes(8).toString("hex")}`,
  );
  writeFileSync(tmp, stringifyApiDefinitionYaml(def), "utf8");
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) {
        unlinkSync(tmp);
      }
    } catch {
      /* ignore */
    }
    throw e;
  }
}
