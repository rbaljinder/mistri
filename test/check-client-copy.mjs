/**
 * One static check over the client's modules: is every word the platform
 * says to a person in the catalog?
 *
 * The catalog began as the preferences dialog's vocabulary and a few list
 * words; everything else was written where it was drawn — a table's empty
 * state in TableView, a calendar's "Today" in CalendarList — so it could be
 * neither read in one place nor translated. The copy moved into the catalog
 * (packages/kit/src/client/messages.ts says how it is laid out), and this check keeps it
 * there. It fails on
 *
 *   - text in JSX, and a string in a copy attribute (`title`, `aria-label`,
 *     `placeholder`…);
 *   - a string anywhere in a client module that reads as prose, a noun's
 *     forms for a count (`{ one: 'row', other: 'rows' }`), and a word a
 *     condition picks for a sentence (`n === 1 ? 'record' : 'records'`);
 *   - a key in the catalog that nothing says any more.
 *
 * What is not copy is read off the syntax, not listed: a module name, a key
 * of an object, a comparison (`e.key === 'Enter'`), a case label, a type, a
 * selector, an attribute or class name, a URL, the query language's and
 * SQL's own words, a query handed to its parser. Text an App defines never
 * appears as a literal at all — it arrives in the App's payload. What still
 * reads as prose and is not copy — a brand, a name the platform does not
 * translate, an example written in the query language — needs an entry
 * below, with its reason; an entry that no longer matches anything fails
 * too, so the list only shrinks with the code.
 *
 *   node test/check-client-copy.mjs          check
 *   node test/check-client-copy.mjs --json   print every finding
 */
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/workspace.mjs';
import { join, relative } from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { parseFiles } from './support/tsc.ts';

const ROOT = new URL('../', import.meta.url).pathname;

/* TypeScript 7's syntax API (typescript/unstable/ast) has no `isFunctionLike`, `isParameter` or `isPropertySignature`: the kinds they were. */
const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.IndexSignature,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.ConstructorType,
]);
const isFunctionLike = (node) => FUNCTION_LIKE.has(node.kind);
const isParameter = (node) => node.kind === ts.SyntaxKind.Parameter;
const isPropertySignature = (node) => node.kind === ts.SyntaxKind.PropertySignature;

