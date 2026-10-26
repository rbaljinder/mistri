#!/usr/bin/env node
/* Writes packages/kit/src/client/partsLook.css from the published parts' selectors (packages/mistri/src/server/app/themePartSelectors.ts).
   Run with: node --import tsx scripts/theme-parts-css.mjs */
import { writeFileSync } from 'node:fs';
import { partsSheet } from '../packages/mistri/src/server/app/themePartSelectors.ts';

writeFileSync(new URL('../packages/kit/src/client/partsLook.css', import.meta.url), partsSheet());
