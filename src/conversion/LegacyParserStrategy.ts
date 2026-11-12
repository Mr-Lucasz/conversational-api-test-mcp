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

export type ParseOptions = {
  serviceName?: string;
  /** Where the source file sits in the workspace, so the definition can point back into it. */
  sourceRelativePath?: string;
};

export interface LegacyParserStrategy {
  readonly id: string;
  canHandle(raw: unknown): boolean;
  parse(raw: unknown, options?: ParseOptions): ParseResult;
}
