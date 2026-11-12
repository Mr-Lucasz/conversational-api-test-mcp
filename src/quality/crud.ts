import type {
  ApiDefinitionYaml,
  EndpointDefinition,
  FlowStep,
} from "../canonical/schema.js";

/**
 * Infers create → read → update → read → delete → read-again flows from the endpoints a
 * definition already has: `POST /orders` plus `GET|PUT|PATCH|DELETE /orders/{{order_id}}`.
 * The last read must answer 404/410, which catches a delete that does not delete (the
 * "use after free" of REST). The id is captured from the create response (`$.id` unless
 * the create endpoint already captures that variable).
 */

export type CrudProposal = {
  resource: string;
  flowName: string;
  steps: Array<string | FlowStep>;
  /** Capture to add to the create endpoint (variable → JSONPath), when it lacks one. */
  addCapture?: { endpointId: string; variable: string; jsonPath: string };
  /** Copy of the read endpoint without its assert, for the after-delete step. */
  goneEndpoint?: EndpointDefinition;
  notes: string[];
};

const ITEM = /^(.*)\/\{\{([^}]+)\}\}\/?$/;

function resourceName(collectionPath: string): string {
  const last = collectionPath.split("/").filter(Boolean).pop() ?? "root";
  return last.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

export function inferCrudFlows(def: ApiDefinitionYaml): CrudProposal[] {
  const out: CrudProposal[] = [];
  const creates = def.endpoints.filter((e) => e.method === "POST");
  for (const create of creates) {
    const collection = create.path.replace(/\/$/, "");
    const items = def.endpoints.filter((e) => {
      const m = ITEM.exec(e.path);
      return m && (m[1] ?? "").replace(/\/$/, "") === collection;
    });
    if (!items.length) continue;
    const variable = ITEM.exec(items[0]!.path)![2]!;
    const byMethod = (m: EndpointDefinition["method"]) => items.find((e) => e.method === m);
    const read = byMethod("GET");
    const update = byMethod("PUT") ?? byMethod("PATCH");
    const del = byMethod("DELETE");
    if (!read && !del) continue;

    const resource = resourceName(collection);
    const flowName = `crud_${resource}`;
    if (def.flows?.[flowName]) continue;
    const notes: string[] = [];
    const steps: Array<string | FlowStep> = [create.id];
    if (read) steps.push(read.id);
    if (update) steps.push(update.id, ...(read ? [read.id] : []));
    let goneEndpoint: EndpointDefinition | undefined;
    if (del) {
      steps.push(del.id);
      if (read) {
        const goneId = `${read.id}_after_delete`;
        // Its own endpoint: the read's assert (status 200, a schema) would fail on the 404.
        if (!def.endpoints.some((e) => e.id === goneId)) {
          goneEndpoint = {
            ...structuredClone(read),
            id: goneId,
            description: `${read.method} ${read.path} after the delete: must be gone`,
          };
          delete goneEndpoint.assert;
          delete goneEndpoint.capture;
        }
        steps.push({ requestId: goneId, optional: false, acceptStatus: [404, 410] });
      } else {
        notes.push("no GET for one item: the flow cannot check that the delete really deleted");
      }
    } else {
      notes.push("no DELETE: the flow leaves the created object behind");
    }

    const captures = create.capture ?? {};
    const addCapture = captures[variable]
      ? undefined
      : { endpointId: create.id, variable, jsonPath: "$.id" };
    if (addCapture) {
      notes.push(`assumes the create response returns the id at $.id (captured into ${variable}); change the JSONPath if it does not`);
    }
    out.push({ resource, flowName, steps, addCapture, goneEndpoint, notes });
  }
  return out;
}

/** Applies the proposals to a copy of the definition. */
export function applyCrudProposals(
  def: ApiDefinitionYaml,
  proposals: CrudProposal[],
): ApiDefinitionYaml {
  const next: ApiDefinitionYaml = structuredClone(def);
  next.flows = { ...(next.flows ?? {}) };
  for (const p of proposals) {
    if (p.addCapture) {
      const ep = next.endpoints.find((e) => e.id === p.addCapture!.endpointId);
      if (ep) ep.capture = { ...(ep.capture ?? {}), [p.addCapture.variable]: p.addCapture.jsonPath };
    }
    if (p.goneEndpoint) next.endpoints.push(p.goneEndpoint);
    next.flows[p.flowName] = {
      description: `Create, read, update and delete one ${p.resource}; the last read must be 404/410`,
      steps: p.steps,
    };
  }
  return next;
}
