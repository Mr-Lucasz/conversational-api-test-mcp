import type { LegacyParserStrategy, ParseOptions } from "./LegacyParserStrategy.js";
import { PostmanParser } from "./PostmanParser.js";
import { OpenApiParser } from "./OpenApiParser.js";
import { InsomniaParser } from "./InsomniaParser.js";
import { HarParser } from "./HarParser.js";

const parsers: LegacyParserStrategy[] = [
  new OpenApiParser(),
  new PostmanParser(),
  new InsomniaParser(),
  new HarParser(),
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
  options?: ParseOptions,
): ReturnType<LegacyParserStrategy["parse"]> {
  const parser = getParserForRaw(raw);
  if (!parser) {
    throw new Error(
      "Unsupported legacy format. Use Postman Collection, OpenAPI 3 / Swagger 2, Insomnia export v4 or a HAR file.",
    );
  }
  return parser.parse(raw, options);
}
