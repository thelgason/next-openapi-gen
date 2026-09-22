import * as t from "@babel/types";

import type { FileSymbolIndex } from "./symbol-index.js";
import type { SymbolResolver } from "./symbol-resolver.js";

/**
 * Evaluates a `const` whose initializer is computed from other static data: array
 * methods with arrow callbacks, calls to declared pure functions, spreads, member
 * access, arithmetic, comparisons and template literals over literals. Anything
 * outside that subset, or any const that is mutated at module scope, is unresolved.
 */

export type StaticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StaticValue[]
  | { [key: string]: StaticValue };

const UNRESOLVED = Symbol("unresolved");
type Result = StaticValue | typeof UNRESOLVED;

const MAX_STEPS = 20_000;
const MAX_DEPTH = 48;

const ARRAY_METHODS = new Set(["filter", "map", "flatMap", "concat", "includes"]);
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

type Scope = Map<string, StaticValue>;

type Context = {
  resolver: SymbolResolver;
  filePath: string;
  scopes: Scope[];
  steps: { count: number };
  /** `file::name` of every const currently being evaluated, so self-reference ends the walk. */
  evaluating: Set<string>;
};

/** The static value of a const, or `undefined` when it cannot be evaluated. */
export function evaluateStaticValue(
  resolver: SymbolResolver,
  filePath: string,
  name: string,
): StaticValue | undefined {
  const context: Context = {
    resolver,
    filePath,
    scopes: [],
    steps: { count: 0 },
    evaluating: new Set(),
  };
  const value = lookupName(context, name, 0);
  return value === UNRESOLVED ? undefined : value;
}

/** String and number elements of a computed const array, or `undefined` when it is not static. */
export function evaluateStaticArray(
  resolver: SymbolResolver,
  filePath: string,
  name: string,
): (string | number)[] | undefined {
  const value = evaluateStaticValue(resolver, filePath, name);
  if (!Array.isArray(value)) return undefined;
  const values: (string | number)[] = [];
  for (const element of value) {
    if (typeof element !== "string" && typeof element !== "number") return undefined;
    values.push(element);
  }
  return values;
}

function lookupName(context: Context, name: string, depth: number): Result {
  for (let index = context.scopes.length - 1; index >= 0; index--) {
    const scope = context.scopes[index];
    if (scope?.has(name)) return scope.get(name);
  }

  const declaration = context.resolver.resolveDeclaration(context.filePath, name);
  if (!declaration || !t.isVariableDeclarator(declaration.node) || !declaration.node.init) {
    return UNRESOLVED;
  }
  const fileIndex = context.resolver.getIndex(declaration.filePath);
  if (!fileIndex || !isConst(fileIndex, name) || isMutatedAtModuleScope(declaration.ast, name)) {
    return UNRESOLVED;
  }

  const key = `${declaration.filePath}::${name}`;
  if (context.evaluating.has(key)) return UNRESOLVED;
  context.evaluating.add(key);
  const outerFile = context.filePath;
  const outerScopes = context.scopes;
  context.filePath = declaration.filePath;
  context.scopes = [];
  try {
    return evaluate(context, declaration.node.init, depth + 1);
  } finally {
    context.filePath = outerFile;
    context.scopes = outerScopes;
    context.evaluating.delete(key);
  }
}

function isConst(index: FileSymbolIndex, name: string): boolean {
  return (
    index.constLiterals.has(name) ||
    index.constArrays.has(name) ||
    index.constObjects.has(name) ||
    index.constExpressions.has(name)
  );
}

function isMutatedAtModuleScope(ast: t.File, name: string): boolean {
  return ast.program.body.some((statement) => {
    if (!t.isExpressionStatement(statement)) return false;
    const expression = statement.expression;
    if (t.isAssignmentExpression(expression)) {
      return t.isMemberExpression(expression.left) && rootIdentifier(expression.left) === name;
    }
    return (
      t.isCallExpression(expression) &&
      t.isMemberExpression(expression.callee) &&
      t.isIdentifier(expression.callee.property) &&
      MUTATING_METHODS.has(expression.callee.property.name) &&
      rootIdentifier(expression.callee.object) === name
    );
  });
}

