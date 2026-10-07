import { describe, expect, it } from "vitest";
import { captureFromJsonBody } from "../src/http/captureFromResponse.js";
import { clearSessionForTests, getSessionVariable } from "../src/session/SessionStore.js";

describe("captureFromResponse", () => {
  it("stores jsonpath value in session", () => {
    const ws = "/tmp/ws-capture-test";
    clearSessionForTests(ws);
    const body = JSON.stringify({ data: { token: "abc" } });
    const r = captureFromJsonBody(ws, body, { myToken: "$.data.token" });
    expect(r.errors.length).toBe(0);
    expect(getSessionVariable(ws, "myToken")).toBe("abc");
  });
});
