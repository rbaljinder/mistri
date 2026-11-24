#!/usr/bin/env node
// Rewrites emitted packages/ui/dist/*.d.ts files (outside behaviors/index.d.ts) so they are
// 100% self-contained over `react` alone, with zero `@ui-sdk/*` module imports, zero inline `import("@ui-sdk/...")`
// type queries, and zero `any` / expanded RDFa `inlist` attribute dumps.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite';

const SCALAR_TYPES = {
  ISODate: 'string',
  DatePickerValue: 'ISODate | [ISODate, ISODate] | null',
  TreeCheckStrategy: "'leaf' | 'trunk' | 'branch' | 'independent'",
  SeparatorOrientation: "'horizontal' | 'vertical'",
  HourCycle: '12 | 24',
  TimeInputGranularity: "'hour' | 'minute' | 'second'",
  DrawerSide: "'left' | 'right' | 'top' | 'bottom'",
  SdkDrawerSide: "'left' | 'right' | 'top' | 'bottom'",
  ToastType: "'info' | 'success' | 'warning' | 'error' | 'loading' | (string & {})",
};

const KNOWN_SDK_TYPES = {
  ToastRegionProps:
    "{ side?: 'top' | 'bottom'; align?: 'start' | 'center' | 'end'; maxVisible?: number; className?: string; style?: import('react').CSSProperties; children?: import('react').ReactNode }",
  ToastData:
    "type ToastData<T = import('react').ReactNode> = { title?: T; description?: T; type?: ToastType; action?: { label: T; onClick: () => void }; duration?: number; [key: string]: unknown };",
  ToastItem:
    "type ToastItem<T = import('react').ReactNode> = { id: string; data: ToastData<T>; type?: ToastType; createdAt?: number; [key: string]: unknown };",
  ToastOptions:
    "type ToastOptions<T = import('react').ReactNode> = { id?: string; type?: ToastType; duration?: number; data?: ToastData<T>; [key: string]: unknown };",
  SdkListboxProps:
    "type SdkListboxProps<T = string, Multiple extends boolean | undefined = false> = { value?: Multiple extends true ? T[] : T | null; defaultValue?: Multiple extends true ? T[] : T | null; onValueChange?: (value: Multiple extends true ? T[] : T, details: __UiChangeDetails) => void; multiple?: Multiple; orientation?: 'vertical' | 'horizontal'; loop?: boolean; disabled?: boolean; name?: string; ariaLabel?: string; className?: string; style?: import('react').CSSProperties; children?: import('react').ReactNode; items?: ReadonlyArray<unknown> };",
  SdkComboboxProps:
    "type SdkComboboxProps<T = string, Multiple extends boolean | undefined = false> = { value?: Multiple extends true ? T[] : T | null; defaultValue?: Multiple extends true ? T[] : T | null; onValueChange?: (value: Multiple extends true ? T[] : T | null, details: __UiChangeDetails) => void; inputValue?: string; defaultInputValue?: string; onInputValueChange?: (value: string, details: __UiChangeDetails) => void; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean, details: __UiChangeDetails) => void; multiple?: Multiple; disabled?: boolean; readOnly?: boolean; required?: boolean; name?: string; ariaLabel?: string; className?: string; style?: import('react').CSSProperties; children?: import('react').ReactNode; items?: ReadonlyArray<unknown> };",
  SdkAutocompleteProps:
    "type SdkAutocompleteProps = { value?: string; defaultValue?: string; onValueChange?: (value: string, details: __UiChangeDetails) => void; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean, details: __UiChangeDetails) => void; disabled?: boolean; readOnly?: boolean; required?: boolean; name?: string; ariaLabel?: string; className?: string; style?: import('react').CSSProperties; children?: import('react').ReactNode; items?: ReadonlyArray<unknown> };",
};

const REF_ELEMENT_TAG = {
  HTMLAnchorElement: 'a',
  HTMLButtonElement: 'button',
  HTMLCanvasElement: 'canvas',
  HTMLDivElement: 'div',
  HTMLFormElement: 'form',
  HTMLHeadingElement: 'h2',
  HTMLImageElement: 'img',
  HTMLInputElement: 'input',
  HTMLLabelElement: 'label',
  HTMLLIElement: 'li',
  HTMLOListElement: 'ol',
  HTMLParagraphElement: 'p',
  HTMLSelectElement: 'select',
  HTMLSpanElement: 'span',
  HTMLTableCellElement: 'td',
  HTMLTableElement: 'table',
  HTMLTableRowElement: 'tr',
  HTMLTextAreaElement: 'textarea',
  HTMLUListElement: 'ul',
};

