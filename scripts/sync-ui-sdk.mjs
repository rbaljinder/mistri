#!/usr/bin/env node
/**
 * Syncs and verifies `@mistriwork/mistri/{primitives,charts,views}` runtime export lists
 * (`packages/mistri/src/shared/uiSdk.ts`) and self-contained declaration barrels
 * (`packages/mistri/schema/{primitives,charts,views}.d.ts`) from `packages/ui/src/{primitives,charts,views}.ts`.
 *
 * Every generated `schema/{primitives,charts,views}.d.ts` file is 100% self-contained over `react`,
 * `./behaviors.js`, and `./primitives.js` (zero `@mistriwork/ui` checkout `.tsx` imports), so `schema/ui.d.ts`
 * and `schema/page.d.ts` can re-export shared primitives, charts, and views directly without triggering TS6142.
 *
 *   node scripts/sync-ui-sdk.mjs --write   update schema/*.d.ts and uiSdk.ts
 *   node scripts/sync-ui-sdk.mjs --check   verify they match source exports
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { parseSync } from 'vite';
import { sanitizeUiDistDts } from './self-contained-ui-dts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const write = (p, s) => writeFileSync(join(ROOT, p), s);

const BARRELS = [
  {
    key: 'primitives',
    src: 'packages/ui/src/primitives.ts',
    dir: 'primitives',
    schema: 'packages/mistri/schema/primitives.d.ts',
    constName: 'PRIMITIVES_EXPORTS',
  },
  {
    key: 'charts',
    src: 'packages/ui/src/charts.ts',
    dir: 'charts',
    schema: 'packages/mistri/schema/charts.d.ts',
    constName: 'CHARTS_EXPORTS',
  },
  {
    key: 'views',
    src: 'packages/ui/src/views.ts',
    dir: 'views',
    schema: 'packages/mistri/schema/views.d.ts',
    constName: 'VIEWS_EXPORTS',
  },
];

function shouldInlineRel(barrel, relDts) {
  if (relDts.startsWith(`${barrel.dir}/`)) return true;
  if (barrel.key === 'primitives') {
    if (relDts === 'internal/HelpTip.d.ts') return true;
    if (!relDts.includes('/') && relDts.endsWith('.d.ts')) {
      return relDts !== 'primitives.d.ts' && relDts !== 'charts.d.ts' && relDts !== 'views.d.ts' && relDts !== 'index.d.ts';
    }
  }
  return false;
}

function buildSelfContainedBarrelDts(dtsRoot, barrel) {
  const entryFile = join(dtsRoot, `${barrel.key}.d.ts`);
  const entryText = readFileSync(entryFile, 'utf8');
  const entryAst = parseSync(entryFile, entryText);

  const subfiles = [];
  for (const stmt of entryAst.program.body) {
    if ((stmt.type === 'ExportAllDeclaration' || stmt.type === 'ExportNamedDeclaration') && stmt.source?.value?.startsWith('./')) {
      const target = stmt.source.value.replace(/\.js$/, '.d.ts').replace(/^\.\//, '');
      if (shouldInlineRel(barrel, target)) {
        subfiles.push({ relPath: target, exportAll: stmt.type === 'ExportAllDeclaration' });
      }
    }
  }
  const exportAllSet = new Set(subfiles.filter((s) => s.exportAll).map((s) => s.relPath));

  const ordered = [];
  const visited = new Set();
  const visit = (relPath) => {
    if (visited.has(relPath)) return;
    visited.add(relPath);
    const full = join(dtsRoot, relPath);
    if (!existsSync(full)) return;
    const text = readFileSync(full, 'utf8');
    const ast = parseSync(full, text);
    for (const stmt of ast.program.body) {
      const spec = stmt.source?.value;
      if (typeof spec === 'string' && spec.startsWith('.')) {
        const depRel = posix.normalize(posix.join(posix.dirname(relPath), spec.replace(/\.js$/, '.d.ts')));
        if (shouldInlineRel(barrel, depRel)) visit(depRel);
      }
    }
    ordered.push({ relPath, exportedByBarrel: exportAllSet.has(relPath), text, ast });
  };
  for (const sub of subfiles) visit(sub.relPath);
  if (barrel.key === 'primitives') visit('UiKit.d.ts');

  /** @type {Map<string, { ns?: string; defaultName?: string; named: Set<string>; typeNamed: Set<string> }>} */
  const externalImports = new Map();
  const ensureExt = (mod) => {
    if (!externalImports.has(mod)) externalImports.set(mod, { named: new Set(), typeNamed: new Set() });
    return externalImports.get(mod);
  };

  let helperPreamble = '';
  const seenHelperTypes = new Set();
  const seenInternalDecls = new Set();
  let hasChangeDetailsDecl = false;
  const bodyChunks = [];

  const mapExternalSpec = (fromRel, spec) => {
    const resolved = posix.normalize(posix.join(posix.dirname(fromRel), spec));
    if (resolved === 'internal/cx.js') return '@internal/cx';
    if (resolved === 'internal/surfaceSeam.js') return '@internal/drop';
    if (resolved.startsWith('internal/')) return '@internal/drop';
    if (resolved === 'behaviors/index.js') return './behaviors.js';
    if (resolved === 'iconNames.js' || resolved === 'Icon.js') return './app.js';
    if (resolved.startsWith('primitives/')) return './primitives.js';
    if (!resolved.includes('/') && resolved.endsWith('.js')) {
      return barrel.key === 'primitives' ? '@internal/inlined' : './primitives.js';
    }
    return spec;
  };

  for (const mod of ordered) {
    /** @type {Array<{ start: number; end: number; text: string }>} */
    const edits = [];
    const src = mod.text;

    for (const stmt of mod.ast.program.body) {
      if (stmt.type === 'ImportDeclaration') {
        const rawSpec = stmt.source.value;
        const resolvedDts = rawSpec.startsWith('.')
          ? posix.normalize(posix.join(posix.dirname(mod.relPath), rawSpec.replace(/\.js$/, '.d.ts')))
          : '';
        let targetSpec =
          rawSpec === '@mistriwork/ui/behaviors/index.js'
            ? './behaviors.js'
            : resolvedDts && shouldInlineRel(barrel, resolvedDts)
              ? '@internal/inlined'
              : rawSpec.startsWith('.')
                ? mapExternalSpec(mod.relPath, rawSpec)
                : rawSpec;
        if (targetSpec !== '@internal/cx' && targetSpec !== '@internal/drop' && targetSpec !== '@internal/inlined') {
          const rec = ensureExt(targetSpec);
          const declType = stmt.importKind === 'type';
          for (const s of stmt.specifiers ?? []) {
            if (s.type === 'ImportNamespaceSpecifier') rec.ns = s.local.name;
            else if (s.type === 'ImportDefaultSpecifier') rec.defaultName = s.local.name;
            else if (s.type === 'ImportSpecifier') {
              const imp = s.imported.type === 'Identifier' ? s.imported.name : String(s.imported.value);
              const specStr = imp === s.local.name ? imp : `${imp} as ${s.local.name}`;
              if (declType || s.importKind === 'type') rec.typeNamed.add(specStr);
              else rec.named.add(specStr);
            }
          }
        }
        let end = stmt.end;
        if (src[end] === '\r') end++;
        if (src[end] === '\n') end++;
        edits.push({ start: stmt.start, end, text: '' });
        continue;
      }

      if (stmt.type === 'ExportNamedDeclaration' && stmt.source) {
        const rawSpec = stmt.source.value;
        const resolvedDts = rawSpec.startsWith('.')
          ? posix.normalize(posix.join(posix.dirname(mod.relPath), rawSpec.replace(/\.js$/, '.d.ts')))
          : '';
        if (resolvedDts && shouldInlineRel(barrel, resolvedDts)) {
          if (!mod.exportedByBarrel) {
            let end = stmt.end;
            if (src[end] === '\r') end++;
            if (src[end] === '\n') end++;
            edits.push({ start: stmt.start, end, text: '' });
          } else {
            const fromIdx = src.lastIndexOf('from', stmt.source.start);
            edits.push({ start: fromIdx, end: stmt.end, text: ';' });
          }
        } else if (rawSpec === '@mistriwork/ui/behaviors/index.js') {
          edits.push({ start: stmt.source.start, end: stmt.source.end, text: "'./behaviors.js'" });
        } else if (rawSpec.startsWith('.')) {
          const mapped = mapExternalSpec(mod.relPath, rawSpec);
          if (mapped === '@internal/cx' || mapped === '@internal/drop') {
            let end = stmt.end;
            if (src[end] === '\r') end++;
            if (src[end] === '\n') end++;
            edits.push({ start: stmt.start, end, text: '' });
          } else {
            edits.push({ start: stmt.source.start, end: stmt.source.end, text: `'${mapped}'` });
          }
        }
        continue;
      }

      if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        const decl = stmt.declaration;
        const declName =
          decl.id?.name ??
          (decl.type === 'VariableDeclaration' && decl.declarations?.[0]?.id?.type === 'Identifier'
            ? decl.declarations[0].id.name
            : undefined);
        if (declName === 'ChangeDetails') hasChangeDetailsDecl = true;
        if (!mod.exportedByBarrel) {
          if (declName && seenInternalDecls.has(declName)) {
            let end = stmt.end;
            if (src[end] === '\r') end++;
            if (src[end] === '\n') end++;
            edits.push({ start: stmt.start, end, text: '' });
            continue;
          }
          if (declName) seenInternalDecls.add(declName);
          edits.push({ start: stmt.start, end: stmt.declaration.start, text: '' });
        }
        continue;
      }

      if (
        (stmt.type === 'TSTypeAliasDeclaration' || stmt.type === 'TSInterfaceDeclaration' || stmt.type === 'FunctionDeclaration') &&
        stmt.id?.name
      ) {
        const name = stmt.id.name;
        if (name === 'ChangeDetails') hasChangeDetailsDecl = true;
        if (name.startsWith('__Ui')) {
          const fullDecl = src.slice(stmt.start, stmt.end) + '\n';
          if (!seenHelperTypes.has(name)) {
            seenHelperTypes.add(name);
            helperPreamble += fullDecl;
          }
          let end = stmt.end;
          if (src[end] === '\r') end++;
          if (src[end] === '\n') end++;
          edits.push({ start: stmt.start, end, text: '' });
          continue;
        }
        if (seenInternalDecls.has(name)) {
          let end = stmt.end;
          if (src[end] === '\r') end++;
          if (src[end] === '\n') end++;
          edits.push({ start: stmt.start, end, text: '' });
          continue;
        }
        seenInternalDecls.add(name);
      }

      if (stmt.type === 'VariableDeclaration') {
        const name = stmt.declarations?.[0]?.id?.type === 'Identifier' ? stmt.declarations[0].id.name : undefined;
        if (name) {
          if (seenInternalDecls.has(name)) {
            let end = stmt.end;
            if (src[end] === '\r') end++;
            if (src[end] === '\n') end++;
            edits.push({ start: stmt.start, end, text: '' });
            continue;
          }
          seenInternalDecls.add(name);
        }
      }

      if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration && !stmt.source && !mod.exportedByBarrel) {
        let end = stmt.end;
        if (src[end] === '\r') end++;
        if (src[end] === '\n') end++;
        edits.push({ start: stmt.start, end, text: '' });
      }
    }

    edits.sort((a, b) => b.start - a.start);
    let rewritten = src;
    for (const e of edits) rewritten = rewritten.slice(0, e.start) + e.text + rewritten.slice(e.end);

    bodyChunks.push(rewritten.trim());
  }

  if (barrel.key !== 'primitives') {
    const primRec = ensureExt('./primitives.js');
    primRec.typeNamed.add('Tone');
    primRec.typeNamed.add('ControlSize');
    primRec.typeNamed.add('EmptyStateSpec');
  }

  const reactExt = externalImports.get('react');
  const importLines = ["import * as React from 'react';"];
  if (reactExt) {
    const allReact = [...reactExt.named, ...reactExt.typeNamed].filter((n) => n !== 'default');
    if (allReact.length) importLines.push(`import type { ${[...new Set(allReact)].sort().join(', ')} } from 'react';`);
    externalImports.delete('react');
  }
  for (const [modName, spec] of [...externalImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = [];
    for (const n of [...spec.named].sort()) parts.push(n);
    for (const n of [...spec.typeNamed].filter((x) => !spec.named.has(x)).sort()) parts.push(`type ${n}`);
    if (spec.ns) importLines.push(`import type * as ${spec.ns} from '${modName}';`);
    if (parts.length) importLines.push(`import { ${parts.join(', ')} } from '${modName}';`);
  }

  const sharedTypes =
    barrel.key === 'primitives'
      ? [
          '/** Semantic tone shared across badges, status indicators, alerts, cards, and charts. */',
          "export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'critical' | 'accent';",
          'type StatusTone = Tone;',
          '/** Control size shared across buttons, fields, pickers, switches, and meters. */',
          "export type ControlSize = 'xs' | 'sm' | 'md' | 'lg';",
          '/** Structured empty-state content shared across lists, tables, pickers, and views. */',
          'export interface EmptyStateSpec {',
          '  title: React.ReactNode;',
          '  body?: React.ReactNode;',
          '  action?: React.ReactNode;',
          '}',
        ]
      : ['type StatusTone = Tone;', 'export type { ControlSize, EmptyStateSpec, Tone };'];

  return [
    `/** \`@mistriwork/mistri/${barrel.key}\`: generated self-contained declarations (\`scripts/sync-ui-sdk.mjs\`). @preview */`,
    ...importLines,
    '',
    ...sharedTypes,
    ...(helperPreamble ? ['', helperPreamble.trimEnd()] : []),
    '',
    ...bodyChunks.filter(Boolean),
    ...(barrel.key === 'primitives' && hasChangeDetailsDecl ? ['export type { ChangeDetails };'] : []),
    '',
  ].join('\n');
}

