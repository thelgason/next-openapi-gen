import { describe, expect, it } from "vitest";

import { evaluateStaticValue } from "@workspace/openapi-core/shared/static-value-evaluator.js";
import { SymbolResolver } from "@workspace/openapi-core/shared/symbol-resolver.js";

const files = new Map<string, string>([
  [
    "/app/data.ts",
    `
      export const ITEMS = [
        { code: "a", size: 1, on: true },
        { code: "b", size: 2, on: false },
        { code: "c", size: 3 },
      ] as const;
      export function codes(flag: "on") {
        const kept = ITEMS.filter((item) => item[flag] !== false);
        return kept.map((item) => item.code);
      }
      export const pick = (list, index) => list[index];
    `,
  ],
  [
    "/app/values.ts",
    `
      import { ITEMS, codes, pick } from "./data";
      import { MISSING } from "./nowhere";

      export const FROM_FUNCTION = codes("on");
      export const FROM_ARROW = pick(ITEMS, 1);
      export const FLAT = ITEMS.flatMap((item) => [item.code, item.code]);
      export const CONCAT = ["x"].concat(["y"], "z");
      export const HAS = ["a", "b"].includes("b");
      export const ARITHMETIC = [1 + 2, 6 - 1, 2 * 3, 8 / 2, -1, "a" + 1];
      export const COMPARE = [1 < 2, 2 > 1, 1 <= 1, 2 >= 3, 1 === 1, 1 !== 1];
      export const LOGIC = [null ?? "d", 0 || "o", 1 && "a", !0];
      export const TERNARY = ITEMS.length > 2 ? "many" : "few";
      export const TEMPLATE = \`\${ITEMS[0].code}-\${ITEMS.length}-\${"s".length}\`;
      export const OBJECT = { ...({ a: 1 } as const), ["b" + "c"]: 2, 3: "three" };
      export const OUT_OF_RANGE = [ITEMS[9], ITEMS[0].nope, undefined];
      export const WRAPPED = (ITEMS satisfies readonly unknown[])!;

      export const HOLE = [1, , 2];
      export const SPREAD_SCALAR = [...1];
      export const SPREAD_OBJECT_ARRAY = { ...[1] };
      export const METHOD_PROPERTY = { run() {} };
      export const BAD_KEY = { [ITEMS]: 1 };
      export const TEMPLATE_OBJECT = \`\${ITEMS}\`;
      export const MEMBER_OF_NULL = ITEMS[0].nope.deeper;
      export const MEMBER_OF_NUMBER = ITEMS.length.x;
      export const COMPUTED_KEY_OBJECT = ITEMS[ITEMS];
      export const DIVIDE_BY_ZERO = 1 / 0;
      export const MIXED_MATH = "a" - 1;
      export const MIXED_COMPARE = "a" < 1;
      export const OBJECT_CONCAT = ITEMS[0] + "x";
      export const BAD_UNARY = ~1;
      export const BAD_BINARY = 1 << 2;
      export const NOT_ARRAY_METHOD = "abc".includes("a");
      export const BAD_CALLBACK = ITEMS.map(codes);
      export const UNSUPPORTED_METHOD = ITEMS.slice(1);
      export const SPREAD_ARG = codes(...["on"]);
      export const UNKNOWN_CALL = compute();
      export const RUNTIME = Math.max(1, 2);
      export const UNRESOLVED_IMPORT = [...MISSING];
      export const LET_VALUE = ["a"].map((x) => x);
      export const NOT_CONST = LET_VALUE;
      export const SELF = [...SELF];
      export const MUTATED = ["a"].map((x) => x);
      MUTATED.push("b");
      export const ASSIGNED = ["a"].map((x) => x);
      ASSIGNED[0] = "b";

      export function loops(n) { return loops(n + 1); }
      export const DEEP = loops(0);
      export function twoStatements(n) { let m = n; return m; }
      export const STATEMENTS = twoStatements(1);
      export function noReturn(n) { const m = n; }
      export const NO_RETURN = [noReturn(1)];
      export function destructured({ a }) { return a; }
      export const DESTRUCTURED = destructured({ a: 1 });
      export function bareReturn() { return; }
      export const BARE_RETURN = [bareReturn()];
    `,
  ],
]);

const resolver = new SymbolResolver({
  existsSync: (filePath: string) => files.has(filePath),
  readFileSync: (filePath: string) => files.get(filePath) ?? "",
});

const evaluate = (name: string) => evaluateStaticValue(resolver, "/app/values.ts", name);

describe("evaluateStaticValue", () => {
  it("evaluates declared functions, array methods, operators and template literals", () => {
    expect(evaluate("FROM_FUNCTION")).toEqual(["a", "c"]);
    expect(evaluate("FROM_ARROW")).toEqual({ code: "b", size: 2, on: false });
    expect(evaluate("FLAT")).toEqual(["a", "a", "b", "b", "c", "c"]);
    expect(evaluate("CONCAT")).toEqual(["x", "y", "z"]);
    expect(evaluate("HAS")).toBe(true);
    expect(evaluate("ARITHMETIC")).toEqual([3, 5, 6, 4, -1, "a1"]);
    expect(evaluate("COMPARE")).toEqual([true, true, true, false, true, false]);
    expect(evaluate("LOGIC")).toEqual(["d", "o", "a", true]);
    expect(evaluate("TERNARY")).toBe("many");
    expect(evaluate("TEMPLATE")).toBe("a-3-1");
    expect(evaluate("OBJECT")).toEqual({ a: 1, bc: 2, 3: "three" });
    expect(evaluate("OUT_OF_RANGE")).toEqual([undefined, undefined, undefined]);
    expect(evaluate("WRAPPED")).toHaveLength(3);
    expect(evaluate("NO_RETURN")).toEqual([undefined]);
    expect(evaluate("BARE_RETURN")).toEqual([undefined]);
  });

  it.each([
    "HOLE",
    "SPREAD_SCALAR",
    "SPREAD_OBJECT_ARRAY",
    "METHOD_PROPERTY",
    "BAD_KEY",
    "TEMPLATE_OBJECT",
    "MEMBER_OF_NULL",
    "MEMBER_OF_NUMBER",
    "COMPUTED_KEY_OBJECT",
    "DIVIDE_BY_ZERO",
    "MIXED_MATH",
    "MIXED_COMPARE",
    "OBJECT_CONCAT",
    "BAD_UNARY",
    "BAD_BINARY",
    "NOT_ARRAY_METHOD",
    "BAD_CALLBACK",
    "UNSUPPORTED_METHOD",
    "SPREAD_ARG",
    "UNKNOWN_CALL",
    "RUNTIME",
    "UNRESOLVED_IMPORT",
    "SELF",
    "MUTATED",
    "ASSIGNED",
    "DEEP",
    "STATEMENTS",
    "DESTRUCTURED",
    "NOWHERE",
  ])("leaves %s unresolved", (name) => {
    expect(evaluate(name)).toBeUndefined();
  });

  it("only evaluates const declarations", () => {
    const letFiles = new Map([
      ["/app/let.ts", `let ITEMS = ["a"].map((x) => x); export const COPY = ITEMS;`],
    ]);
    const letResolver = new SymbolResolver({
      existsSync: (filePath: string) => letFiles.has(filePath),
      readFileSync: (filePath: string) => letFiles.get(filePath) ?? "",
    });
    expect(evaluateStaticValue(letResolver, "/app/let.ts", "COPY")).toBeUndefined();
  });
});