function inferTag(name) {
  if (/(Trigger|Close|Clear|Next|Previous|Action|Cancel|Thumb|Handle|Decrement|Increment|SelectAll|ChipRemove)$/.test(name)) {
    return 'button';
  }
  if (name.endsWith('Input')) return 'input';
  if (name.endsWith('Label')) return 'label';
  if (name.endsWith('Title') || name.endsWith('Heading')) return 'h2';
  if (name.endsWith('Description')) return 'p';
  if (/(Indicator|Text|Value|Badge|Icon|Overflow|Ellipsis)$/.test(name)) return 'span';
  return 'div';
}

function propKeyName(member) {
  if (!member || member.type !== 'TSPropertySignature' || !member.key) return '';
  if (member.key.type === 'Identifier') return member.key.name;
  if (member.key.type === 'Literal') return String(member.key.value);
  return '';
}

function isExpandedHtmlAttributes(node) {
  if (!node || node.type !== 'TSTypeLiteral' || !Array.isArray(node.members) || node.members.length < 40) return false;
  let hasInlist = false;
  let hasMediaAttr = false;
  for (const m of node.members) {
    const k = propKeyName(m);
    if (k === 'inlist') hasInlist = true;
    else if (k === 'onCanPlayThrough' || k === 'suppressHydrationWarning') hasMediaAttr = true;
    if (hasInlist && hasMediaAttr) return true;
  }
  return false;
}

function inferTagFromExpandedLiteral(node, sourceText) {
  for (const m of node.members ?? []) {
    if (propKeyName(m) === 'ref') {
      const slice = sourceText.slice(m.start, m.end);
      for (const [elType, tag] of Object.entries(REF_ELEMENT_TAG)) {
        if (slice.includes(elType)) return tag;
      }
    }
  }
  return 'div';
}

function qualifierRightmostName(q) {
  if (!q) return '';
  if (q.type === 'Identifier') return q.name;
  if (q.type === 'TSQualifiedName') return qualifierRightmostName(q.right);
  return '';
}

function isSdkModule(spec) {
  return (
    typeof spec === 'string' &&
    (spec === '@ui-sdk/core' || spec.startsWith('@ui-sdk/core/') || spec === '@ui-sdk/react' || spec.startsWith('@ui-sdk/react/'))
  );
}

function walkDtsFiles(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDtsFiles(full, root));
    else if (entry.name.endsWith('.d.ts') && relative(root, full).replace(/\\/g, '/') !== 'behaviors/index.d.ts') out.push(full);
  }
  return out;
}