function rootIdentifier(node: t.Node): string | undefined {
  let current: t.Node = node;
  while (t.isMemberExpression(current)) current = current.object;
  return t.isIdentifier(current) ? current.name : undefined;
}

function lookupFunction(
  context: Context,
  name: string,
): { node: t.Function; filePath: string } | undefined {
  const declaration = context.resolver.resolveDeclaration(context.filePath, name);
  if (!declaration) return undefined;
  const node = declaration.node;
  if (
    t.isFunctionDeclaration(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isFunctionExpression(node)
  ) {
    return { node, filePath: declaration.filePath };
  }
  return undefined;
}

function evaluate(context: Context, node: t.Node, depth: number): Result {
  if (depth > MAX_DEPTH || ++context.steps.count > MAX_STEPS) return UNRESOLVED;

  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
    return node.value;
  }
  if (t.isNullLiteral(node)) return null;
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isParenthesizedExpression(node) ||
    t.isTSNonNullExpression(node)
  ) {
    return evaluate(context, node.expression, depth + 1);
  }
  if (t.isIdentifier(node)) {
    return node.name === "undefined" ? undefined : lookupName(context, node.name, depth);
  }
  if (t.isArrayExpression(node)) return evaluateArray(context, node, depth);
  if (t.isObjectExpression(node)) return evaluateObject(context, node, depth);
  if (t.isTemplateLiteral(node)) return evaluateTemplate(context, node, depth);
  if (t.isMemberExpression(node)) return evaluateMember(context, node, depth);
  if (t.isUnaryExpression(node)) return evaluateUnary(context, node, depth);
  if (t.isBinaryExpression(node)) {
    if (t.isPrivateName(node.left)) return UNRESOLVED;
    const left = evaluate(context, node.left, depth + 1);
    const right = evaluate(context, node.right, depth + 1);
    if (left === UNRESOLVED || right === UNRESOLVED) return UNRESOLVED;
    return applyBinary(node.operator, left, right);
  }
  if (t.isLogicalExpression(node)) {
    const left = evaluate(context, node.left, depth + 1);
    if (left === UNRESOLVED) return UNRESOLVED;
    if (node.operator === "&&") return left ? evaluate(context, node.right, depth + 1) : left;
    if (node.operator === "||") return left ? left : evaluate(context, node.right, depth + 1);
    return left ?? evaluate(context, node.right, depth + 1);
  }
  if (t.isConditionalExpression(node)) {
    const test = evaluate(context, node.test, depth + 1);
    if (test === UNRESOLVED) return UNRESOLVED;
    return evaluate(context, test ? node.consequent : node.alternate, depth + 1);
  }
  if (t.isCallExpression(node)) return evaluateCall(context, node, depth);
  return UNRESOLVED;
}

function evaluateArray(context: Context, node: t.ArrayExpression, depth: number): Result {
  const values: StaticValue[] = [];
  for (const element of node.elements) {
    if (!element) return UNRESOLVED;
    if (t.isSpreadElement(element)) {
      const spread = evaluate(context, element.argument, depth + 1);
      if (!Array.isArray(spread)) return UNRESOLVED;
      values.push(...spread);
      continue;
    }
    const value = evaluate(context, element, depth + 1);
    if (value === UNRESOLVED) return UNRESOLVED;
    values.push(value);
  }
  return values;
}

