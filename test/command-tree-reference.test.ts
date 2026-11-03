/**
 * A reference picked from its hierarchy (`field.reference('category', { by: 'id', labelColumn: 'name', tree:
 * 'parent_id' })`): the definition keeps `tree`, refuses one that is the key or the label, and the catalog check
 * holds it to a column of `from` that names a parent row of `from` itself. On a public form the visitor reads that
 * column too, so `auth.public` must open it, as it opens the key and the label.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineCommand, BusinessCommandDefinitionError } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineSource } from '../packages/mistri/src/server/commands/commandDb.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { commandInputProblem, type AppCommandField } from '../packages/mistri/src/shared/command.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type = 'INTEGER', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const schema = {
  label: 'Desk',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'category',
      name: 'category',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('name', 'TEXT'), column('parent_id'), column('team_id')],
    },
    { id: 'ticket', name: 'ticket', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('category_id')] },
    { id: 'team', name: 'team', schema: '', isView: false, columns: [column('id', 'INTEGER', true)] },
  ],
  foreignKeys: [
    { name: 'category_parent', from: { table: 'category', columns: ['parent_id'] }, to: { table: 'category', columns: ['id'] } },
    { name: 'category_team', from: { table: 'category', columns: ['team_id'] }, to: { table: 'team', columns: ['id'] } },
  ],
} as DatabaseSchema;
const source = defineSource('desk');

const categorize = (tree: string) =>
  defineCommand({
    source,
    target: 'ticket',
    input: { category: field.reference('category', { by: 'id', labelColumn: 'name', tree }) },
    read: ['category'],
    output: bool(),
    handle() {
      return true;
    },
  });
const inputOf = (tree: string): readonly AppCommandField[] => categorize(tree).fields;

test("the definition keeps a reference's tree, and refuses one that is its key or its label", () => {
  const [category] = inputOf('parent_id');
  assert.equal(category.type === 'reference' && category.tree, 'parent_id');
  assert.throws(
    () => categorize('id'),
    (error: unknown) =>
      error instanceof BusinessCommandDefinitionError &&
      /tree names the column that holds each row's parent, not "id", its key/.test(String(error)),
  );
  assert.throws(() => categorize('name'), /not "name", its label/);
});

test('the catalog holds a tree to a column of `from` naming a parent row of `from` itself', () => {
  assert.equal(commandInputProblem(inputOf('parent_id'), schema), undefined);
  assert.match(commandInputProblem(inputOf('parent'), schema) ?? '', /tree names "parent", which is not a column of "category"/);
  assert.match(
    commandInputProblem(inputOf('team_id'), schema) ?? '',
    /tree "team_id" refers to "team"; a tree's column names a parent row of "category" itself/,
  );
  // A column the catalog says nothing of refers to nothing: no branch could be opened from it.
  const loose = { ...schema, foreignKeys: [] } as DatabaseSchema;
  assert.match(commandInputProblem(inputOf('parent_id'), loose) ?? '', /tree "parent_id" refers to nothing/);
});