export function sanitizeUiDistDts(uiDistDir) {
  const files = walkDtsFiles(uiDistDir);

  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8');
    if (!sourceText.includes('@ui-sdk/') && !sourceText.includes('inlist?:')) continue;

    const parsed = parseSync(file, sourceText);
    if (parsed.errors.length > 0) {
      throw new Error(`self-contained-ui-dts: failed to parse ${file}: ${parsed.errors[0].message}`);
    }

    /** @type {Array<{ local: string; imported: string; typeOnly: boolean }>} */
    const removedImports = [];
    /** @type {Array<{ exported: string; typeOnly: boolean }>} */
    const reexportedFromSdk = [];
    let usedSlotHelpers = false;

    const renderSpan = (start, end, rootNode) => {
      /** @type {Array<{ start: number; end: number; render: () => string }>} */
      const topReplacements = [];
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.start < start || node.end > end) return;
        if (node.type === 'TSImportType' && isSdkModule(node.source?.value)) {
          topReplacements.push({ start: node.start, end: node.end, render: () => renderSdkImportType(node) });
          return;
        }
        if (isExpandedHtmlAttributes(node)) {
          usedSlotHelpers = true;
          const tag = inferTagFromExpandedLiteral(node, sourceText);
          topReplacements.push({ start: node.start, end: node.end, render: () => `__UiSlotProps<"${tag}">` });
          return;
        }
        for (const key of Object.keys(node)) {
          if (key === 'start' || key === 'end' || key === 'type') continue;
          const val = node[key];
          if (Array.isArray(val)) {
            for (const item of val) collect(item);
          } else if (val && typeof val === 'object') {
            collect(val);
          }
        }
      };
      collect(rootNode);
      if (!topReplacements.length) return sourceText.slice(start, end);

      topReplacements.sort((a, b) => a.start - b.start);
      let out = '';
      let cursor = start;
      for (const rep of topReplacements) {
        out += sourceText.slice(cursor, rep.start);
        out += rep.render();
        cursor = rep.end;
      }
      out += sourceText.slice(cursor, end);
      return out;
    };

    const renderSdkImportType = (node) => {
      usedSlotHelpers = true;
      const name = qualifierRightmostName(node.qualifier);
      const params = node.typeArguments?.params ?? [];
      const args = params.map((p) => renderSpan(p.start, p.end, p));
      if ((name === 'PartComponent' || name === 'GenericPartComponent') && args[2]) {
        return `__UiSlotPart<${args[2]}>`;
      }
      if (name === 'PartProps') {
        return args.length ? `__UiSlotProps<${args.slice(0, 2).join(', ')}>` : '__UiSlotProps';
      }
      if (name === 'RenderProp') {
        return args.length ? `__UiRenderProp<${args[0]}>` : '__UiRenderProp';
      }
      if (name === 'ChangeDetails') {
        return args.length ? `__UiChangeDetails<${args[0]}>` : '__UiChangeDetails';
      }
      return '__UiBag';
    };

    /** @type {Array<{ start: number; end: number; text: string }>} */
    const edits = [];
    for (const stmt of parsed.program.body) {
      if (stmt.type === 'ImportDeclaration' && isSdkModule(stmt.source?.value)) {
        const declTypeOnly = stmt.importKind === 'type';
        for (const spec of stmt.specifiers ?? []) {
          if (spec.type === 'ImportDefaultSpecifier') {
            removedImports.push({ local: spec.local.name, imported: 'default', typeOnly: declTypeOnly });
          } else if (spec.type === 'ImportSpecifier') {
            const importedName = spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value);
            removedImports.push({
              local: spec.local.name,
              imported: importedName,
              typeOnly: declTypeOnly || spec.importKind === 'type',
            });
          }
        }
        let end = stmt.end;
        if (sourceText[end] === '\r') end++;
        if (sourceText[end] === '\n') end++;
        edits.push({ start: stmt.start, end, text: '' });
        continue;
      }

      if (stmt.type === 'ExportNamedDeclaration' && stmt.source && isSdkModule(stmt.source.value)) {
        const declTypeOnly = stmt.exportKind === 'type';
        for (const spec of stmt.specifiers ?? []) {
          const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value);
          reexportedFromSdk.push({
            exported: exportedName,
            typeOnly: declTypeOnly || spec.exportKind === 'type',
          });
        }
        let end = stmt.end;
        if (sourceText[end] === '\r') end++;
        if (sourceText[end] === '\n') end++;
        edits.push({ start: stmt.start, end, text: '' });
        continue;
      }

      const rendered = renderSpan(stmt.start, stmt.end, stmt);
      if (rendered !== sourceText.slice(stmt.start, stmt.end)) {
        edits.push({ start: stmt.start, end: stmt.end, text: rendered });
      }
    }

    if (!edits.length && !removedImports.length && !reexportedFromSdk.length && !usedSlotHelpers) continue;

    edits.sort((a, b) => a.start - b.start);
    let bodyOut = '';
    let pos = 0;
    for (const edit of edits) {
      bodyOut += sourceText.slice(pos, edit.start);
      bodyOut += edit.text;
      pos = edit.end;
    }
    bodyOut += sourceText.slice(pos);

    const stubs = [
      'type __UiBag = Record<string, unknown>;',
      'type __UiChangeDetails<R = string> = { reason: R; source: string; event?: Event; cancel?: () => void; readonly canceled?: boolean; [key: string]: unknown };',
      'type __UiRenderProp<State = __UiBag> = import("react").ReactElement<Record<string, unknown>> | ((props: Record<string, unknown>, state: State) => import("react").ReactElement);',
      'type __UiSlotProps<Tag extends keyof import("react").JSX.IntrinsicElements = "div", State = __UiBag> = Omit<import("react").ComponentProps<Tag>, "className" | "style" | "children" | "onChange" | "aria-label" | "inlist"> & {',
      '  ariaLabel?: string;',
      '  className?: string | ((state: State) => string | undefined);',
      '  style?: import("react").CSSProperties | ((state: State) => import("react").CSSProperties | undefined);',
      '  render?: __UiRenderProp<State>;',
      '  children?: import("react").ReactNode | ((state: State) => import("react").ReactNode);',
      '  [key: string]: unknown;',
      '};',
      'type __UiSlotPart<Tag extends keyof import("react").JSX.IntrinsicElements = "div", State = __UiBag> = (props: __UiSlotProps<Tag, State>) => import("react").ReactElement | null;',
    ];

    const seen = new Set();
    const emitKnownOrStub = (local, imported, typeOnly) => {
      if (seen.has(local)) return;
      seen.add(local);
      if (local === 'ToastRegionProps' || local === 'ToastData' || local === 'ToastItem' || local === 'ToastOptions') {
        if (!seen.has('ToastType')) {
          seen.add('ToastType');
          stubs.push(`type ToastType = ${SCALAR_TYPES.ToastType};`);
        }
        if ((local === 'ToastItem' || local === 'ToastOptions') && !seen.has('ToastData')) {
          seen.add('ToastData');
          stubs.push(KNOWN_SDK_TYPES.ToastData);
        }
      }
      const known = KNOWN_SDK_TYPES[local] ?? KNOWN_SDK_TYPES[imported];
      if (typeOnly && known) {
        stubs.push(known.startsWith('type ') ? known.replace(/^type \w+/, `type ${local}`) : `type ${local} = ${known};`);
        return;
      }
      const scalar = SCALAR_TYPES[local] ?? SCALAR_TYPES[imported];
      if (typeOnly) {
        if (scalar) stubs.push(`type ${local} = ${scalar};`);
        else stubs.push(`type ${local}<A = unknown, B = unknown, C = unknown> = __UiBag & { _a?: A; _b?: B; _c?: C };`);
      } else if (/^[A-Z]/.test(local)) {
        const tag = inferTag(local);
        stubs.push(`declare const ${local}: __UiSlotPart<"${tag}">;`);
      } else {
        stubs.push(`declare const ${local}: (...args: never[]) => unknown;`);
      }
    };

    for (const item of removedImports) {
      emitKnownOrStub(item.local, item.imported, item.typeOnly);
    }

    for (const item of reexportedFromSdk) {
      const scalar = SCALAR_TYPES[item.exported];
      if (item.typeOnly) {
        stubs.push(`export type ${item.exported}<A = unknown, B = unknown> = ${scalar ?? '__UiBag & { _a?: A; _b?: B }'};`);
      } else if (/^[A-Z]/.test(item.exported)) {
        stubs.push(`export declare const ${item.exported}: __UiSlotPart<"${inferTag(item.exported)}">;`);
      } else {
        stubs.push(`export declare const ${item.exported}: (...args: never[]) => unknown;`);
      }
    }

    writeFileSync(file, `${stubs.join('\n')}\n${bodyOut}`);
  }

  /* Verify zero parse errors and zero @ui-sdk import declarations or import-type nodes survive in published UI declarations. */
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const reparsed = parseSync(file, text);
    if (reparsed.errors.length > 0) {
      throw new Error(`self-contained-ui-dts: syntax error in rewritten ${file}: ${reparsed.errors[0].message}`);
    }
    const check = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ImportDeclaration' && isSdkModule(node.source?.value)) {
        throw new Error(`self-contained-ui-dts: @ui-sdk import remained in ${file}`);
      }
      if (node.type === 'ExportNamedDeclaration' && node.source && isSdkModule(node.source.value)) {
        throw new Error(`self-contained-ui-dts: @ui-sdk re-export remained in ${file}`);
      }
      if (node.type === 'TSImportType' && isSdkModule(node.source?.value)) {
        throw new Error(`self-contained-ui-dts: inline import("@ui-sdk/...") remained in ${file}`);
      }
      for (const key of Object.keys(node)) {
        if (key === 'start' || key === 'end' || key === 'type') continue;
        const val = node[key];
        if (Array.isArray(val)) {
          for (const item of val) check(item);
        } else if (val && typeof val === 'object') {
          check(val);
        }
      }
    };
    check(reparsed.program);
  }
}
