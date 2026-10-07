import type { ApiDefinitionYaml } from "../canonical/schema.js";

export type ParseLoss = {
  code: string;
  message: string;
};

export type ParseResult = {
  canonical: ApiDefinitionYaml;
  losses: ParseLoss[];
  sourceLabel: string;
};

export interface LegacyParserStrategy {
  readonly id: string;
  canHandle(raw: unknown): boolean;
  parse(raw: unknown, options?: { serviceName?: string }): ParseResult;
}
