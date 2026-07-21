import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeToon } from '../src/toon.js';

test('encodes a uniform object array as a headed table', () => {
  const out = encodeToon([
    { kind: 'summary', anchor: 'r1', reason: 'missing' },
    { kind: 'narration', anchor: 'r1/s1', reason: 'stale' },
  ]);
  assert.equal(
    out,
    ['[2]{kind,anchor,reason}:', '  summary,r1,missing', '  narration,r1/s1,stale'].join('\n')
  );
});

test('quotes fields that contain the separator, a colon, a quote, or edge whitespace', () => {
  const out = encodeToon([{ a: 'x,y', b: 'has "quote"', c: 'plain', d: ' pad ' }]);
  const [, row] = out.split('\n');
  assert.equal(row, '  "x,y","has ""quote""",plain," pad "');
});

test('empty array reports its length', () => {
  assert.equal(encodeToon([]), '[0]:');
});

test('encodes a top-level object as key/value lines', () => {
  const out = encodeToon({ flavor: 'openspec', docs: 3, done: true });
  assert.equal(out, ['flavor: openspec', 'docs: 3', 'done: true'].join('\n'));
});

test('inlines a scalar array', () => {
  assert.equal(encodeToon({ tags: ['a', 'b', 'c'] }), 'tags[3]: a,b,c');
});

test('nests an object value and tables an array value under a key', () => {
  const out = encodeToon({
    project: 'demo',
    tasks: [
      { id: 1, done: false },
      { id: 2, done: true },
    ],
  });
  assert.equal(out, ['project: demo', 'tasks[2]{id,done}:', '  1,false', '  2,true'].join('\n'));
});

test('null and undefined render as an empty field', () => {
  assert.equal(encodeToon({ a: null, b: 'x' }), ['a: ', 'b: x'].join('\n'));
});

test('a non-uniform array falls back without throwing', () => {
  const out = encodeToon([{ a: 1 }, { a: 1, b: 2 }]);
  assert.match(out, /\[2\]:/);
  assert.match(out, /- /);
});
