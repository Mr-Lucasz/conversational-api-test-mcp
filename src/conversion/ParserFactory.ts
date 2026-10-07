import type { LegacyParserStrategy } from "./LegacyParserStrategy.js";
import { PostmanParser } from "./PostmanParser.js";
import { OpenApiParser } from "./OpenApiParser.js";
import { InsomniaParser } from "./InsomniaParser.js";

const parsers: LegacyParserStrategy[] = [
  new OpenApiParser(),
  new PostmanParser(),
  new InsomniaParser(),
];

export function getParserForRaw(
  raw: unknown,
): LegacyParserStrategy | undefined {
  for (const p of parsers) {
    if (p.canHandle(raw)) {
      return p;
    }
  }
  return undefined;
}

export function parseLegacyToCanonical(
  raw: unknown,
  options?: { serviceName?: string },
): ReturnType<LegacyParserStrategy["parse"]> {
  const parser = getParserForRaw(raw);
  if (!parser) {
    throw new Error(
      "Unsupported legacy format. Use Postman Collection, OpenAPI 3, or Insomnia export v4.",
    );
  }
  return parser.parse(raw, options);
}