function collectKitRoots() {
  /** @type {Map<string, boolean>} */
  const roots = new Map();
  for (const rel of ['packages/mistri/schema/ui.d.ts', 'packages/mistri/schema/page.d.ts']) {
    const src = read(rel);
    const ast = parseSync(rel, src);
    for (const stmt of ast.program.body) {
      if ((stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ImportDeclaration') && stmt.source?.value === './kit.js') {
        const declType = stmt.exportKind === 'type' || stmt.importKind === 'type';
        for (const spec of stmt.specifiers ?? []) {
          const name =
            spec.type === 'ExportSpecifier'
              ? spec.local.type === 'Identifier'
                ? spec.local.name
                : String(spec.local.value)
              : spec.type === 'ImportSpecifier'
                ? spec.imported.type === 'Identifier'
                  ? spec.imported.name
                  : String(spec.imported.value)
                : '';
          if (!name) continue;
          const isType = declType || spec.exportKind === 'type' || spec.importKind === 'type';
          roots.set(name, (roots.get(name) ?? false) || !isType);
        }
      }
    }
  }
  return roots;
}

function splitKitFromBarrels(rawByKey) {
  const kitRoots = collectKitRoots();
  /** @type {Map<string, any>} */
  const declByName = new Map();
  /** @type {Record<string, any>} */
  const parsedBarrels = {};

  for (const b of BARRELS) {
    const key = b.key;
    const src = rawByKey[key];
    const ast = parseSync(b.schema, src);
    /** @type {Map<string, boolean>} */
    const exportedMap = new Map();
    /** @type {Map<string, { mod: string; imported: string; isType: boolean }>} */
    const extImports = new Map();
    /** @type {string[]} */
    const passthroughExports = [];
    /** @type {any[]} */
    const decls = [];

    for (const stmt of ast.program.body) {
      if (stmt.type === 'ImportDeclaration') {
        const mod = stmt.source.value;
        const declType = stmt.importKind === 'type';
        for (const sp of stmt.specifiers ?? []) {
          if (sp.type === 'ImportSpecifier') {
            const imp = sp.imported.type === 'Identifier' ? sp.imported.name : String(sp.imported.value);
            extImports.set(sp.local.name, { mod, imported: imp, isType: declType || sp.importKind === 'type' });
          }
        }
      } else if (stmt.type === 'ExportNamedDeclaration' && stmt.source) {
        passthroughExports.push(src.slice(stmt.start, stmt.end));
      } else if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration && !stmt.source) {
        const declType = stmt.exportKind === 'type';
        for (const sp of stmt.specifiers ?? []) {
          const isType = declType || sp.exportKind === 'type';
          exportedMap.set(sp.local.name, (exportedMap.get(sp.local.name) ?? false) || !isType);
        }
      } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        const d = stmt.declaration;
        const isValue = d.type === 'FunctionDeclaration' || d.type === 'TSDeclareFunction' || d.type === 'VariableDeclaration';
        const names = d.id?.name
          ? [d.id.name]
          : d.type === 'VariableDeclaration'
            ? d.declarations.map((x) => x.id?.name).filter(Boolean)
            : [];
        for (const n of names) exportedMap.set(n, (exportedMap.get(n) ?? false) || isValue);
      }
    }

    let prevEnd = 0;
    for (const stmt of ast.program.body) {
      const gap = src.slice(prevEnd, stmt.start);
      prevEnd = stmt.end;
      const d = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (!d || stmt.type === 'ImportDeclaration' || (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration)) continue;
      const names = d.id?.name
        ? [d.id.name]
        : d.type === 'VariableDeclaration'
          ? d.declarations.map((x) => x.id?.name).filter(Boolean)
          : [];
      if (!names.length) continue;
      if (names.length === 1 && names[0] === 'StatusTone') continue;

      const isValue = d.type === 'FunctionDeclaration' || d.type === 'TSDeclareFunction' || d.type === 'VariableDeclaration';
      const anyExported = names.some((n) => exportedMap.has(n) || kitRoots.has(n));
      if (isValue && !anyExported && !names.some((n) => new RegExp(`\\btypeof\\s+${n}\\b`).test(src))) {
        continue;
      }

      const docMatch = gap.match(/\/\*\*[\s\S]*?\*\/\s*$/);
      const doc = docMatch ? docMatch[0].trim() : '';
      let codeNoExport = src.slice(d.start, d.end);
      if (names.length === 1 && names[0] === 'CleanElementProps') {
        codeNoExport =
          "type CleanElementProps<T extends keyof React.JSX.IntrinsicElements, K extends PropertyKey = never> = Omit<React.ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist' | K> & { ariaLabel?: string };";
      } else {
        codeNoExport = codeNoExport.replace(/Omit<CleanElementProps<('[^']+')>,\s*([^>]+)>/g, 'CleanElementProps<$1, $2>');
      }
      const refs = new Set(codeNoExport.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
      const rec = { barrel: key, names, isValue, doc, codeNoExport, refs };
      decls.push(rec);
      for (const n of names) {
        if (!declByName.has(n)) declByName.set(n, rec);
      }
    }

    parsedBarrels[key] = { extImports, passthroughExports, exportedMap, decls };
  }

  for (const rootName of kitRoots.keys()) {
    if (!declByName.has(rootName)) {
      throw new Error(`sync-ui-sdk: kit root '${rootName}' not found in generated barrels`);
    }
  }

  const kitDeclNames = new Set(kitRoots.keys());
  const queue = [...kitDeclNames];
  while (queue.length) {
    const cur = queue.pop();
    const rec = declByName.get(cur);
    if (!rec) continue;
    for (const n of rec.names) {
      if (!kitDeclNames.has(n)) {
        kitDeclNames.add(n);
        queue.push(n);
      }
    }
    for (const r of rec.refs) {
      if (declByName.has(r) && !kitDeclNames.has(r)) {
        kitDeclNames.add(r);
        queue.push(r);
      }
    }
  }

  // Symbols in kit.d.ts that must carry `export` (roots + barrel public exports + cross-referenced internals)
  const kitExported = new Set(kitRoots.keys());
  for (const b of BARRELS) {
    const pb = parsedBarrels[b.key];
    for (const expName of pb.exportedMap.keys()) {
      if (kitDeclNames.has(expName)) kitExported.add(expName);
    }
    for (const rec of pb.decls) {
      if (rec.names.some((n) => kitDeclNames.has(n))) continue;
      for (const r of rec.refs) {
        if (kitDeclNames.has(r)) kitExported.add(r);
      }
    }
  }

  // Build kit.d.ts
  const kitDecls = [];
  const seenKitRec = new Set();
  for (const b of BARRELS) {
    for (const rec of parsedBarrels[b.key].decls) {
      if (rec.names.some((n) => kitDeclNames.has(n)) && !seenKitRec.has(rec)) {
        seenKitRec.add(rec);
        kitDecls.push(rec);
      }
    }
  }

  const kitUsedTokens = new Set();
  for (const rec of kitDecls) {
    for (const r of rec.refs) kitUsedTokens.add(r);
  }
  /** @type {Map<string, Map<string, boolean>>} */
  const kitExtByMod = new Map();
  for (const b of BARRELS) {
    for (const [local, info] of parsedBarrels[b.key].extImports) {
      if (info.mod === './primitives.js' || !kitUsedTokens.has(local)) continue;
      if (!kitExtByMod.has(info.mod)) kitExtByMod.set(info.mod, new Map());
      const m = kitExtByMod.get(info.mod);
      m.set(local, (m.get(local) ?? true) && info.isType);
    }
  }

  const kitHeader = ['/** `@mistriwork/mistri` shared kit declarations (`scripts/sync-ui-sdk.mjs`). */', "import * as React from 'react';"];
  const kitReactMap = kitExtByMod.get('react');
  if (kitReactMap?.size) {
    kitHeader.push(`import type { ${[...kitReactMap.keys()].sort().join(', ')} } from 'react';`);
    kitExtByMod.delete('react');
  }
  for (const [mod, specMap] of [...kitExtByMod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const specs = [...specMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, isType]) => (isType ? `type ${name}` : name));
    if (specs.length) kitHeader.push(`import { ${specs.join(', ')} } from '${mod}';`);
  }

  const kitBody = [];
  if (kitUsedTokens.has('StatusTone')) kitBody.push('type StatusTone = Tone;');
  for (const rec of kitDecls) {
    const shouldExport = rec.names.some((n) => kitExported.has(n));
    const declLine = shouldExport ? `export ${rec.codeNoExport}` : rec.codeNoExport;
    kitBody.push(rec.doc ? `${rec.doc}\n${declLine}` : declLine);
  }
  const kitDts = [...kitHeader, '', ...kitBody, ''].join('\n');

  // Rewrite each barrel without kitDeclNames
  /** @type {Record<string, string>} */
  const rewrittenBarrels = {};
  for (const b of BARRELS) {
    const pb = parsedBarrels[b.key];
    const remainingDecls = pb.decls.filter((rec) => !rec.names.some((n) => kitDeclNames.has(n)));
    const usedTokens = new Set();
    for (const rec of remainingDecls) {
      for (const r of rec.refs) usedTokens.add(r);
    }

    /** @type {Map<string, Map<string, boolean>>} */
    const extByMod = new Map();
    const addImport = (mod, name, isType) => {
      if (!extByMod.has(mod)) extByMod.set(mod, new Map());
      const m = extByMod.get(mod);
      m.set(name, (m.get(name) ?? true) && isType);
    };

    for (const [local, info] of pb.extImports) {
      if (!usedTokens.has(local)) continue;
      if (info.mod === './primitives.js' && kitDeclNames.has(local)) {
        addImport('./kit.js', local, info.isType);
      } else {
        addImport(info.mod, local, info.isType);
      }
    }

    for (const r of usedTokens) {
      if (r === 'StatusTone') {
        addImport('./kit.js', 'Tone', true);
      } else if (kitDeclNames.has(r)) {
        const target = declByName.get(r);
        addImport('./kit.js', r, target ? !target.isValue : true);
      }
    }

    const header = [
      `/** \`@mistriwork/mistri/${b.key}\`: generated self-contained declarations (\`scripts/sync-ui-sdk.mjs\`). @preview */`,
      "import * as React from 'react';",
    ];
    const reactMap = extByMod.get('react');
    if (reactMap?.size) {
      header.push(`import type { ${[...reactMap.keys()].sort().join(', ')} } from 'react';`);
      extByMod.delete('react');
    }
    for (const [mod, specMap] of [...extByMod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const specs = [...specMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, isType]) => (isType ? `type ${name}` : name));
      if (specs.length) header.push(`import { ${specs.join(', ')} } from '${mod}';`);
    }

    const kitReexports = [];
    for (const [expName, isValue] of [...pb.exportedMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (kitDeclNames.has(expName)) {
        kitReexports.push(isValue ? expName : `type ${expName}`);
      }
    }

    const body = [];
    if (usedTokens.has('StatusTone')) body.push('type StatusTone = Tone;');
    if (kitReexports.length) body.push(`export { ${kitReexports.join(', ')} } from './kit.js';`);
    for (const pt of pb.passthroughExports) body.push(pt);
    for (const rec of remainingDecls) {
      const shouldExport = rec.names.some((n) => pb.exportedMap.has(n));
      const declLine = shouldExport ? `export ${rec.codeNoExport}` : rec.codeNoExport;
      body.push(rec.doc ? `${rec.doc}\n${declLine}` : declLine);
    }

    rewrittenBarrels[b.key] = [...header, '', ...body, ''].join('\n');
  }

  return { kitDts, rewrittenBarrels };
}

