import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

describe("parseApiDefinitionYaml merge keys", () => {
  it("merges <<: anchor into endpoint before Zod validation", () => {
    const raw = readFileSync(
      join(repoRoot, "test/fixtures/api-merge-keys.yaml"),
      "utf8",
    );
    const def = parseApiDefinitionYaml(raw);
    const ep = def.endpoints.find((e) => e.id === "merged_endpoint");
    expect(ep).toBeDefined();
    expect(ep?.auth_dependency).toBe("get_token");
    expect(ep?.auth).toBe("Bearer {{TOKEN}}");
    expect(ep?.auth_retry_on_401).toBe(true);
    expect(ep?.method).toBe("GET");
    expect(ep?.path).toBe("/api/items");
  });

  it("merges nested anchor inside body array items", () => {
    const raw = readFileSync(
      join(repoRoot, "test/fixtures/api-merge-nested.yaml"),
      "utf8",
    );
    const def = parseApiDefinitionYaml(raw);
    const post = def.endpoints.find((e) => e.id === "create_playlist");
    expect(post?.auth_dependency).toBe("get_token");
    const body = post?.body as { items?: Record<string, unknown>[] };
    expect(body?.items?.[0]?.externalId).toBe("{{EXTERNAL_ID}}");
    expect(body?.items?.[0]?.ownerId).toBe("{{OWNER_ID}}");
    expect(body?.items?.[0]?.position).toBe(1);
    const add = def.endpoints.find((e) => e.id === "add_playlist_items");
    const addBody = add?.body as { items?: Record<string, unknown>[] };
    expect(addBody?.items?.[0]?.ownerId).toBe("{{OWNER_ID}}");
  });
});
