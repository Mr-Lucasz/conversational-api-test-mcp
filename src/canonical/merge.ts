import type { ApiDefinitionYaml, EndpointDefinition } from "./schema.js";

export type MergeConflict =
  | { kind: "duplicate_endpoint_id"; id: string; sources: string[] }
  | {
      kind: "variables_key_mismatch";
      key: string;
      values: { source: string; value: string | undefined }[];
    }
  | {
      kind: "base_url_mismatch";
      values: { source: string; value: string | undefined }[];
    }
  | {
      kind: "service_mismatch";
      values: { source: string; value: string | undefined }[];
    };

function normalizeOptional(s: string | undefined): string | undefined {
  if (s === undefined) {
    return undefined;
  }
  const t = s.trim();
  return t.length ? t : undefined;
}

function uniqueStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Merge multiple canonical definitions into one (concat endpoints, union metadata with conflict detection). */
export function mergeApiDefinitions(
  inputs: { relativePath: string; def: ApiDefinitionYaml }[],
): { merged: ApiDefinitionYaml; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  if (inputs.length === 0) {
    return {
      merged: { version: "1", endpoints: [] },
      conflicts,
    };
  }

  const baseUrls = inputs.map((i) => ({
    source: i.relativePath,
    value: normalizeOptional(i.def.base_url),
  }));
  const distinctBaseKeys = new Set(
    baseUrls.map((b) => b.value ?? "__missing__"),
  );
  if (distinctBaseKeys.size > 1) {
    conflicts.push({ kind: "base_url_mismatch", values: baseUrls });
  }

  const services = inputs.map((i) => ({
    source: i.relativePath,
    value: normalizeOptional(i.def.service),
  }));
  const distinctSvcKeys = new Set(
    services.map((s) => s.value ?? "__missing__"),
  );
  if (distinctSvcKeys.size > 1) {
    conflicts.push({ kind: "service_mismatch", values: services });
  }

  const allKeys = new Set<string>();
  for (const { def } of inputs) {
    if (def.variables) {
      for (const k of Object.keys(def.variables)) {
        allKeys.add(k);
      }
    }
  }
  for (const key of allKeys) {
    const perSource = inputs.map((i) => ({
      source: i.relativePath,
      value: i.def.variables?.[key],
    }));
    const defined = perSource.filter((r) => r.value !== undefined);
    const uniqueVals = new Set(defined.map((d) => String(d.value)));
    if (uniqueVals.size > 1) {
      conflicts.push({
        kind: "variables_key_mismatch",
        key,
        values: perSource,
      });
    }
  }

  const variables: Record<string, string> = {};
  for (const key of allKeys) {
    for (const { def } of inputs) {
      const v = def.variables?.[key];
      if (v !== undefined) {
        variables[key] = v;
        break;
      }
    }
  }

  const idOccurrences: { id: string; source: string }[] = [];
  for (const { relativePath, def } of inputs) {
    for (const ep of def.endpoints) {
      idOccurrences.push({ id: ep.id, source: relativePath });
    }
  }
  const countById = new Map<string, number>();
  for (const row of idOccurrences) {
    countById.set(row.id, (countById.get(row.id) ?? 0) + 1);
  }
  for (const [id, n] of countById) {
    if (n > 1) {
      const sources = uniqueStrings(
        idOccurrences.filter((o) => o.id === id).map((o) => o.source),
      );
      conflicts.push({ kind: "duplicate_endpoint_id", id, sources });
    }
  }

  const endpoints: EndpointDefinition[] = [];
  for (const { def } of inputs) {
    endpoints.push(...def.endpoints);
  }

  // Flows and evals travel with their endpoints; on a name clash the first file wins.
  const flows = Object.assign({}, ...inputs.map((i) => i.def.flows).reverse());
  const evals = Object.assign({}, ...inputs.map((i) => i.def.evals).reverse());

  const first = inputs[0].def;
  const merged: ApiDefinitionYaml = {
    version: first.version ?? "1",
    service: first.service,
    name: first.name,
    base_url: first.base_url,
    variables: Object.keys(variables).length ? variables : undefined,
    ...(Object.keys(flows).length ? { flows } : {}),
    ...(Object.keys(evals).length ? { evals } : {}),
    endpoints,
  };

  return { merged, conflicts };
}
