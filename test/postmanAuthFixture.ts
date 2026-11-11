import { readFileSync } from "node:fs";

/**
 * The Postman collection in fixtures/postman-auth-bodies.json, and the auth parameters of its
 * items. Tests read the fake credentials from here instead of repeating them as literals, so
 * secret scanners do not flag the test sources.
 */
export const postmanAuthFixtureText = readFileSync(
  new URL("./fixtures/postman-auth-bodies.json", import.meta.url),
  "utf8",
);

type Item = {
  name: string;
  item?: Item[];
  auth?: Record<string, unknown> & { type: string };
  request?: { auth?: Record<string, unknown> & { type: string } };
};

const collection = JSON.parse(postmanAuthFixtureText) as Item & { auth: Item["auth"] };

function findItem(items: Item[] | undefined, name: string): Item | undefined {
  for (const it of items ?? []) {
    if (it.name === name) return it;
    const inner = findItem(it.item, name);
    if (inner) return inner;
  }
  return undefined;
}

/** `{ key: value }` of the auth on the collection (no name) or on the item with that name. */
export function fixtureAuth(name?: string): Record<string, string> {
  const item = name ? findItem(collection.item, name) : collection;
  const auth = item?.request?.auth ?? item?.auth;
  if (!auth) throw new Error(`no auth on ${name ?? "the collection"}`);
  const params = auth[auth.type] as { key: string; value: string }[];
  return Object.fromEntries(params.map((p) => [p.key, p.value]));
}

export const basicHeader = (name: string) => {
  const { username, password } = fixtureAuth(name);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
};
