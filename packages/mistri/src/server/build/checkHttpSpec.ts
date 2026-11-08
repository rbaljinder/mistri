/**
 * `mistri check` for an HTTP connection's description against the OpenAPI spec it was drafted from.
 *
 * The adapter reads the description and only it (httpDescription.ts), so a spec that moved on is invisible at runtime:
 * the API answers a column the description still names, or stops answering it, and the first sign is an empty cell. The
 * description pins the spec by file name and sha256 for this; nothing read it. When the spec file is no longer the one
 * the description was drafted from, that fails, and so does each declared column the new spec's response schema lacks
 * or types otherwise, so the fix names what moved. Against an unchanged spec the columns are not compared: the drafted
 * description is reviewed and owns its columns, so a type corrected by hand or a column the spec forgot is a decision,
 * not drift.
 *
 * A spec named by URL is not fetched: a check makes no request. A spec file that is gone is a warning, since the
 * description is complete without it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readDescription } from '@mistriwork/engine/adapters/http/httpDescription.js';
import { OpenApiError, readOpenApi } from '@mistriwork/engine/adapters/http/openapi.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';

interface HttpSpecFinding {
  code: 'http-spec-changed' | 'http-spec-missing' | 'http-spec-unreadable' | 'http-column-missing' | 'http-column-type';
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

const REDRAFT =
  'Draft it again with `mistri --from-openapi <spec>` and carry your corrections over, or restore the spec the description was drafted from';

/** Findings for each HTTP connection whose description is a file that pins a spec on disk. */
export async function httpSpecFindings(connections: ReadonlyArray<Pick<ConnectionConfig, 'name' | 'http'>>): Promise<HttpSpecFinding[]> {
  const found: HttpSpecFinding[] = [];
  for (const connection of connections) {
    const path = connection.http?.descriptionPath;
    // An inline description has no folder to find a spec in, and a malformed one is the load's to refuse.
    if (!path) continue;
    let description;
    try {
      description = readDescription(JSON.parse(await readFile(path, 'utf8')), path);
    } catch {
      continue;
    }
    const pinned = description.spec;
    if (!pinned || /^https?:\/\//i.test(pinned.file)) continue;
    const label = `Connection "${connection.name}"`;
    const file = resolve(dirname(path), pinned.file);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      found.push({
        code: 'http-spec-missing',
        severity: 'warning',
        message: `${label}: the description names the spec "${pinned.file}", which is not beside it, so its columns were not checked against it.`,
        fix: 'Put the spec back beside the description, or leave it: the description is read on its own.',
      });
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') === pinned.sha256) continue;
    found.push({
      code: 'http-spec-changed',
      severity: 'error',
      message: `${label}: the spec "${pinned.file}" is not the one its description was drafted from (the sha256 differs), so the columns may have moved.`,
      fix: `${REDRAFT}.`,
    });
    let catalog;
    try {
      catalog = readOpenApi(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      found.push({
        code: 'http-spec-unreadable',
        severity: 'error',
        message: `${label}: the spec "${pinned.file}" cannot be read as OpenAPI: ${error instanceof OpenApiError || error instanceof SyntaxError ? error.message : String(error)}`,
        fix: 'Make the file OpenAPI 3.0 or 3.1 JSON again, or restore the spec the description was drafted from.',
      });
      continue;
    }
    for (const resource of description.resources) {
      const named = catalog.resources.find((each) => each.name === resource.name);
      // A resource the spec does not draft was added by hand; there is no response schema to hold its columns to.
      if (!named) continue;
      for (const column of resource.columns) {
        const there = named.columns.find((each) => each.name === column.name);
        if (!there) {
          found.push({
            code: 'http-column-missing',
            severity: 'error',
            message: `${label}: ${resource.name}.${column.name} is not in the response schema of "${pinned.file}".`,
            fix: `Remove the column from the description, or add it to the spec's schema for ${resource.name}.`,
          });
        } else if (there.type !== column.type) {
          found.push({
            code: 'http-column-type',
            severity: 'error',
            message: `${label}: ${resource.name}.${column.name} is "${column.type}" in the description and "${there.type}" in "${pinned.file}".`,
            fix: `Change the column's "type" to "${there.type}", or correct the type in the spec.`,
          });
        }
      }
    }
  }
  return found;
}
