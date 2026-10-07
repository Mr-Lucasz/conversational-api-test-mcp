export type ResourceDef = {
  name?: string;
  uri: string;
  mimeType: string;
  content: string;
};

export function getAllResources(): ResourceDef[] {
  return [
    {
      name: "api-docs-efficient-read-paths",
      uri: "api://docs/efficient_read_paths",
      mimeType: "text/plain",
      content: [
        "Token-efficient reading guide for the `mcp-conversational-api` MCP server.",
        "",
        "Goals:",
        "- Avoid reading a whole YAML when triage is enough.",
        "- Cut MCP round trips (N+1) in multi-step flows.",
        "- Keep tool payloads small (preview / projection).",
        "",
        "Recommended order:",
        "1) `list_api_definitions` with `maxFiles` and, when available, `includeCatalogMeta: true`.",
        "2) Filter with `query` (path/service/summary via `_catalog.yaml` when present).",
        "3) Prefer `summarize_api_definition` for triage (detailLevel `names_only`).",
        "4) Run the API with `execute_api_request` using `responseDetail: minimal` or `summary`.",
        "   - Use `jsonPathSelect` when you need one subtree of the JSON.",
        "   - Use `maxBodyChars` to shrink `bodyPreview`.",
        "5) For multi-step chains use `execute_api_flow` (instead of N separate calls).",
        "",
        "Note:",
        "- `read_api_definition` exists for audits / specific needs and returns more data.",
        "- To keep cost down, fetch the smallest contract that answers the question first.",
      ].join("\n"),
    },
    {
      name: "api-catalog-summary",
      uri: "api://catalog/summary",
      mimeType: "text/plain",
      content: [
        "Catalog (_catalog.yaml) — how the server uses it to improve discovery.",
        "",
        "Expected shape (minimum):",
        "- An object with a `definitions` list.",
        "- Each item has at least `path`.",
        "- Optionally `service` and `summary` (short text).",
        "",
        "Usage:",
        "- `list_api_definitions` with `includeCatalogMeta: true` tries to attach `service`/`summary` to the result.",
        "- `list_api_definitions` with `query` also filters by `summary` and `service` (when present).",
        "",
        "Without a catalog:",
        "- The server still works with `globPattern` and returns only `files` (paths).",
      ].join("\n"),
    },
  ];
}