/** The catalog itself, where copy is supposed to be. */
const CATALOG = [/^src\/client\/messages\.ts$/, /^src\/client\/copy\//];

/**
 * `file` (a path under src/client, or `*` for any) and the exact `text`
 * found there, and why it stands.
 */
const ALLOWED = [
  { file: 'components/SignIn.tsx', text: 'saml', reason: "a provider id's prefix sent to the server, never shown" },
  { file: 'components/SignIn.tsx', text: 'oidc', reason: "a provider id's prefix sent to the server, never shown" },
  { file: '*', text: 'null', reason: "the database's NULL, drawn as the value itself" },
  {
    file: 'components/ChartShapes.tsx',
    text: '400 11px system-ui, sans-serif',
    reason: "a heat map head's font, to measure its names with, never shown",
  },
  { file: 'components/sdk/blocks.tsx', text: 'Metric', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Chart', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Breakdown', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Rows', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Tabs', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Timeline', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Tree', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Gantt', reason: "a block's component name, as the author writes it in JSX" },
  { file: 'components/sdk/blocks.tsx', text: 'Assistant', reason: "a block's component name, as the author writes it in JSX" },
  { file: '*', text: 'SQL', reason: "the language's name" },
  { file: '*', text: 'tablewalk', reason: "the product's name" },
  { file: '*', text: 'tablewalk.json', reason: "the name of the database browser's configuration file" },
  {
    file: 'components/builtInInputs.tsx',
    text: 'italic 40px Georgia, "Times New Roman", serif',
    reason: 'a canvas font for a typed signature, a CSS font shorthand rather than words',
  },
  {
    file: 'analyticsBeacon.ts',
    text: 'An analytics event is named with its declared name.',
    reason: 'a developer error thrown at a mistaken emit call, never drawn on a page',
  },
  {
    file: 'surfaces.js',
    text: 'No component is registered for the {} surface.',
    reason: 'a developer error thrown at a surface the shell never registered, never drawn on a page',
  },
  { file: 'components/TopNav.tsx', text: '⌘K', reason: 'a keyboard shortcut, drawn as its keys' },
  ...['Not in the page yet.', 'The server renderer runs only on Node.', 'The public render took too long.'].map((text) => ({
    file: 'ssr/render.tsx',
    text,
    reason: 'a refusal the server reads and answers by sending the page without its drawing; no person sees it',
  })),
  {
    file: 'components/BoardList.tsx',
    text: 'count as {}, sum {} as {}',
    reason: "a breakdown's measures in the query language, sent and never shown",
  },
  {
    file: 'components/BoardList.tsx',
    text: '{}, {} as {}',
    reason: "a breakdown's keys in the query language (a lane, then each currency), sent and never shown",
  },
  { file: 'components/useListOrder.tsx', text: 'Alt+ArrowUp Alt+ArrowDown', reason: 'aria-keyshortcuts: key names, not words' },
  { file: 'components/groupMoves.tsx', text: 'Alt+ArrowUp Alt+ArrowDown', reason: 'aria-keyshortcuts: key names, not words' },
  { file: 'components/ApiOperations.tsx', text: 'GET', reason: 'an HTTP method' },
  { file: 'components/AgentConsole.tsx', text: 'isError', reason: "the name of an MCP result's field" },
  { file: 'components/ConnectionDialog.tsx', text: 'PROD_PASSWORD', reason: 'an example environment variable name' },
  { file: 'components/ConnectionDialog.tsx', text: 'postgres://', reason: 'the start of a connection URL, as typed' },
  { file: 'components/QrCode.tsx', text: 'Byte', reason: "the QR encoder's mode name, an argument, never drawn" },
  { file: 'components/builtInInputs.tsx', text: '#1d6a5a', reason: 'an example color code, as typed' },
  {
    file: 'components/Welcome.tsx',
    text: '{\n  "connections": [\n    { "name": "app", "url": "postgres://localhost/appdb" }\n  ]\n}',
    reason: 'a configuration file, shown as written',
  },
  {
    file: 'observe/beacon.js',
    text: '500 11.5px/1 var(--code, ui-monospace, monospace)',
    reason: "the observer badge's inline font, a CSS value",
  },
  { file: 'observe/beacon.js', text: '1px solid var(--line-strong, #cbc5b9)', reason: "the observer badge's inline border, a CSS value" },
  { file: 'visualTheme.ts', text: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', reason: 'a font stack' },
  { file: 'components/diagramModel.ts', text: 'timestamp with time zone', reason: 'a PostgreSQL type name' },
  { file: 'components/diagramModel.ts', text: 'timestamp without time zone', reason: 'a PostgreSQL type name' },
  { file: 'components/diagramModel.ts', text: 'time with time zone', reason: 'a PostgreSQL type name' },
  { file: 'components/diagramModel.ts', text: 'time without time zone', reason: 'a PostgreSQL type name' },
  { file: 'components/diagramModel.ts', text: 'character varying', reason: 'a PostgreSQL type name' },
  { file: 'components/diagramModel.ts', text: 'double precision', reason: 'a PostgreSQL type name' },
  { file: 'components/Ask.tsx', text: 'customer active = true sort name limit 20', reason: 'a query-language example' },
  { file: 'components/filterRailModel.ts', text: 'has {}', reason: 'a query-language condition the tags facet writes' },
  { file: 'components/filterRailModel.ts', text: 'has ({})', reason: 'a query-language condition the tags facet writes' },
  { file: 'publicAddress.ts', text: '{} has {}', reason: 'a query-language condition read back from an address' },
  { file: 'components/Ask.tsx', text: 'invoice count by status', reason: 'a query-language example' },
  { file: 'tour.js', text: 'customer active = true sort name limit 20', reason: 'a query-language example' },
  {
    file: 'components/Composer.tsx',
    text: 'customer_id.country_code.name = Australia and total > 500',
    reason: 'a query-language example',
  },
  {
    file: 'components/Composer.tsx',
    text: 'invoice\n  show id, customer_id.name as customer\n  where total > 500',
    reason: 'a query-language example',
  },
  {
    file: 'components/ThemeLab.tsx',
    text: 'invoice status = paid\nshow reference, total\nsort total desc',
    reason: "a query-language example in the lab's specimen",
  },
  { file: 'helpContent.js', text: 'column = "two words"', reason: 'a query-language example' },
  { file: 'components/ThemeLab.tsx', text: 'Northwind', reason: "the specimen database's name" },
  { file: 'components/ThemeLab.tsx', text: 'INV-1042', reason: "a specimen record's reference" },
  { file: 'components/ThemeLab.tsx', text: 'INV-1043', reason: "a specimen record's reference" },
  { file: 'components/ThemeLab.tsx', text: 'INV-1044', reason: "a specimen record's reference" },
];

/** Attributes whose string value is read by a person, or said by a screen reader. */
const COPY_ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'placeholder',
  'alt',
  'label',
  'summary',
]);
/** Attributes whose value is a name, a token or an address — never copy. */
const NAME_ATTRIBUTES =
  /^(?:className|class|id|key|role|type|name|href|src|srcSet|htmlFor|for|method|action|target|rel|lang|dir|inputMode|enterKeyHint|autoComplete|autoCapitalize|pattern|accept|form|tabIndex|value|defaultValue|mode|variant|kind|tone|size|align|side|placement|as|icon|glyph|testid|slot|part|style|d|viewBox|fill|stroke|xmlns|width|height|x|y|cx|cy|r|points|transform|path|to|at|field|column|table|connection|room|view|shape|format|layout|density|scope|state|status|intent|look|look\w*|emphasis|justify|gap|trigger|anchor|selector|sort|order|direction|dataKey|query|q|route|surface|domain|keyName|shortcut)$|^(?:data|aria)-(?!label$|description$|roledescription$|valuetext$|placeholder$)|^on[A-Z]|Class(?:Name)?$|Id$|Key$|Ref$|Href$|Url$|Icon$|Name$|Type$|Mode$|Kind$|Variant$/;

/** Calls whose string arguments are names, patterns or addresses, never copy. */
const NAME_CALLS = new Set([
  'querySelector',
  'querySelectorAll',
  'closest',
  'matches',
  'getElementById',
  'getElementsByClassName',
  'getAttribute',
  'hasAttribute',
  'removeAttribute',
  'toggleAttribute',
  'addEventListener',
  'removeEventListener',
  'createElement',
  'createElementNS',
  'createTextNodeNS',
  'add',
  'remove',
  'toggle',
  'contains',
  'replace',
  'replaceAll',
  'has',
  'get',
  'set',
  'delete',
  'append',
  'getItem',
  'setItem',
  'removeItem',
  'fetch',
  'matchMedia',
  'getPropertyValue',
  'setProperty',
  'removeProperty',
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'split',
  'join',
  'match',
  'matchAll',
  'test',
  'search',
  'padStart',
  'padEnd',
  'require',
  'Symbol',
  'for',
  'log',
  'warn',
  'error',
  'info',
  'debug',
  'trace',
  'assert',
  'time',
  'timeEnd',
  'postMessage',
  'CustomEvent',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'RegExp',
  'URL',
  'URLSearchParams',
  'Intl',
  'DateTimeFormat',
  'NumberFormat',
  'PluralRules',
  'RelativeTimeFormat',
  'ListFormat',
  'Collator',
  'DisplayNames',
  'Segmenter',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'localeCompare',
  'supports',
  'escape',
  'animate',
  'useQuery',
  'useMutation',
  'invalidateQueries',
  'setQueryData',
  'getQueryData',
  'cancelQueries',
  'removeQueries',
  'createContext',
  'displayName',
  'setAttributeNS',
  'scrollIntoView',
  'focus',
  'execCommand',
  'getContext',
  'go',
  'track',
  'mark',
  'measure',
  'emit',
  'on',
  'off',
  'once',
  'dispatch',
  'send',
  'navigate',
  'pushState',
  'replaceState',
  'open',
  'Worker',
  'BroadcastChannel',
  'lazy',
  'onDemand',
  'splitQuery',
  'parseQuery',
  'compile',
  'defineProperty',
  'hasOwn',
  'hasOwnProperty',
  'keyFor',
]);
/** `setAttribute(name, value)`: the name is never copy, the value may be. */
const FIRST_ARGUMENT_IS_A_NAME = new Set(['setAttribute', 'setAttributeNS']);

/** Properties an assignment or an object literal gives a name, a class or a style, never copy. */
const NAME_PROPERTIES = NAME_ATTRIBUTES;

const KEY_NAMES = new Set([
  'Enter',
  'Escape',
  'Esc',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'Spacebar',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'Insert',
  'Unidentified',
  'Dead',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/**
 * The query language's own words, and SQL's. A phrase made only of them —
 * `= last 7 days`, `{} is not empty`, `count by {} sort count desc`,
 * `GROUP BY` — is a statement the parser reads, not copy, and is never
 * translated.
 */
const QUERY_WORDS = new Set(
  (
    'is not empty in between and or this last next previous week weeks month months quarter quarters year years day days ' +
    'hours today yesterday tomorrow order by sort count desc asc show select where filter limit contains startswith endswith ' +
    'like true false null column value text sum avg min max'
  ).split(' '),
);
const PLACEHOLDERS = new Set(['column', 'value', 'text']);
function statement(s) {
  if (/^[A-Z]+(?: [A-Z]+)+$/.test(s)) return true;
  const words = (s.replace(/\{\}/g, ' ').match(/[A-Za-z]+/g) ?? []).filter((w) => w.length > 1);
  /* `column`, `value` and `text` are the grammar's placeholders: a statement with a hole needs a word of its own. */
  const own = words.filter((w) => !PLACEHOLDERS.has(w));
  return (
    words.length > 0 &&
    words.every((w) => QUERY_WORDS.has(w)) &&
    (words.length > 1 || /[=<>(]|\{\}/.test(s)) &&
    (!/\{\}/.test(s) || own.length > 0)
  );
}

/** Does a string, outside JSX text, read as something a person is told? */
function prose(text) {
  const raw = text.trim(); // a template's holes are `{}`
  if (statement(raw)) return false;
  if (!/\s/.test(raw.replace(/\{\}/g, '')) && /^[\w.{}=:?&#/%-]+$/.test(raw) && !/^[A-Z][a-z]+$/.test(raw)) return false; // a key, a parameter, a file
  if (/^[\w{}-]*\.(?:csv|json|sql|svg|png|txt|md|html|pdf|dbml|mmd)$/.test(raw)) return false; // a file name
  const s = raw.replace(/\{\}/g, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  /* A word beside a hole is a phrase however short: `{} in {}`, `issues {}`. */
  if (
    /\{\}/.test(raw) &&
    /(?:^|\{\}|\s)(?:[a-z]{2,}|e\.g\.)(?:\s|$)/.test(raw.replace(/\{\}/g, ' {} ')) &&
    /\s/.test(raw) &&
    !/^[\w{}/.-]*$/.test(raw) &&
    !/[=<>]/.test(raw)
  )
    return true;
  if ([...s].some((c) => c.charCodeAt(0) < 9)) return false; // a marker, not text
  if (/^[a-z]+\(/.test(raw)) return false; // a CSS function
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) return false; // a URL
  if (
    /^(?:\/|\.\.?\/|https?:|mailto:|tel:|data:|blob:|#|\?|&|@|~\/|\$|--|var\(|url\(|calc\(|rgba?\(|hsla?\(|oklch\(|color-mix\()/.test(raw)
  )
    return false;
  if (/^[.#[:*>]/.test(raw) || /\[[a-z-]+(?:[~|^$*]?=[^\]]*)?\]/.test(raw)) return false;
  if (/^[a-z][\w.:/-]*$/.test(s)) return false; // a name, a key, a class, a path
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return false; // a constant
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(s)) return false; // camelCase
  if (/^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(s)) return false; // PascalCase: a component, an error's name
  if (/^[\w-]+(?:\s+[\w-]+)*$/.test(s) && /^[a-z]/.test(s) && /(?:^|\s)[\w]+-[\w-]+(?:\s|$)/.test(s)) return false; // a class list
  if (/^[\d\s.,:;%()+\-/*a-z]*$/.test(s) && /\d/.test(s) && !/\s[a-z]{3,}/.test(s)) return false; // a number with a unit
  if (/^\w+(?:\.\w+)+$/.test(s)) return false; // a dotted key
  if (/^[\w-]+=/.test(s) || /^[\w-]+:\s*\S+;?$/.test(s)) return false; // a parameter, a declaration
  if (/^(?:[\w-]+\s*,\s*)+[\w-]+$/.test(s) && !/\s[a-z]+\s/.test(s)) return false; // a list of names
  if (/^<\/?[a-z]/.test(raw)) return false; // markup
  if (KEY_NAMES.has(s)) return false;
  if (/^[A-Z][a-z]+$/.test(s)) return true; // a word, capitalized: a label
  return /[A-Za-z]{2,}[\s'’,.:;!?…]/.test(s) || /[\s'’,:;!?…][A-Za-z]{2,}/.test(s);
}

const nameOf = (node) =>
  node && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Why a string literal at `node` is not copy, or undefined when it may be. */
function structural(node) {
  let child = node;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression?.(parent) ||
      (ts.isConditionalExpression(parent) && child !== parent.condition) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.PlusToken ||
          (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === parent.right))) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return 'top';
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isImportTypeNode?.(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isModuleDeclaration(parent)
  )
    return 'module';
  if (ts.isLiteralTypeNode(parent) || ts.isTypeNode(parent)) return 'type';
  if (ts.isExpressionStatement(parent)) return 'directive';
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) return 'key';
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      isPropertySignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === child
  )
    return 'key';
  if (ts.isComputedPropertyName(parent)) return 'key';
  if (ts.isCaseClause(parent)) return 'case';
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.InKeyword,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.GreaterThanToken,
      ].includes(op)
    )
      return 'comparison';
    if (op === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(parent.left) && NAME_PROPERTIES.test(parent.left.name.text))
      return 'name';
    if (
      op === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(parent.left) &&
      /^(?:cssText|innerHTML|value|hash|href|search|pathname|cursor|display|width|height|transform|transition|opacity|background|color)$/.test(
        parent.left.name.text,
      )
    )
      return 'name';
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
    const key = nameOf(parent.name);
    const call = parent.parent.parent;
    const hole = call && ts.isCallExpression(call) && /^(?:say|sayCopy|message)$/.test(calleeName(call) ?? '');
    if (key && !hole && NAME_PROPERTIES.test(key)) return 'name';
  }
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    /(?:^(?:class|selector|key|id|url|href|path|type|kind|mode|name|icon|sql|query|pattern|format|style)|[a-z0-9](?:Class|Selector|Key|Id|Url|Href|Path|Type|Kind|Mode|Name|Icon|Sql|Query|Pattern|Format|Style)|_(?:CLASS|SELECTOR|KEY|ID|URL|HREF|PATH|TYPE|KIND|MODE|NAME|ICON|SQL|QUERY|PATTERN|FORMAT|STYLE)|^(?:CLASS|SELECTOR|KEY|ID|URL|HREF|PATH|TYPE|KIND|MODE|NAME|ICON|SQL|QUERY|PATTERN|FORMAT|STYLE))$/.test(
      parent.name.text,
    ) &&
    !/(?:label|title|text|message|hint|copy|placeholder)$/i.test(parent.name.text)
  )
    return 'name';
  if (isParameter(parent) || ts.isBindingElement(parent)) {
    const key = nameOf(parent.name) ?? nameOf(parent.propertyName);
    if (key && NAME_PROPERTIES.test(key)) return 'name';
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== child) {
    const callee = ts.isCallExpression(parent)
      ? calleeName(parent)
      : (nameOf(parent.expression) ?? (ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : undefined));
    if (callee && NAME_CALLS.has(callee)) return 'call';
    if (callee && FIRST_ARGUMENT_IS_A_NAME.has(callee) && parent.arguments?.[0] === child) return 'call';
    if (callee === 'message' || callee === 'say' || callee === 'sayCopy') return 'catalog';
    if (
      ts.isPropertyAccessExpression(parent.expression) &&
      ts.isIdentifier(parent.expression.expression) &&
      /^(?:console|classList|dataset|style|JSON|Object|Reflect|Math|localStorage|sessionStorage|history|document|navigator|location|performance)$/.test(
        parent.expression.expression.text,
      )
    )
      return 'call';
  }
  if (ts.isTaggedTemplateExpression(parent)) return 'tagged';
  if (ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent))) {
    const attribute = ts.isJsxAttribute(parent) ? parent : parent.parent;
    const name = attribute.name.getText();
    if (!COPY_ATTRIBUTES.has(name) && NAME_ATTRIBUTES.test(name)) return 'name';
  }
  // A class attribute's expression, however deep: clsx(), a template, a conditional.
  for (let up = parent; up; up = up.parent) {
    if (ts.isJsxAttribute(up)) {
      const name = up.name.getText();
      if (!COPY_ATTRIBUTES.has(name) && NAME_ATTRIBUTES.test(name)) return 'name';
      break;
    }
    if (isFunctionLike(up) || ts.isBlock(up)) break;
  }
  return undefined;
}

/** JSX text as it is drawn: lines trimmed, joined by one space, entities read. */
function jsxText(raw) {
  const lines = raw.split(/\r?\n/);
  const kept = lines
    .map((line, i) => {
      let s = line;
      if (i > 0) s = s.replace(/^\s+/, '');
      if (i < lines.length - 1) s = s.replace(/\s+$/, '');
      return s;
    })
    .filter((s, i, all) => s !== '' || all.length === 1);
  return kept
    .join(' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&times;/g, '×')
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→')
    .replace(/&larr;/g, '←')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * A lowercase word chosen by a condition and said in a sentence —
 * `${n === 1 ? 'record' : 'records'}`, `{ what: saving ? 'save' : 'deletion' }` —
 * is copy however short: the sentence around it is.
 */
function chosenWord(node) {
  if (!ts.isStringLiteral(node) || !/^[a-z]{2,}(?: [a-z]+)*$/.test(node.text) || statement(node.text)) return false;
  let up = node.parent;
  if (!ts.isConditionalExpression(up) || up.condition === node) return false;
  while (ts.isConditionalExpression(up.parent) || ts.isParenthesizedExpression(up.parent)) up = up.parent;
  const at = up.parent;
  if (ts.isTemplateSpan(at) || (ts.isJsxExpression(at) && !ts.isJsxAttribute(at.parent))) return true;
  if (ts.isPropertyAssignment(at)) {
    const call = at.parent.parent;
    return call && ts.isCallExpression(call) && /^(?:say|sayCopy|message)$/.test(calleeName(call) ?? '');
  }
  return false;
}

/** A template literal's words with each hole as `{}`. */
function templateText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join('');
}

function findings(sf) {
  const found = [];
  const add = (node, text, how) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ line: line + 1, start: node.getStart(sf), end: node.getEnd(), text, how });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = jsxText(node.getText(sf)).trim();
      if (/[A-Za-z]/.test(text)) add(node, text, 'jsx');
      return;
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      const text = node.initializer.text;
      if (COPY_ATTRIBUTES.has(name) ? /[A-Za-z]/.test(text) && !statement(text) : !NAME_ATTRIBUTES.test(name) && prose(text))
        add(node.initializer, text, 'attribute');
      return;
    }
    /* A noun's forms for a count (`{ one: 'row', other: 'rows' }`) are copy however short. */
    if (
      ts.isStringLiteral(node) &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.initializer === node &&
      /^(?:one|other|many)$/.test(nameOf(node.parent.name) ?? '') &&
      /[A-Za-z]{2,}/.test(node.text)
    ) {
      add(node, node.text, 'plural');
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isStringLiteral(node) ? node.text : templateText(node);
      if ((prose(text) || chosenWord(node)) && !structural(node)) add(node, text, ts.isTemplateExpression(node) ? 'template' : 'string');
      if (ts.isTemplateExpression(node)) node.forEachChild(visit);
      return;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** The allowlist entry that excuses `text` in `rel` (a path from the repository root). */
const allowedFor = (rel, text) => ALLOWED.find((a) => (a.file === '*' || `src/client/${a.file}` === rel) && a.text === text);

/* Every client module of every package. Each is read as the one tree spelled it (`src/client/components/Grid.tsx`),
   because a module's copy table is beside it by that path whichever package holds the two. */
const CLIENT = treeFiles('src/client').filter(
  ({ rel }) => /\.(?:[jt]sx?)$/.test(rel) && !/\.(?:test|stories|spec)\.[jt]sx?$/.test(rel) && !rel.endsWith('.d.ts'),
);
const real = new Map(CLIENT.map(({ path, rel }) => [`src/client/${rel}`, path]));
function clientFiles() {
  return CLIENT.map(({ path }) => path);
}

/* One compiler process parses every client module together; the checks below read its trees. */
const TREES = parseFiles(clientFiles());
const named = new Map(CLIENT.map(({ path, rel }) => [path, `src/client/${rel}`]));
const json = process.argv.includes('--json');
const all = [];
const failures = [];
const used = new Set();
for (const path of clientFiles()) {
  const rel = named.get(path);
  if (CATALOG.some((re) => re.test(rel))) continue;
  for (const f of findings(TREES.get(path))) {
    const allowed = allowedFor(rel, f.text);
    if (allowed) {
      used.add(allowed);
      continue;
    }
    all.push({ file: rel, ...f });
    failures.push(`${rel}:${f.line}: ${JSON.stringify(f.text)}`);
  }
}
for (const entry of ALLOWED)
  if (!used.has(entry)) failures.push(`allowlist entry no longer needed: ${entry.file} ${JSON.stringify(entry.text)}`);
/* And the other way: a key nothing says any more is a stale entry too. A key
   is said where a table's speaker, or messages.ts's `message`, is called
   with it — as a string, or a condition between strings, the only ways the
   build's short keys (vite.config.ts) accept. */
function keysSaid(sf) {
  const speakers = new Set();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    const from = statement.moduleSpecifier.text;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if ((imported === 'say' && /\/copy\//.test(from)) || (imported === 'message' && from.endsWith('/messages.js')))
        speakers.add(element.name.text);
    }
  }
  const keys = new Set();
  const key = (node) => {
    if (ts.isConditionalExpression(node)) {
      key(node.whenTrue);
      key(node.whenFalse);
    } else if (ts.isStringLiteral(node)) keys.add(node.text);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && speakers.has(node.expression.text) && node.arguments[0])
      key(node.arguments[0]);
    node.forEachChild(visit);
  };
  visit(sf);
  return keys;
}
const sources = clientFiles().map((path) => [named.get(path), readFileSync(path, 'utf8')]);
const saying = new Map(
  sources.filter(([rel]) => !CATALOG.some((re) => re.test(rel))).map(([rel]) => [rel, keysSaid(TREES.get(real.get(rel)))]),
);
const anywhere = new Set([...saying.values()].flatMap((keys) => [...keys]));
for (const [rel, text] of sources.filter(([rel]) => CATALOG.some((re) => re.test(rel)))) {
  /* A module's table is said by that module alone: copy/lists/components/Grid.ts by components/Grid.tsx. */
  const mirror = /^src\/client\/copy\/\w+\/(.+)\.ts$/.exec(rel)?.[1];
  const owner = mirror && [...saying.keys()].find((other) => other.replace(/\.[jt]sx?$/, '') === `src/client/${mirror}`);
  if (mirror && !owner) {
    failures.push(`${rel}: no module src/client/${mirror} says this table; move it with its module or delete it`);
    continue;
  }
  /* Another language's shared words (copy/es.ts) say messages.ts's keys: theirs to be said, not its own. */
  if (/^src\/client\/copy\/[a-z]{2,3}\.ts$/.test(rel)) continue;
  /* The English: messages.ts's `en`, or a table's first object (its translations follow it). */
  /* Its keys are the lines at the first key's depth, read until that object closes; a plural's one/other sit deeper. */
  const english = rel.endsWith('messages.ts') ? text.slice(text.indexOf('  en: {') + 7) : text;
  const depth = /^( +)'?(?:common\.)?\w+'?: [{'"]/m.exec(english)?.[1].length ?? 2;
  const close = english.search(new RegExp(`^ {${depth - 2}}\\}`, 'm'));
  const table = close < 0 ? english : english.slice(0, close);
  for (const [, key] of table.matchAll(new RegExp(`^ {${depth}}'?((?:common\\.)?\\w+)'?: [{'"]`, 'gm'))) {
    if (!(owner ? saying.get(owner) : anywhere).has(key)) failures.push(`${rel}: ${key} is said nowhere`);
  }
}
if (json) {
  process.stdout.write(JSON.stringify(all, null, 1));
  process.exit(0);
}
if (failures.length) {
  console.error('✗ interface copy outside the catalog:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nSay it through the catalog: the module's own table, src/client/copy/<room>/<its path>.ts (or the " +
      'shared words in packages/kit/src/client/messages.ts), keyed by what it means. Text an App defines arrives in its payload ' +
      'and is never a literal. Something that reads as prose and is not copy goes in ALLOWED in ' +
      'test/check-client-copy.mjs, with its reason.',
  );
  process.exit(1);
}
console.log('✓ client copy: every word the platform says is in the catalog');
