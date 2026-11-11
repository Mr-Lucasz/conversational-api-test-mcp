import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { collectAssertFailures } from "../src/assertion/assertResponse.js";

const response = (body: unknown) => ({
  status: 200,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
  durationMs: 10,
});

const openapi = `
openapi: 3.0.3
info: { title: Shop, version: "1" }
paths: {}
components:
  schemas:
    Order:
      type: object
      required: [id, status, customer]
      additionalProperties: false
      properties:
        id: { type: integer }
        status: { type: string, enum: [open, paid] }
        note: { type: string, nullable: true, example: "leave at door" }
        email: { type: string, format: email }
        customer: { $ref: "#/components/schemas/Customer" }
    Customer:
      type: object
      required: [name]
      properties:
        name: { type: string }
`;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-schema-"));
  writeFileSync(join(root, "openapi.yaml"), openapi);
  return root;
}

const ref = "openapi.yaml#/components/schemas/Order";
const good = { id: 1, status: "open", note: null, customer: { name: "Ana" } };

describe("assert.schema", () => {
  it("accepts a body that matches an OpenAPI 3.0 schema, nullable and nested $ref included", () => {
    expect(collectAssertFailures(response(good), { schema: ref }, workspace())).toEqual([]);
  });

  it("reports where and why the body breaks the schema", () => {
    const failures = collectAssertFailures(
      response({ id: "1", status: "lost", email: "nope", customer: {}, extra: true }),
      { schema: ref },
      workspace(),
    );
    const text = failures.join("\n");
    expect(text).toContain("/id must be integer");
    expect(text).toContain("/status must be equal to one of the allowed values");
    expect(text).toContain('/email must match format "email"');
    expect(text).toContain("/customer must have required property 'name'");
    expect(text).toContain("(extra)");
  });

  it("takes an inline schema", () => {
    const schema = { type: "array", items: { type: "object", required: ["id"] }, minItems: 1 };
    expect(collectAssertFailures(response([{ id: 1 }]), { schema })).toEqual([]);
    expect(collectAssertFailures(response([]), { schema })).toEqual([
      "schema: $ must NOT have fewer than 1 items",
    ]);
  });

  it("refuses files outside the workspace, missing files and non-JSON bodies", () => {
    const root = workspace();
    expect(collectAssertFailures(response(good), { schema: "../x.yaml#/a" }, root)[0]).toMatch(
      /inside the workspace/,
    );
    expect(collectAssertFailures(response(good), { schema: "nope.yaml" }, root)[0]).toMatch(
      /not found/,
    );
    expect(collectAssertFailures(response("<html>"), { schema: ref }, root)).toEqual([
      "schema: response body is not JSON",
    ]);
  });

  it("picks up changes to the schema file", () => {
    const root = workspace();
    expect(collectAssertFailures(response(good), { schema: ref }, root)).toEqual([]);
    writeFileSync(join(root, "openapi.yaml"), openapi.replace("enum: [open, paid]", "enum: [paid]"));
    expect(collectAssertFailures(response(good), { schema: ref }, root)).toHaveLength(1);
  });
});
