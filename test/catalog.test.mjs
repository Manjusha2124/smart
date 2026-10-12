import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { validateCatalog } from '../src/domain.mjs';

test('bundled starter menu satisfies backend import requirements', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('let S,Q=', start);
  const context = { document: { title: 'Smart Canteen' }, addEventListener() {} };
  const catalog = JSON.parse(vm.runInNewContext(
    `${html.slice(start, end)};JSON.stringify(seed())`,
    context
  ));

  assert.equal(catalog.menu.length, 345);
  validateCatalog(catalog.menu, catalog.cats);
});
