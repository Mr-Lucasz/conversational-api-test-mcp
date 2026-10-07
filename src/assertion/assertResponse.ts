import { JSONPath } from "jsonpath-plus";
import type { LastHttpResponse } from "../session/SessionStore.js";

export type AssertSpec = {
  status?: number;
  jsonPathExists?: string;
};

export function assertOnResponse(
  response: LastHttpResponse,
  spec: AssertSpec,
): { ok: true } | { ok: false; message: string } {
  if (spec.status !== undefined && response.status !== spec.status) {
    return {
      ok: false,
      message: `Expected status ${spec.status}, got ${response.status}`,
    };
  }
  if (spec.jsonPathExists) {
    let data: unknown;
    try {
      data = JSON.parse(response.bodyText) as unknown;
    } catch {
      return { ok: false, message: "Response body is not JSON" };
    }
    const results = JSONPath({
      path: spec.jsonPathExists,
      json: data as object,
      wrap: false,
    });
    const has =
      results !== undefined &&
      results !== null &&
      !(Array.isArray(results) && results.length === 0);
    if (!has) {
      return {
        ok: false,
        message: `jsonPathExists no match: ${spec.jsonPathExists}`,
      };
    }
  }
  return { ok: true };
}
