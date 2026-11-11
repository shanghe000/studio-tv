// Offline validation. Dependencies are documentation tools, not app dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const depRoot = path.resolve(process.argv[2] || path.join(root, '.local/er-tools'));
const require = createRequire(path.join(depRoot, 'package.json'));
const { Parser } = require('@dbml/core');
const { default: mermaid } = await import(pathToFileURL(path.join(depRoot, 'node_modules/mermaid/dist/mermaid.esm.mjs')));
const model = JSON.parse(fs.readFileSync(path.join(root, 'docs/design/database-model.json'), 'utf8'));
const dbml = fs.readFileSync(path.join(root, 'docs/design/database.dbml'), 'utf8');

try {
  for (const [name, expected] of Object.entries(model.sources)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    assert.equal(actual, expected, `ER snapshot source changed: ${name}`);
  }
  const database = new Parser().parse(dbml, 'dbml');
  const tables = new Map(database.schemas.flatMap(s => s.tables.map(t => [`${s.name}.${t.name}`, t])));
  const refs = new Map(database.schemas.flatMap(s => s.refs.map(r => [r.name, r])));
  assert.equal(tables.size, 67);
  assert.equal([...tables.keys()].filter(n => !n.startsWith('public.')).length, 57);
  assert.equal(refs.size, model.foreignKeys.length);
  let columns = 0;
  for (const expected of model.tables) {
    const name = `${expected.schema}.${expected.name}`;
    const actual = tables.get(name);
    assert.ok(actual, `missing table ${name}`);
    assert.deepEqual(actual.fields.map(f => f.name), expected.columns.map(c => c.name), `columns ${name}`);
    for (const c of expected.columns) {
      const field = actual.fields.find(f => f.name === c.name);
      assert.equal(!!field.not_null, c.notNull, `nullability ${name}.${c.name}`);
      columns++;
    }
    const pk = expected.constraints.find(c => c.type === 'p')?.columns || [];
    const actualPk = actual.indexes.filter(i => i.pk).flatMap(i => i.columns.map(c => c.value));
    actualPk.push(...actual.fields.filter(f => f.pk).map(f => f.name));
    assert.deepEqual(actualPk.sort(), [...pk].sort(), `PK ${name}`);
  }
  const endpoint = e => `${e.schemaName || 'public'}.${e.tableName}(${e.fieldNames.join(',')})`;
  for (let i = 0; i < model.foreignKeys.length; i++) {
    const f = model.foreignKeys[i];
    const r = refs.get(`fk_${i + 1}`);
    assert.ok(r, `missing FK ${f.name}`);
    assert.deepEqual(r.endpoints.map(endpoint).sort(), [
      `${f.child}(${f.columns.join(',')})`, `${f.parent}(${f.parentColumns.join(',')})`,
    ].sort(), `FK ${f.name}`);
  }
  console.log(`PASS DBML: 67 tables (57 proposed + 10 existing), ${columns} columns, ${refs.size} physical FKs`);
  mermaid.initialize({startOnLoad:false, securityLevel:'loose'});
  const markdown = fs.readFileSync(path.join(root,'docs/database-er.md'),'utf8');
  const blocks = [...markdown.matchAll(/```mermaid\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 11);
  for (let i = 0; i < blocks.length; i++) await mermaid.parse(blocks[i][1]);
  console.log('PASS 11 Mermaid ER diagrams');
  console.log('PASS source hashes match migrations + blueprint; no runtime/DB migration');
} catch (error) {
  console.error('FAIL', error.diags?.map(d => ({message:d.message, location:d.location})) || error.message);
  process.exitCode = 1;
}
