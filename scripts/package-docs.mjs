#!/usr/bin/env node
/**
 * The site's pages, shipped. Run by `npm run build`, after tsc.
 *
 * The docs site is written once, as Markdown under site/src/content/docs/docs.
 * mistri ships its `dist`, so the same files land in packages/mistri/dist/docs, where
 * `mistri docs` and the MCP shelf read them (packages/mistri/src/server/docs.ts). Copied as
 * written, front matter included: it holds each page's title and purpose.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../site/src/content/docs/docs/', import.meta.url));
const to = fileURLToPath(new URL('../packages/mistri/dist/docs/', import.meta.url));
mkdirSync(to, { recursive: true });
const pages = readdirSync(from).filter((file) => file.endsWith('.md'));
for (const page of pages) copyFileSync(`${from}${page}`, `${to}${page}`);
/* The composition guide's screenshots travel with it: `mistri docs` names each one's file, so an agent holding
   only the package can look at the worked example it is told to match. */
const images = fileURLToPath(new URL('../site/src/assets/guide/', import.meta.url));
mkdirSync(`${to}assets/guide`, { recursive: true });
const shots = readdirSync(images).filter((file) => file.endsWith('.webp'));
for (const shot of shots) copyFileSync(`${images}${shot}`, `${to}assets/guide/${shot}`);
console.log(`package-docs: ${pages.length} pages and ${shots.length} guide screenshots to packages/mistri/dist/docs`);
