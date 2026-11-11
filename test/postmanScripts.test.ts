import { describe, expect, it } from "vitest";
import {
  rewriteDynamicVariables,
  translatePreRequestScripts,
  translateTestScripts,
} from "../src/conversion/postmanScripts.js";
import { parseLegacyToCanonical } from "../src/conversion/ParserFactory.js";

describe("Postman test scripts → assert / capture", () => {
  it("translates the usual pm.test blocks", () => {
    const script = `
var jsonData = pm.response.json();
pm.test("Status is 201", function () {
    pm.response.to.have.status(201);
});
pm.test("fast", () => { pm.expect(pm.response.responseTime).to.be.below(500); });
pm.test("body", function () {
    pm.expect(jsonData.order.status).to.eql("open");
    pm.expect(jsonData.items).to.have.lengthOf(2);
    pm.expect(jsonData.total).to.be.above(10);
    pm.expect(jsonData.order.id).to.exist;
    pm.expect(jsonData["customer name"]).to.include("Ana");
    pm.expect(jsonData.note).to.not.include("error");
    pm.expect(pm.response.text()).to.include("open");
});
pm.environment.set("orderId", jsonData.order.id);
pm.collectionVariables.set('firstItem', pm.response.json().items[0].sku);
`;
    expect(translateTestScripts([script])).toEqual({
      assert: {
        status: 201,
        maxDurationMs: 500,
        jsonPathExists: "$.order.id",
        checks: [
          { path: "$.order.status", equals: "open" },
          { path: "$.items", minLength: 2, maxLength: 2 },
          { path: "$.total", min: 11 },
          { path: "$['customer name']", contains: "Ana" },
          { path: "$.note", notContains: "error" },
          { contains: "open" },
        ],
      },
      capture: { orderId: "$.order.id", firstItem: "$.items[0].sku" },
      unconverted: 0,
    });
  });

  it("counts what it cannot translate", () => {
    const r = translateTestScripts([
      `pm.test("x", function () { pm.expect(pm.response.headers.get("X")).to.eql("1"); });
tests["legacy"] = responseCode.code === 200;
pm.environment.set("sum", jsonData.a + jsonData.b);
pm.response.to.have.status(200);`,
    ]);
    expect(r.assert).toEqual({ status: 200 });
    expect(r.unconverted).toBe(3);
  });

  it("applies collection scripts before the request's own", () => {
    const r = translateTestScripts([
      "pm.response.to.have.status(200);",
      "pm.response.to.have.status(204);",
    ]);
    expect(r.assert?.status).toBe(204);
  });
});

describe("Postman pre-request scripts → variables", () => {
  it("maps generated ids and timestamps to macros", () => {
    const r = translatePreRequestScripts([
      `pm.environment.set("rid", require('uuid').v4());
pm.variables.set("cid", crypto.randomUUID());
pm.environment.set("now", Date.now());
pm.environment.set("secs", Math.floor(Date.now() / 1000));
pm.environment.set("iso", new Date().toISOString());
pm.environment.set("plan", "gold");
pm.request.headers.add({ key: "X-Sig", value: CryptoJS.HmacSHA256("a", "b").toString() });`,
    ]);
    expect(r.variables).toEqual({
      rid: "{{$uuid}}",
      cid: "{{$uuid}}",
      now: "{{$timestamp}}",
      secs: "{{$timestampSeconds}}",
      iso: "{{$isoTimestamp}}",
      plan: "gold",
    });
    expect(r.unconverted).toBe(1);
  });

  it("rewrites Postman dynamic variables", () => {
    expect(
      rewriteDynamicVariables({ path: "/x/{{$guid}}", body: { at: "{{$timestamp}}", r: "{{$randomInt}}" } }),
    ).toEqual({ path: "/x/{{$uuid}}", body: { at: "{{$timestampSeconds}}", r: "{{$randomInt}}" } });
  });
});

describe("Postman conversion with scripts", () => {
  it("puts assert, capture and variables on the endpoints, and names what is left", () => {
    const r = parseLegacyToCanonical(
      {
        info: { schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        event: [{ listen: "test", script: { exec: ["pm.response.to.have.status(200);"] } }],
        item: [
          {
            name: "Login",
            event: [
              {
                listen: "test",
                script: { exec: ["pm.environment.set('token', pm.response.json().access_token);"] },
              },
            ],
            request: { method: "POST", url: "https://api.example.com/login" },
          },
          {
            name: "Signed",
            event: [
              { listen: "prerequest", script: { exec: ["pm.environment.set('rid', crypto.randomUUID());", "sign(pm.request);"] } },
            ],
            request: { method: "GET", url: "https://api.example.com/x?r={{$guid}}" },
          },
        ],
      },
      { serviceName: "t" },
    );
    const [login, signed] = r.canonical.endpoints;
    expect(login.assert).toEqual({ status: 200 });
    expect(login.capture).toEqual({ token: "$.access_token" });
    expect(signed.assert).toEqual({ status: 200 });
    expect(signed.path).toBe("/x?r={{$uuid}}");
    expect(r.canonical.variables?.rid).toBe("{{$uuid}}");
    const codes = r.losses.map((l) => l.code);
    expect(codes).not.toContain("POSTMAN_TESTS");
    expect(r.losses.find((l) => l.code === "POSTMAN_PRE_REQUEST_SCRIPTS")?.message).toContain(
      "Requests: Signed.",
    );
  });
});
