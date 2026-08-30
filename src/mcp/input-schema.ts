import { createRequire } from "node:module";

import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const draft06MetaSchema = require(
  "ajv/dist/refs/json-schema-draft-06.json",
) as Record<string, unknown>;

export type InputSchemaDialect =
  | "2020-12"
  | "2019-09"
  | "draft-07"
  | "draft-06";

export interface CompiledInputSchema {
  readonly dialect: InputSchemaDialect;
  readonly validate: ValidateFunction<unknown>;
}

const DIALECT_BY_URI = new Map<string, InputSchemaDialect>([
  ["https://json-schema.org/draft/2020-12/schema", "2020-12"],
  ["https://json-schema.org/draft/2019-09/schema", "2019-09"],
  ["http://json-schema.org/draft-07/schema", "draft-07"],
  ["http://json-schema.org/draft-06/schema", "draft-06"],
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function declaredDialect(schema: unknown): InputSchemaDialect {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "2020-12";
  }

  if (!Object.prototype.hasOwnProperty.call(schema, "$schema")) {
    return "2020-12";
  }

  const dialectUri = (schema as Record<string, unknown>)["$schema"];
  if (typeof dialectUri !== "string") {
    throw new Error("input schema $schema must be a string URI");
  }

  const normalizedUri = dialectUri.endsWith("#")
    ? dialectUri.slice(0, -1)
    : dialectUri;
  const dialect = DIALECT_BY_URI.get(normalizedUri);
  if (dialect === undefined) {
    throw new Error(`unsupported JSON Schema dialect '${dialectUri}'`);
  }
  return dialect;
}

function compilerFor(dialect: InputSchemaDialect): Ajv | Ajv2019 | Ajv2020 {
  const options = { allErrors: true, strict: false } as const;
  switch (dialect) {
    case "2020-12":
      return new Ajv2020(options);
    case "2019-09":
      return new Ajv2019(options);
    case "draft-07":
      return new Ajv(options);
    case "draft-06": {
      const ajv = new Ajv(options);
      ajv.addMetaSchema(draft06MetaSchema);
      return ajv;
    }
  }
}

export function compileInputSchema(schema: unknown): CompiledInputSchema {
  const dialect = declaredDialect(schema);
  try {
    const validate = compilerFor(dialect).compile(schema as AnySchema);
    return { dialect, validate };
  } catch (error) {
    throw new Error(
      `could not compile ${dialect} input schema: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
