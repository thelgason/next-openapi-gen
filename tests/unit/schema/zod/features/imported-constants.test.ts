import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticsCollector } from "@workspace/openapi-core/diagnostics/collector.js";
import { ZodSchemaConverter } from "@workspace/openapi-core/schema/zod/zod-converter.js";

const LIMITS_SOURCE = [
  "export const MAX_NAME_LENGTH = 5000;",
  "export const MAX_ITEMS = 10;",
  "export const MAX_FILE_BYTES = 1024 * 1024 * 1024 * 2;",
  "export const MIN_TITLE_LENGTH = MAX_ITEMS - 8;",
  "export const COLORS = ['red', 'blue'] as const;",
  "export const STATUS = { open: 'open', done: 'done' } as const;",
  "export const FILE_SIZE_LABEL = `${MAX_FILE_BYTES / (1024 * 1024 * 1024)} GB`;",
].join("\n");

describe("Zod features › constants imported through a tsconfig path alias", () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it("resolves numeric, enum, and template-literal arguments across the alias", () => {
    const { root, schemaFile } = createProject([
      "import { z } from 'zod';",
      "import {",
      "  COLORS,",
      "  FILE_SIZE_LABEL,",
      "  MAX_FILE_BYTES,",
      "  MAX_ITEMS,",
      "  MAX_NAME_LENGTH,",
      "  MIN_TITLE_LENGTH,",
      "  STATUS,",
      "} from '@/constants/limits';",
      "const LOCALES = ['en', 'en-GB'] as const;",
      "export const ProductSchema = z.object({",
      "  names: z",
      "    .array(z.string().max(MAX_NAME_LENGTH))",
      "    .min(1)",
      "    .max(MAX_ITEMS)",
      "    .describe(`Between 1 and ${MAX_ITEMS} items.`),",
      "  title: z.string().min(MIN_TITLE_LENGTH),",
      "  size: z",
      "    .number()",
      "    .max(MAX_FILE_BYTES)",
      "    .describe(",
      "      `At most ${MAX_FILE_BYTES} (${MAX_FILE_BYTES / (1024 * 1024 * 1024)} GB), also ${FILE_SIZE_LABEL}`,",
      "    ),",
      "  color: z.enum(COLORS),",
      "  status: z.enum(STATUS),",
      "  locale: z.enum(LOCALES),",
      "});",
    ]);

    const diagnostics = new DiagnosticsCollector();
    const converter = new ZodSchemaConverter(root, undefined, undefined, diagnostics);
    converter.processAllSchemasInFile(schemaFile);

    expect(converter.zodSchemas.ProductSchema).toEqual({
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string", maxLength: 5000 },
          minItems: 1,
          maxItems: 10,
          description: "Between 1 and 10 items.",
        },
        title: { type: "string", minLength: 2 },
        size: {
          type: "number",
          maximum: 2147483648,
          description: "At most 2147483648 (2 GB), also 2 GB",
        },
        color: { type: "string", enum: ["red", "blue"] },
        status: { type: "string", enum: ["open", "done"] },
        locale: { type: "string", enum: ["en", "en-GB"] },
      },
      required: ["names", "title", "size", "color", "status", "locale"],
    });
    expect(diagnostics.getAll()).toEqual([]);
  });

  it("drops every unresolved argument with a diagnostic", () => {
    const { root, schemaFile } = createProject([
      "import { z } from 'zod';",
      "export const ReportSchema = z.object({",
      "  text: z.string().max(runtimeLimit()),",
      "  note: z.string().describe(`Up to ${RUNTIME_LIMIT} items`),",
      "  slug: z.string().startsWith(PREFIXES.beta),",
      "  count: z.number().max(RUNTIME_LIMIT),",
      "});",
    ]);

    const diagnostics = new DiagnosticsCollector();
    const converter = new ZodSchemaConverter(root, undefined, undefined, diagnostics);
    converter.processAllSchemasInFile(schemaFile);

    expect(converter.zodSchemas.ReportSchema).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        note: { type: "string" },
        slug: { type: "string" },
        count: { type: "number" },
      },
      required: ["text", "note", "slug", "count"],
    });
    expect(diagnostics.getAll()).toEqual([
      expect.objectContaining({
        code: "unresolved-zod-argument",
        severity: "warning",
        metadata: { method: "max", line: 3 },
      }),
      expect.objectContaining({
        code: "unresolved-zod-argument",
        metadata: { method: "describe", name: "RUNTIME_LIMIT", line: 4 },
      }),
      expect.objectContaining({
        code: "unresolved-zod-argument",
        metadata: { method: "startsWith", line: 5 },
      }),
      expect.objectContaining({
        code: "unresolved-zod-argument",
        metadata: { method: "max", name: "RUNTIME_LIMIT", line: 6 },
      }),
    ]);
  });

  it("still resolves constants declared in the schema file itself", () => {
    const { root, schemaFile } = createProject([
      "import { z } from 'zod';",
      "const MAX_LABEL_LENGTH = 40;",
      "const SUFFIX = '-v1';",
      "export const LabelSchema = z.object({",
      "  label: z.string().max(MAX_LABEL_LENGTH).endsWith(SUFFIX),",
      "});",
    ]);

    const converter = new ZodSchemaConverter(root);
    converter.processAllSchemasInFile(schemaFile);

    expect(converter.zodSchemas.LabelSchema).toMatchObject({
      properties: { label: { type: "string", maxLength: 40, pattern: "-v1$" } },
    });
  });

  function createProject(schemaLines: string[]): { root: string; schemaFile: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nxog-zod-imported-consts-"));
    roots.push(root);

    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    fs.mkdirSync(path.join(root, "src", "constants"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "constants", "limits.ts"), `${LIMITS_SOURCE}\n`);

    const schemaFile = path.join(root, "src", "schemas.ts");
    fs.writeFileSync(schemaFile, `${schemaLines.join("\n")}\n`);
    return { root, schemaFile };
  }
});