function evaluateObject(context: Context, node: t.ObjectExpression, depth: number): Result {
  const result: Record<string, StaticValue> = {};
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) {
      const spread = evaluate(context, property.argument, depth + 1);
      if (!isRecord(spread)) return UNRESOLVED;
      Object.assign(result, spread);
      continue;
    }
    if (!t.isObjectProperty(property)) return UNRESOLVED;
    const key = propertyKey(context, property, depth);
    if (key === undefined) return UNRESOLVED;
    const value = evaluate(context, property.value, depth + 1);
    if (value === UNRESOLVED) return UNRESOLVED;
    result[key] = value;
  }
  return result;
}

function propertyKey(
  context: Context,
  property: t.ObjectProperty,
  depth: number,
): string | undefined {
  if (!property.computed) {
    if (t.isIdentifier(property.key)) return property.key.name;
    if (t.isStringLiteral(property.key)) return property.key.value;
    if (t.isNumericLiteral(property.key)) return String(property.key.value);
    return undefined;
  }
  const key = evaluate(context, property.key, depth + 1);
  return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
}

function evaluateTemplate(context: Context, node: t.TemplateLiteral, depth: number): Result {
  let text = "";
  for (const [position, quasi] of node.quasis.entries()) {
    text += quasi.value.cooked ?? quasi.value.raw;
    const expression = node.expressions[position];
    if (!expression) continue;
    const value = evaluate(context, expression, depth + 1);
    if (value === UNRESOLVED || (typeof value === "object" && value !== null)) return UNRESOLVED;
    text += String(value);
  }
  return text;
}

function evaluateMember(context: Context, node: t.MemberExpression, depth: number): Result {
  const object = evaluate(context, node.object, depth + 1);
  if (object === UNRESOLVED || object === null || object === undefined) return UNRESOLVED;

  let key: string | undefined;
  if (!node.computed && t.isIdentifier(node.property)) key = node.property.name;
  else if (node.computed) {
    const computed = evaluate(context, node.property, depth + 1);
    if (typeof computed !== "string" && typeof computed !== "number") return UNRESOLVED;
    key = String(computed);
  }
  if (key === undefined) return UNRESOLVED;

  if (Array.isArray(object)) {
    if (key === "length") return object.length;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < object.length
      ? object[index]
      : undefined;
  }
  if (typeof object === "string") return key === "length" ? object.length : UNRESOLVED;
  // A key absent from a fully known object is a known `undefined`, not an unknown.
  if (isRecord(object)) return Object.hasOwn(object, key) ? object[key] : undefined;
  return UNRESOLVED;
}

function evaluateUnary(context: Context, node: t.UnaryExpression, depth: number): Result {
  const value = evaluate(context, node.argument, depth + 1);
  if (value === UNRESOLVED) return UNRESOLVED;
  if (node.operator === "!") return !value;
  if (node.operator === "-") return typeof value === "number" ? -value : UNRESOLVED;
  return UNRESOLVED;
}

function applyBinary(operator: string, left: StaticValue, right: StaticValue): Result {
  switch (operator) {
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "+":
      if (typeof left === "number" && typeof right === "number") return left + right;
      if (
        isPrimitive(left) &&
        isPrimitive(right) &&
        (typeof left === "string" || typeof right === "string")
      ) {
        return String(left) + String(right);
      }
      return UNRESOLVED;
    case "-":
    case "*":
    case "/": {
      if (typeof left !== "number" || typeof right !== "number") return UNRESOLVED;
      const value =
        operator === "-" ? left - right : operator === "*" ? left * right : left / right;
      return Number.isFinite(value) ? value : UNRESOLVED;
    }
    case "<":
    case ">":
    case "<=":
    case ">=": {
      if (typeof left !== typeof right) return UNRESOLVED;
      if (typeof left !== "number" && typeof left !== "string") return UNRESOLVED;
      const l = left as number;
      const r = right as number;
      return operator === "<"
        ? l < r
        : operator === ">"
          ? l > r
          : operator === "<="
            ? l <= r
            : l >= r;
    }
    default:
      return UNRESOLVED;
  }
}

