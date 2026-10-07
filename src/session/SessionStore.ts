import { resolve } from "node:path";

export type LastHttpResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

export type SessionState = {
  variables: Record<string, string>;
  lastResponse?: LastHttpResponse;
};

const sessions = new Map<string, SessionState>();

function workspaceKey(workspaceRoot: string): string {
  return resolve(workspaceRoot);
}

export function getSession(workspaceRoot: string): SessionState {
  const k = workspaceKey(workspaceRoot);
  let s = sessions.get(k);
  if (!s) {
    s = { variables: {} };
    sessions.set(k, s);
  }
  return s;
}

export function setSessionVariable(
  workspaceRoot: string,
  name: string,
  value: string,
): void {
  const s = getSession(workspaceRoot);
  s.variables[name] = value;
}

export function getSessionVariable(
  workspaceRoot: string,
  name: string,
): string | undefined {
  return getSession(workspaceRoot).variables[name];
}

export function deleteSessionVariables(
  workspaceRoot: string,
  names: string[],
): void {
  const s = getSession(workspaceRoot);
  for (const n of names) {
    delete s.variables[n];
  }
}

export function setLastResponse(
  workspaceRoot: string,
  response: LastHttpResponse,
): void {
  const s = getSession(workspaceRoot);
  s.lastResponse = response;
}

export function getLastResponse(
  workspaceRoot: string,
): LastHttpResponse | undefined {
  return getSession(workspaceRoot).lastResponse;
}

/** Test helper */
export function clearSessionForTests(workspaceRoot: string): void {
  sessions.delete(workspaceKey(workspaceRoot));
}
