/**
 * What one binary's README owes that binary: every flag its USAGE has is in its Options block and none is made up
 * there, and every relative link lands inside the package that ships the README. One suite, run once per binary
 * (test/prose-tablewalk.test.ts, test/prose-mistri.test.ts), so each package's own run holds its own README.
 *
 * test-package: dispatch — the file that calls this names the binary, and is that package's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flagsIn } from '../../scripts/public-surface.mjs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** A usage module's `USAGE` text. */
export const usageOf = (cli: string): string => {
  const usage = cli.match(/const USAGE = `([\s\S]*?)`/)?.[1];
  assert.ok(usage, 'USAGE moved — update the extraction here');
  return usage;
};

export function productProse(bin: 'tablewalk' | 'mistri'): void {
  const readme = read(`packages/${bin}/README.md`);
  const cli = read(`packages/${bin}/src/server/cli/usage.ts`);

  test(`every flag in ${bin}'s USAGE is in its README Options block, and none is made up there`, () => {
    /* USAGE is the live help text; the README Options block is its prose
         twin. Extracted from both and compared as sets, so a flag added to
         one without the other fails with its name. */
    // The one extraction, shared with scripts/public-surface.mjs.
    const usage = usageOf(cli);
    const options = readme.match(/## Options\n\n```([\s\S]*?)```/)?.[1];
    assert.ok(options, `the ${bin} README Options block moved — update the extraction here`);
    const fromUsage = flagsIn(usage);
    const fromReadme = flagsIn(options!);
    for (const flag of fromUsage) {
      assert.ok(fromReadme.has(flag), `${bin}'s USAGE has ${flag}; its README Options block does not`);
    }
    for (const flag of fromReadme) {
      assert.ok(fromUsage.has(flag), `${bin}'s README Options block has ${flag}; its USAGE does not`);
    }
  });

  /* The README is read in two places that do not hold the repository: on
     npm, and in node_modules/tablewalk. A relative link to site/ or docs/
     worked on GitHub and nowhere a package reader was, so a link either
     lands inside what `files` ships or is a full URL. */
  test(`every relative link in ${bin}'s README lands inside its published package`, () => {
    const shipped: string[] = JSON.parse(read(`packages/${bin}/package.json`)).files;
    const relative = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(https?:|mailto:|#)/.test(target));
    for (const target of relative) {
      const path = target.split('#')[0];
      assert.ok(
        shipped.some((entry) => path === entry || path.startsWith(`${entry}/`)),
        `${bin}'s README links to ${target}, which the package does not ship; link the site or GitHub, or name \`mistri docs <topic>\``,
      );
    }
  });
}