function evaluateCall(context: Context, node: t.CallExpression, depth: number): Result {
  if (
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.property) &&
    ARRAY_METHODS.has(node.callee.property.name)
  ) {
    const receiver = evaluate(context, node.callee.object, depth + 1);
    if (!Array.isArray(receiver)) return UNRESOLVED;
    return applyArrayMethod(context, receiver, node.callee.property.name, node, depth);
  }

  if (!t.isIdentifier(node.callee)) return UNRESOLVED;
  const target = lookupFunction(context, node.callee.name);
  if (!target) return UNRESOLVED;
  const args: StaticValue[] = [];
  for (const argument of node.arguments) {
    if (!t.isExpression(argument)) return UNRESOLVED;
    const value = evaluate(context, argument, depth + 1);
    if (value === UNRESOLVED) return UNRESOLVED;
    args.push(value);
  }
  return callFunction(context, target.node, target.filePath, args, depth);
}

function applyArrayMethod(
  context: Context,
  receiver: StaticValue[],
  method: string,
  node: t.CallExpression,
  depth: number,
): Result {
  const first = node.arguments[0];

  if (method === "filter" || method === "map" || method === "flatMap") {
    if (!first || (!t.isArrowFunctionExpression(first) && !t.isFunctionExpression(first))) {
      return UNRESOLVED;
    }
    const out: StaticValue[] = [];
    for (const [index, element] of receiver.entries()) {
      const result = callFunction(context, first, context.filePath, [element, index], depth);
      if (result === UNRESOLVED) return UNRESOLVED;
      if (method === "filter") {
        if (result) out.push(element);
      } else if (method === "flatMap" && Array.isArray(result)) {
        out.push(...result);
      } else {
        out.push(result);
      }
    }
    return out;
  }

  if (method === "concat") {
    const out = [...receiver];
    for (const argument of node.arguments) {
      if (!t.isExpression(argument)) return UNRESOLVED;
      const value = evaluate(context, argument, depth + 1);
      if (value === UNRESOLVED) return UNRESOLVED;
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
    return out;
  }

  // includes
  if (!first || !t.isExpression(first)) return UNRESOLVED;
  const needle = evaluate(context, first, depth + 1);
  if (needle === UNRESOLVED) return UNRESOLVED;
  return receiver.includes(needle);
}

function callFunction(
  context: Context,
  fn: t.Function,
  filePath: string,
  args: StaticValue[],
  depth: number,
): Result {
  if (depth > MAX_DEPTH) return UNRESOLVED;
  const scope: Scope = new Map();
  for (const [index, parameter] of fn.params.entries()) {
    if (!t.isIdentifier(parameter)) return UNRESOLVED;
    scope.set(parameter.name, args[index]);
  }

  const outerFile = context.filePath;
  context.filePath = filePath;
  context.scopes.push(scope);
  try {
    if (!t.isBlockStatement(fn.body)) return evaluate(context, fn.body, depth + 1);
    // Bodies are limited to `const` bindings followed by one `return`.
    for (const statement of fn.body.body) {
      if (t.isVariableDeclaration(statement) && statement.kind === "const") {
        for (const declarator of statement.declarations) {
          if (!t.isIdentifier(declarator.id) || !declarator.init) return UNRESOLVED;
          const value = evaluate(context, declarator.init, depth + 1);
          if (value === UNRESOLVED) return UNRESOLVED;
          scope.set(declarator.id.name, value);
        }
        continue;
      }
      if (t.isReturnStatement(statement)) {
        return statement.argument ? evaluate(context, statement.argument, depth + 1) : undefined;
      }
      return UNRESOLVED;
    }
    return undefined;
  } finally {
    context.scopes.pop();
    context.filePath = outerFile;
  }
}

function isRecord(value: Result): value is { [key: string]: StaticValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: StaticValue): value is string | number | boolean | null | undefined {
  return typeof value !== "object" || value === null;
}
