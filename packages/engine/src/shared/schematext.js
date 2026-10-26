/**
 * The schema as text — Mermaid, Markdown, JSON — with no DOM and no state.
 *
 * Split from schemaexport.js so the server can speak these formats too:
 * `tablewalk --export md` prints the same brief the browser downloads, and a
 * committed CLAUDE.md schema section costs one command. Pure on purpose, the
 * way shape.js is pure — a schema in, text out, importable from anywhere.
 */

/** The tables to export, and the keys wholly between them. */
export function selection(schema, only) {
  const wanted = only?.size ? schema.tables.filter((t) => only.has(t.id)) : schema.tables;
  const ids = new Set(wanted.map((t) => t.id));
  /* Only keys with both ends in the selection. A reference to a table that is
     not in the export is an edge pointing at nothing, which renders as a
     dangling arrow and imports as a broken constraint. */
  const keys = schema.foreignKeys.filter((fk) => ids.has(fk.from.table) && ids.has(fk.to.table));
  return { tables: wanted, keys };
}

/* ---------- text formats ---------- */

/**
 * Mermaid `erDiagram`.
 *
 * Cardinality is stated as far as the catalog knows it, which is not very far:
 * a foreign key says the child *may* point at one parent, and says nothing
 * about whether a parent must have children. So every relationship is written
 * `}o--||` — many-optional to exactly-one — which is what a nullable foreign
 * key actually guarantees. Claiming more precision would be inventing it.
 *
 * Mermaid identifiers cannot contain a dot, so `app.invoice` becomes
 * `app_invoice`. Said in a comment at the top of the output rather than
 * silently, because someone comparing the diagram to their database will
 * notice.
 */
export function toMermaid(schema, only) {
  const { tables, keys } = selection(schema, only);
  const safe = (id) => id.replace(/[^\w]/g, '_');
  const lines = ['erDiagram'];

  for (const table of tables) {
    lines.push(`    ${safe(table.id)} {`);
    for (const column of table.columns) {
      const type = (column.type || 'unknown').replace(/[^\w]/g, '_') || 'unknown';
      const marks = [column.primaryKey ? 'PK' : '', column.references ? 'FK' : ''].filter(Boolean).join(',');
      lines.push(`        ${type} ${column.name}${marks ? ` ${marks}` : ''}`);
    }
    lines.push('    }');
  }

  for (const fk of keys) {
    const label = fk.from.columns.join(', ');
    lines.push(`    ${safe(fk.to.table)} ||--o{ ${safe(fk.from.table)} : "${label}"`);
  }

  const renamed = tables.some((t) => safe(t.id) !== t.id);
  return (
    (renamed ? '%% Names containing a dot are written with an underscore: Mermaid ids cannot hold one.\n' : '') + lines.join('\n') + '\n'
  );
}

/** A readable reference document, of the kind that belongs in a repository. */
export function toMarkdown(schema, only) {
  const { tables, keys } = selection(schema, only);
  const out = [`# ${schema.label}`, ''];
  out.push(`${tables.length} table${tables.length === 1 ? '' : 's'}, ` + `${keys.length} foreign key${keys.length === 1 ? '' : 's'}.`, '');

  for (const table of tables) {
    out.push(`## ${table.id}${table.isView ? ' *(view)*' : ''}`, '');
    if (table.comment) out.push(table.comment, '');

    out.push('| Column | Type | | References |', '| --- | --- | --- | --- |');
    for (const c of table.columns) {
      const marks = [c.primaryKey ? '**key**' : '', c.nullable ? '' : 'required'].filter(Boolean).join(', ');
      const ref = c.references ? `→ \`${c.references.table}.${c.references.column}\`` : '';
      out.push(`| \`${c.name}\` | ${c.type} | ${marks} | ${ref} |`);
    }
    out.push('');

    /* What points *at* this table, which is the half a schema document
       usually leaves out and the half tablewalk exists to show. */
    const incoming = keys.filter((fk) => fk.to.table === table.id);
    if (incoming.length) {
      out.push('Referenced by:', '');
      for (const fk of incoming) {
        out.push(`- \`${fk.from.table}\` via \`${fk.from.columns.join(', ')}\`` + (fk.onDelete ? ` — on delete ${fk.onDelete}` : ''));
      }
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * The structured form.
 *
 * Deliberately the shape tablewalk itself uses rather than a format invented
 * for export — anything that reads it is reading the same model the tool
 * reasons about, and there is no second definition to keep in step.
 */
export function toSchemaJson(schema, only) {
  const { tables, keys } = selection(schema, only);
  return JSON.stringify(
    {
      label: schema.label,
      dialect: schema.dialect,
      readAt: schema.readAt,
      exportedAt: new Date().toISOString(),
      partial: Boolean(only?.size) && tables.length < schema.tables.length,
      tables,
      foreignKeys: keys,
    },
    null,
    2,
  );
}
