import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES, makeCtx, registry } from './_helpers.mjs';

// Proves the host-facing contract: apply(ctx) registers plain-object
// descriptors whose `parameters` is usable raw JSON Schema and whose
// `output.render` produces the tool result content array.

test('lib/index.js exports name / inject / apply and nothing problematic', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.name, 'notebook-tools');
  assert.deepEqual(mod.inject, ['tools']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.default, undefined, 'no default export expected');
});

test('apply() registers exactly the 9 expected tools, in order', () => {
  const ctx = makeCtx();
  assert.equal(ctx.registered.length, 9);
  assert.deepEqual(
    ctx.registered.map((t) => t.name),
    TOOL_NAMES,
  );
});

test('every descriptor carries a valid JSON Schema `parameters` object', () => {
  for (const tool of registry().tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} description`);
    assert.ok(tool.description.length > 10, `${tool.name} description is substantive`);

    const params = tool.parameters;
    assert.equal(typeof params, 'object', `${tool.name} parameters is an object`);
    assert.equal(params.type, 'object', `${tool.name} parameters.type`);
    assert.equal(typeof params.properties, 'object', `${tool.name} parameters.properties`);
    assert.ok(!Array.isArray(params.properties), `${tool.name} properties is a map`);
    assert.equal(params.additionalProperties, false, `${tool.name} additionalProperties`);
    assert.ok(Array.isArray(params.required), `${tool.name} required is an array`);
    assert.ok(params.required.includes('path'), `${tool.name} requires path`);

    // Every required key must exist in properties, and every property must be
    // a schema object the host validator can accept.
    for (const key of params.required) {
      assert.ok(key in params.properties, `${tool.name}.${key} declared in properties`);
    }
    for (const [key, schema] of Object.entries(params.properties)) {
      assert.equal(typeof schema, 'object', `${tool.name}.${key} schema`);
      assert.ok(
        typeof schema.type === 'string' || schema.enum || schema.anyOf,
        `${tool.name}.${key} has a type/enum`,
      );
      assert.ok('description' in schema, `${tool.name}.${key} has a description`);
    }

    // array properties declare `items` (the host validator requires it)
    for (const [key, schema] of Object.entries(params.properties)) {
      if (schema.type === 'array') {
        assert.ok(schema.items, `${tool.name}.${key} array declares items`);
      }
    }
  }
});

test('enums keep the reference TypeBox literals', () => {
  const tools = registry().map;
  assert.deepEqual(tools.get('notebook_insert_cell').parameters.properties.cell_type.enum, [
    'code',
    'markdown',
    'raw',
  ]);
  assert.deepEqual(tools.get('notebook_search').parameters.properties.cell_type.enum, [
    'code',
    'markdown',
    'raw',
  ]);
  assert.deepEqual(tools.get('notebook_insert_cell').parameters.properties.placement.enum, [
    'before',
    'after',
  ]);
  assert.equal(tools.get('notebook_insert_cell').parameters.properties.placement.default, 'after');
});

test('reference defaults are preserved', () => {
  const p = (name) => registry().map.get(name).parameters.properties;
  assert.equal(p('notebook_read').include_outputs.default, false);
  assert.equal(p('notebook_read').max_output_chars.default, 2000);
  assert.equal(p('notebook_read').max_output_chars.minimum, 0);
  assert.equal(p('notebook_read').max_output_items.default, 5);
  assert.equal(p('notebook_list_cells').preview_len.default, 120);
  assert.equal(p('notebook_search').max_matches.default, 20);
  assert.equal(p('notebook_search').max_matches.minimum, 1);
  assert.equal(p('notebook_search').context_lines.default, 1);
  assert.equal(p('notebook_search').context_lines.minimum, 0);
  assert.equal(p('notebook_search').context_lines.maximum, 5);
  assert.equal(p('notebook_search').regex.default, false);
  assert.equal(p('notebook_search').case_sensitive.default, false);
  assert.equal(p('notebook_create').overwrite.default, false);
  assert.equal(p('notebook_create').kernel.properties.name.default, 'python3');
  assert.equal(p('notebook_create').kernel.properties.display_name.default, 'Python 3');
  assert.equal(p('notebook_create').kernel.properties.language.default, 'python');
});

test('output.render turns the returned string into text content', async () => {
  for (const tool of registry().tools) {
    assert.equal(tool.output.schema.type, 'string', `${tool.name} output schema`);
    const rendered = tool.output.render({}, 'hello');
    assert.ok(Array.isArray(rendered), `${tool.name} render returns an array`);
    assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }]);
    // non-string values must not crash
    assert.equal(tool.output.render({}, null)[0].text, '');
    assert.equal(tool.output.render({}, 42)[0].text, '42');
  }
});

test('a fake ctx without a logger still registers cleanly', async () => {
  const mod = await import('../lib/index.js');
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) } };
  mod.apply(ctx, undefined);
  assert.equal(registered.length, 9);
});
