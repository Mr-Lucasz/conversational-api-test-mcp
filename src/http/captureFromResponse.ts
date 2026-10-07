import { JSONPath } from "jsonpath-plus";
import { setSessionVariable } from "../session/SessionStore.js";

export function captureFromJsonBody(
  workspaceRoot: string,
  bodyText: string,
  captureMap: Record<string, string> | undefined,
): { applied: Record<string, string>; errors: string[] } {
  const applied: Record<string, string> = {};
  const errors: string[] = [];
  if (!captureMap || Object.keys(captureMap).length === 0) {
    return { applied, errors };
  }
  let data: unknown;
  try {
    data = JSON.parse(bodyText) as unknown;
  } catch (e) {
    errors.push(`capture: response body is not JSON: ${e}`);
    return { applied, errors };
  }
  for (const [varName, jsonPath] of Object.entries(captureMap)) {
    try {
      const results = JSONPath({
        path: jsonPath,
        json: data as object,
        wrap: false,
      });
      const first = Array.isArray(results) ? results[0] : results;
      if (first === undefined || first === null) {
        errors.push(`capture: ${varName}: no match for ${jsonPath}`);
        continue;
      }
      const str = typeof first === "string" ? first : JSON.stringify(first);
      setSessionVariable(workspaceRoot, varName, str);
      applied[varName] = str;
    } catch (e) {
      errors.push(
        `capture: ${varName}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { applied, errors };
}
