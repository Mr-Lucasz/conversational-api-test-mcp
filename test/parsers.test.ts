import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseLegacyToCanonical } from "../src/conversion/ParserFactory.js";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";
import { basicHeader, fixtureAuth, postmanAuthFixtureText } from "./postmanAuthFixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

describe("legacy parsers", () => {
  it("imports Postman minimal", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "postman-minimal.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.endpoints.length).toBe(1);
    expect(r.canonical.endpoints[0].method).toBe("GET");
    expect(r.losses.length).toBe(0);
  });

  it("takes base_url from the Postman collection variable and keeps the query string", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "postman-variables.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.variables?.base_url).toBe("https://api.example.com/v1");
    expect(r.canonical.endpoints[0].path).toBe("/comments?postId=1");
    expect(r.canonical.endpoints[1].path).toBe("/health");
    expect(r.losses.map((l) => l.code)).not.toContain("POSTMAN_BASE_URL_UNRESOLVED");
  });

  it("takes base_url from an absolute Postman URL", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "postman-minimal.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.variables?.base_url).toBe("https://example.com");
  });

  it("reports an unresolved Postman base URL", () => {
    const r = parseLegacyToCanonical(
      {
        info: { schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        item: [{ name: "x", request: { method: "GET", url: "{{host}}/x" } }],
      },
      { serviceName: "t" },
    );
    expect(r.canonical.variables?.base_url).toBe("");
    expect(r.losses.map((l) => l.code)).toContain("POSTMAN_BASE_URL_UNRESOLVED");
  });
  describe("Postman authorization and bodies", () => {
    const r = parseLegacyToCanonical(JSON.parse(postmanAuthFixtureText) as unknown, {
      serviceName: "t",
    });
    const ep = (description: string) => {
      const found = r.canonical.endpoints.find((e) => e.description === description);
      if (!found) throw new Error(`no endpoint ${description}`);
      return found;
    };

    it("inherits the collection auth and drops disabled headers", () => {
      expect(ep("Inherits").auth).toBe(`Bearer ${fixtureAuth().token}`);
      expect(ep("Inherits").headers).toEqual({ Accept: "application/json" });
    });

    it("uses the folder auth, and noauth turns it off", () => {
      expect(ep("Admin/Folder auth").auth).toBe(basicHeader("Admin"));
      expect(ep("Admin/Public").auth).toBeUndefined();
    });

    it("keeps an Authorization header typed on the request", () => {
      expect(ep("Typed header wins").auth).toBeUndefined();
      expect(ep("Typed header wins").headers).toEqual({ Authorization: "Bearer {{other}}" });
    });

    it("maps API keys to params or headers, in v2.1 and v2.0 form", () => {
      const { key, value } = fixtureAuth("Api key in query");
      expect(ep("Api key in query").params).toEqual({ [key]: value });
      expect(ep("Api key in query").auth).toBeUndefined();
      expect(ep("Api key in header").headers).toEqual({ "X-Api-Key": "{{apiKey}}" });
    });

    it("maps digest auth", () => {
      expect(ep("Digest").digest_auth).toEqual(fixtureAuth("Digest"));
      expect(ep("Digest").auth).toBeUndefined();
    });

    it("maps urlencoded to form and graphql to a JSON body", () => {
      expect(ep("Login form").form).toEqual({ grant_type: "password" });
      expect(ep("Login form").body).toBeUndefined();
      expect(ep("GraphQL").body).toEqual({ query: "query { me { id } }", variables: { limit: 5 } });
    });

    it("reports unsupported auth and body modes with the requests they affect", () => {
      const byCode = Object.fromEntries(r.losses.map((l) => [l.code, l.message]));
      expect(byCode.POSTMAN_AUTH_UNSUPPORTED).toContain('"oauth2"');
      expect(byCode.POSTMAN_AUTH_UNSUPPORTED).toContain("OAuth2");
      expect(byCode.POSTMAN_BODY_MODE).toContain('"formdata"');
      expect(byCode.POSTMAN_BODY_MODE).toContain("Upload");
      expect(ep("OAuth2").auth).toBeUndefined();
    });

    it("produces a definition the canonical schema accepts", () => {
      expect(() => parseApiDefinitionYaml(JSON.stringify(r.canonical))).not.toThrow();
    });
  });

  it("reports smart losses for Postman collection scripts", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "postman-with-scripts.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    const codes = r.losses.map((l) => l.code);
    expect(codes).toContain("POSTMAN_PRE_REQUEST_SCRIPTS");
    expect(codes).toContain("POSTMAN_TESTS");
    const pre = r.losses.find((l) => l.code === "POSTMAN_PRE_REQUEST_SCRIPTS");
    expect(pre?.message).toMatch(/\{\{\$uuid\}\}/);
    expect(pre?.message).toMatch(/auth_dependency/i);
  });

  it("imports OpenAPI minimal", () => {
    const raw = parseYaml(
      readFileSync(join(fixtures, "openapi-minimal.yaml"), "utf8"),
    );
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.endpoints.some((e) => e.path === "/ping")).toBe(true);
  });

  it("imports Insomnia v4 minimal", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "insomnia-export-v4-minimal.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.endpoints.length).toBe(1);
  });
});

describe("canonical YAML", () => {
  it("parses canonical-minimal", () => {
    const raw = readFileSync(join(fixtures, "canonical-minimal.yaml"), "utf8");
    const def = parseApiDefinitionYaml(raw);
    expect(def.endpoints[0].id).toBe("get_uuid");
  });
});
