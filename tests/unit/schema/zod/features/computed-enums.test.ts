import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticsCollector } from "@workspace/openapi-core/diagnostics/collector.js";
import { ZodSchemaConverter } from "@workspace/openapi-core/schema/zod/zod-converter.js";

const LANGUAGES_SOURCE = [
  "type Language = { code: string; label: string; speech?: false; translate?: false };",
  "const LANGUAGES = [",
  "  { code: 'is', label: 'Icelandic' },",
  "  { code: 'en', label: 'English' },",
  "  { code: 'fo', label: 'Faroese', speech: false },",
  "  { code: 'kl', label: 'Greenlandic', speech: false },",
  "] as const satisfies readonly Language[];",
  "type Code = (typeof LANGUAGES)[number]['code'];",
  "function codesFor(product: 'speech' | 'translate'): Code[] {",
  "  return LANGUAGES.filter((l) => (l as Language)[product] !== false).map((l) => l.code);",
  "}",
  "export const SPEECH_CODES = codesFor('speech') as readonly Code[];",
  "export const TRANSLATE_CODES = codesFor('translate') as readonly Code[];",
  "export const ALIASED = SPEECH_CODES;",
  "export const JOINED = [...SPEECH_CODES, ...['x', 'y']].concat('z');",
  "export const LABELS = LANGUAGES.map((l) => `${l.code}:${l.label.length}`);",
  "export const MUTATED = ['a', 'b'].map((code) => code);",
  "MUTATED.push('c');",
  "export const FROM_RUNTIME = Object.keys(process.env);",
  "export const SELF = [...SELF];",
].join("\n");

describe("Zod features › enums from computed constants", () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it("evaluates array methods, declared functions, aliases and spreads over static data", () => {
    const { root, schemaFile } = createProject([
      "import { z } from 'zod';",
      "import { ALIASED, JOINED, LABELS, SPEECH_CODES, TRANSLATE_CODES } from './languages';",
      "export const Schema = z.object({",
      "  speech: z.enum(SPEECH_CODES),",
      "  translate: z.enum(TRANSLATE_CODES),",
      "  aliased: z.enum(ALIASED),",
      "  joined: z.enum(JOINED),",
      "  labels: z.enum(LABELS),",
      "});",
    ]);

    const diagnostics = new DiagnosticsCollector();
    const converter = new ZodSchemaConverter(root, undefined, undefined, diagnostics);
    converter.processAllSchemasInFile(schemaFile);

    expect(converter.zodSchemas.Schema).toMatchObject({
      properties: {
        speech: { type: "string", enum: ["is", "en"] },
        translate: { type: "string", enum: ["is", "en", "fo", "kl"] },
        aliased: { type: "string", enum: ["is", "en"] },
        joined: { type: "string", enum: ["is", "en", "x", "y", "z"] },
        labels: { type: "string", enum: ["is:9", "en:7", "fo:7", "kl:11"] },
      },
    });
    expect(diagnostics.getAll()).toEqual([]);
  });

  it("leaves mutated, runtime-dependent and self-referential constants unresolved", () => {
    const { root, schemaFile } = createProject([
      "import { z } from 'zod';",
      "import { FROM_RUNTIME, MUTATED, SELF } from './languages';",
      "export const Schema = z.object({",
      "  mutated: z.enum(MUTATED),",
      "  runtime: z.enum(FROM_RUNTIME),",
      "  self: z.enum(SELF),",
      "});",
    ]);

    const diagnostics = new DiagnosticsCollector();
    const converter = new ZodSchemaConverter(root, undefined, undefined, diagnostics);
    converter.processAllSchemasInFile(schemaFile);

    expect(converter.zodSchemas.Schema).toEqual({
      type: "object",
      properties: {
        mutated: { type: "string" },
        runtime: { type: "string" },
        self: { type: "string" },
      },
      required: ["mutated", "runtime", "self"],
    });
    expect(diagnostics.getAll().map((diagnostic) => diagnostic.metadata)).toEqual([
      { name: "MUTATED" },
      { name: "FROM_RUNTIME" },
      { name: "SELF" },
    ]);
  });

  function createProject(schemaLines: string[]): { root: string; schemaFile: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nxog-zod-computed-enums-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "languages.ts"), `${LANGUAGES_SOURCE}\n`);
    const schemaFile = path.join(root, "schemas.ts");
    fs.writeFileSync(schemaFile, `${schemaLines.join("\n")}\n`);
    return { root, schemaFile };
  }
});
