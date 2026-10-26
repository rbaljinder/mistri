/**
 * TypeScript 7 for the tests that need the compiler.
 *
 * TypeScript 7 is the native compiler: `require('typescript')` is a version
 * stub with no `createProgram`, no `createSourceFile`, no `transpileModule`.
 * A test says what it used them for, and this file answers each with what 7
 * does have:
 *
 *   typecheck    a few lines of source (or an existing file) checked as a
 *                program, by the installed `tsc`; the text it printed, empty
 *                when nothing is wrong
 *   transpile    TypeScript to JavaScript, by `tsc --noCheck`
 *   parseFiles   a syntax tree per file, and project() a whole program with
 *                its checker, both through `typescript/unstable/sync` — the
 *                API client for the compiler process. Its name says it is not
 *                yet stable; the tests that need a tree or a type are the ones
 *                to learn first when it moves. The node helpers (`isImportDeclaration`,
 *                `SyntaxKind`) come from `typescript/unstable/ast` directly.
 *
 * Source that does not exist as a file is written to one beside its root for
 * the length of the call, under a name nothing else uses, because `tsc` reads
 * the disk and a probe's imports are resolved from where it sits.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import type { Program, Project } from 'typescript/unstable/sync';
import type { SourceFile } from 'typescript/unstable/ast';

export type { Project, Program };

const TESTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');

/**
 * What a throwaway typecheck in a test adds to its own options. Left to the
 * defaults it also loads the DOM library and every `@types` package in
 * node_modules, which a probe never names, and a program takes about three
 * times as long. Node's are kept: a probe that imports the server reaches
 * `Buffer` and `node:sqlite`.
 */
const LEAN_TYPES = { lib: ['es2023'], types: ['node'] };

const DEFAULTS = {
  ...LEAN_TYPES,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  target: 'ES2022',
};

interface TypecheckOptions {
  /** Source that is not on disk: written, checked, removed. Paths are absolute. */
  files?: Record<string, string>;
  /** Compiler options over the defaults, spelled as tsconfig.json spells them. */
  options?: Record<string, unknown>;
  /** A tsconfig.json to extend instead of the defaults: its own files are checked as well as `roots`, unless `only`. */
  project?: string;
  /** With `project`: take its options and nothing of what it includes. */
  only?: boolean;
}

/** `roots` and what they import, checked with the installed `tsc`; its report, or '' when it found nothing wrong. */
export function typecheck(roots: string | string[], { files = {}, options = {}, project, only }: TypecheckOptions = {}): string {
  const list = (Array.isArray(roots) ? roots : [roots]).map((root) => resolve(root));
  const written: string[] = [];
  /* Beside the tests, so `types` and `typeRoots` are looked for up the checkout's own node_modules. */
  const config = join(project ? dirname(project) : TESTS, `.tsc-${randomUUID()}.json`);
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      written.push(path);
    }
    writeFileSync(
      config,
      JSON.stringify(
        project
          ? {
              extends: project,
              compilerOptions: { noEmit: true, incremental: false, tsBuildInfoFile: null, ...options },
              files: list,
              ...(only ? { include: [] } : {}),
            }
          : { compilerOptions: { ...DEFAULTS, ...options }, files: list },
      ),
    );
    written.push(config);
    const ran = spawnSync(process.execPath, [TSC, '-p', config, '--pretty', 'false'], {
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (ran.error) throw ran.error;
    return `${ran.stdout}${ran.stderr}`.trim();
  } finally {
    for (const path of written) rmSync(path, { force: true });
  }
}

/** TypeScript to JavaScript, with nothing checked or resolved; `flags` are `tsc` options (`module`, `target`, `removeComments`…). */
export function transpile(text: string, flags: Record<string, string | boolean> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-transpile-'));
  try {
    const input = join(directory, flags.jsx ? 'module.tsx' : 'module.ts');
    writeFileSync(input, text);
    const options: Record<string, string | boolean> = { module: 'commonjs', target: 'es2022', ...flags };
    const ran = spawnSync(
      process.execPath,
      [
        TSC,
        input,
        '--noCheck',
        '--noResolve',
        '--types',
        '',
        '--lib',
        'es2023',
        '--skipLibCheck',
        '--outDir',
        join(directory, 'out'),
        '--rootDir',
        directory,
        ...Object.entries(options).flatMap(([name, value]) => (value === true ? [`--${name}`] : [`--${name}`, String(value)])),
      ],
      { encoding: 'utf8', timeout: 120_000, cwd: directory },
    );
    if (ran.error) throw ran.error;
    return readFileSync(join(directory, 'out', 'module.js'), 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

let shared: API | undefined;
/** One compiler process for the run: it holds nothing open, so the test runner still exits. */
const api = () => (shared ??= new API({ cwd: process.cwd() }));

/** A project's program and checker, for a test that asks the compiler about types. */
export function project(tsconfig: string): Project {
  const config = resolve(tsconfig);
  const found = api().updateSnapshot({ openProject: config }).getProject(config);
  if (!found) throw new Error(`typescript: no project for ${config}`);
  return found;
}

/**
 * A syntax tree for each file, parsed alone: no libraries, no imports followed,
 * JavaScript included. A `.mjs` or `.tsx` parses as what its extension says.
 */
export function parseFiles(files: string[]): Map<string, SourceFile> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-parse-'));
  try {
    const config = join(directory, 'tsconfig.json');
    const absolute = files.map((file) => resolve(file));
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true, jsx: 'preserve', target: 'esnext' },
        files: absolute,
      }),
    );
    const parsed = project(config).program;
    return new Map(
      absolute.map((file) => {
        const source = parsed.getSourceFile(file);
        if (!source) throw new Error(`typescript: ${file} was not parsed`);
        return [file, source] as const;
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One file's syntax tree. */
export const parseFile = (file: string): SourceFile => parseFiles([file]).get(resolve(file))!;

/** Source text that is not on disk, as one syntax tree each (keyed as given): written to a directory, parsed together, removed. */
export function parseTexts(texts: Record<string, string>): Map<string, SourceFile> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-text-'));
  try {
    const names = Object.keys(texts);
    const paths = names.map((name, index) => {
      /* Numbered, so two names that differ only in their folders stay two files; the extension is what picks the language. */
      const path = join(directory, `${index}${name.slice(name.lastIndexOf('.'))}`);
      writeFileSync(path, texts[name]);
      return path;
    });
    const parsed = parseFiles(paths);
    return new Map(names.map((name, index) => [name, parsed.get(paths[index])!] as const));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One text as a syntax tree; `name` sets the language by its extension. */
export const parseText = (text: string, name = 'module.ts'): SourceFile => parseTexts({ [name]: text }).get(name)!;
