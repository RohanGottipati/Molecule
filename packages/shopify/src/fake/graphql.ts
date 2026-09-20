/**
 * Minimal GraphQL request introspection for the fake Admin API.
 *
 * The real callers are not uniform: `packages/shopify/src/transport.ts` and `effects.ts` use
 * NAMED operations (`query Products(...)`, `mutation CreateDraft(...)`), while
 * `scripts/shopify-writeback.mjs` and `scripts/shopify-set-capacity.mjs` use ANONYMOUS ones
 * (`mutation($d:...){metafieldDefinitionCreate(...)}`, `{locations(first:5){...}}`). Some
 * queries also request several root fields at once — `scripts/shopify-sync.mjs` asks for
 * `shop` and `products` together.
 *
 * So dispatch keys on the set of ROOT FIELDS, not on the operation name, and the resolver
 * merges one result per requested root field.
 */

export interface ParsedOperation {
  operationName: string;
  isMutation: boolean;
  rootFields: string[];
  raw: string;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/** Index of the character after the operation signature's opening brace. */
function selectionSetStart(query: string): number {
  let parens = 0;
  let quote: string | undefined;
  for (let index = 0; index < query.length; index++) {
    const char = query[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === "{" && parens === 0) return index + 1;
  }
  return -1;
}

export function parseOperation(query: string): ParsedOperation {
  // The name is optional and may be followed immediately by `(` or `{`, as in
  // `mutation($m:[MetafieldsSetInput!]!){...}` from scripts/shopify-writeback.mjs.
  const header = /^\s*(query|mutation)\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(query);
  const isMutation = header?.[1] === "mutation";
  const operationName = header?.[2] ?? "";
  const start = selectionSetStart(query);
  const rootFields: string[] = [];
  if (start === -1)
    return { operationName, isMutation, rootFields, raw: query };

  let braces = 1;
  let parens = 0;
  let quote: string | undefined;
  for (let index = start; index < query.length && braces > 0; index++) {
    const char = query[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parens++;
      continue;
    }
    if (char === ")") {
      parens--;
      continue;
    }
    if (char === "{") {
      braces++;
      continue;
    }
    if (char === "}") {
      braces--;
      continue;
    }
    // A directive (`field(...) @idempotent(key: $k)`) sits at the same depth as a field name.
    // Skip its name so it is never mistaken for one. scripts/shopify-set-capacity.mjs relies
    // on this.
    if (char === "@") {
      let end = index + 1;
      while (end < query.length && IDENT_PART.test(query[end]!)) end++;
      index = end - 1;
      continue;
    }
    if (braces !== 1 || parens !== 0 || !IDENT_START.test(char)) continue;

    let end = index;
    while (end < query.length && IDENT_PART.test(query[end]!)) end++;
    const name = query.slice(index, end);
    index = end - 1;
    // An alias (`alias: field`) is followed by a colon; the real field name comes next.
    const rest = query.slice(end).match(/^\s*:/);
    if (rest) continue;
    if (name !== "on" && name !== "fragment") rootFields.push(name);
  }
  return { operationName, isMutation, rootFields, raw: query };
}

/** Extracts the argument list of the first occurrence of `field(` in the query. */
export function fieldArguments(
  query: string,
  field: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${field}\\s*\\(`);
  const match = pattern.exec(query);
  if (!match) return {};
  const open = match.index + match[0].length - 1;
  let depth = 0;
  let quote: string | undefined;
  let close = -1;
  for (let index = open; index < query.length; index++) {
    const char = query[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return {};
  return parseArguments(query.slice(open + 1, close), variables);
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      current += char;
      if (char === "\\") current += input[++index] ?? "";
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    if (char === ")" || char === "]" || char === "}") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseArguments(
  input: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevel(input)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    args[name] = parseValue(value, variables);
  }
  return args;
}

function parseValue(
  value: string,
  variables: Record<string, unknown>,
): unknown {
  if (value.startsWith("$")) return variables[value.slice(1)];
  if (value.startsWith('"') || value.startsWith("'")) {
    try {
      return JSON.parse(`"${value.slice(1, -1).replace(/"/g, '\\"')}"`);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.startsWith("[")) {
    return splitTopLevel(value.slice(1, -1)).map((item) =>
      parseValue(item.trim(), variables),
    );
  }
  return value;
}

/** Shopify's `query:` search syntax, reduced to the forms the repo's callers actually use. */
export function matchesSearch(
  search: string | undefined,
  subject: { tags: string[]; handle?: string; title?: string },
): boolean {
  if (!search) return true;
  return search
    .split(/\s+AND\s+|\s+/i)
    .filter(Boolean)
    .every((term) => {
      const [rawField, ...rest] = term.split(":");
      const value = rest.join(":").replace(/^["']|["']$/g, "");
      const field = rawField?.toLowerCase();
      if (!value) return true;
      if (field === "tag") return subject.tags.includes(value);
      if (field === "handle") return subject.handle === value;
      if (field === "title")
        return (subject.title ?? "")
          .toLowerCase()
          .includes(value.toLowerCase());
      return true;
    });
}

export function encodeCursor(index: number): string {
  return Buffer.from(`fake-cursor:${index}`, "utf8").toString("base64");
}

export function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || !cursor) return 0;
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const match = /^fake-cursor:(\d+)$/.exec(decoded);
  return match ? Number(match[1]) : 0;
}

export interface Page<T> {
  items: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export function paginate<T>(
  all: T[],
  args: Record<string, unknown>,
  defaultSize = 50,
): Page<T> {
  const start = decodeCursor(args.after);
  const rawFirst = Number(args.first);
  const size =
    Number.isInteger(rawFirst) && rawFirst > 0 ? rawFirst : defaultSize;
  const items = all.slice(start, start + size);
  const end = start + items.length;
  const hasNextPage = end < all.length;
  return {
    items,
    pageInfo: {
      hasNextPage,
      // Transport treats a repeated or null cursor on a further page as a hard error, so the
      // cursor must advance monotonically.
      endCursor: items.length ? encodeCursor(end) : null,
    },
  };
}

/** Shopify connections are read as `nodes` by some callers and `edges { node }` by others. */
export function connection<T>(page: Page<T>): {
  nodes: T[];
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} {
  const start = 0;
  return {
    nodes: page.items,
    edges: page.items.map((node, index) => ({
      node,
      cursor: encodeCursor(start + index + 1),
    })),
    pageInfo: page.pageInfo,
  };
}