const KIT_SCHEMA = 'packages/mistri/schema/kit.d.ts';
const tmp = mkdtempSync(join(tmpdir(), 'mistri-sdk-sync-'));

try {
  const emitCfg = join(tmp, 'tsconfig.emit.json');
  const dtsOut = join(tmp, 'dts');
  writeFileSync(
    emitCfg,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        jsx: 'react-jsx',
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: true,
        rootDir: resolve(ROOT, 'packages/ui/src'),
        outDir: dtsOut,
        paths: {
          '@mistriwork/ui/behaviors/index.js': [resolve(ROOT, 'packages/mistri/schema/behaviors.d.ts')],
        },
      },
      include: [...BARRELS.map((b) => resolve(ROOT, b.src)), resolve(ROOT, 'packages/ui/src/UiKit.tsx')],
    }),
  );
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', emitCfg, '--noCheck'], { cwd: ROOT, stdio: 'inherit' });
  sanitizeUiDistDts(dtsOut);

  let uiSdk = read('packages/mistri/src/shared/uiSdk.ts');
  const stale = [];

  /** @type {Record<string, string>} */
  const rawByKey = {};
  for (const b of BARRELS) {
    const mod = await tsImport(`../${b.src}`, import.meta.url);
    const valueNames = Object.keys(mod)
      .filter((k) => k !== 'default')
      .sort();

    rawByKey[b.key] = buildSelfContainedBarrelDts(dtsOut, b);

    const arrBlock = `export const ${b.constName} = [\n${valueNames.map((n) => `  '${n}',`).join('\n')}\n] as const;`;
    const re = new RegExp(`export const ${b.constName} = \\[[\\s\\S]*?\\] as const;`);
    if (!re.test(uiSdk)) throw new Error(`sync-ui-sdk: ${b.constName} not found in uiSdk.ts`);
    uiSdk = uiSdk.replace(re, arrBlock);
  }

  const { kitDts, rewrittenBarrels } = splitKitFromBarrels(rawByKey);
  const formattedKit = execFileSync(join(ROOT, 'node_modules/.bin/oxfmt'), [`--stdin-filepath=${KIT_SCHEMA}`], {
    cwd: ROOT,
    input: kitDts,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (!existsSync(join(ROOT, KIT_SCHEMA)) || read(KIT_SCHEMA) !== formattedKit) {
    if (process.argv.includes('--write')) write(KIT_SCHEMA, formattedKit);
    else stale.push(KIT_SCHEMA);
  }

  for (const b of BARRELS) {
    const nextSchema = execFileSync(join(ROOT, 'node_modules/.bin/oxfmt'), [`--stdin-filepath=${b.schema}`], {
      cwd: ROOT,
      input: rewrittenBarrels[b.key],
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    if (read(b.schema) !== nextSchema) {
      if (process.argv.includes('--write')) write(b.schema, nextSchema);
      else stale.push(b.schema);
    }
  }

  if (read('packages/mistri/src/shared/uiSdk.ts') !== uiSdk) {
    if (process.argv.includes('--write')) write('packages/mistri/src/shared/uiSdk.ts', uiSdk);
    else stale.push('packages/mistri/src/shared/uiSdk.ts');
  }

  if (stale.length) {
    console.error(`sync-ui-sdk: stale generated SDK export lists (${stale.join(', ')}); run \`node scripts/sync-ui-sdk.mjs --write\`.`);
    process.exitCode = 1;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
