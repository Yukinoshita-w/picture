'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paletteDistance, hamming } = require('../public/series-drift');

const palette = entries => ({ palette: entries.map(([key, weight]) => ({ key, weight })), luminance: 0.5, hash: '' });

test('identical palettes have zero distance', () => {
  const left = palette([['1:2:3', 0.6], ['4:5:6', 0.4]]);
  assert.equal(paletteDistance(left, left), 0);
});

test('disjoint palettes have distance one', () => {
  const left = palette([['1:2:3', 1]]);
  const right = palette([['7:7:7', 1]]);
  assert.equal(paletteDistance(left, right), 1);
});

test('partially shared palettes sit between the extremes', () => {
  const left = palette([['1:2:3', 0.5], ['4:5:6', 0.5]]);
  const right = palette([['1:2:3', 0.5], ['7:7:7', 0.5]]);
  const distance = paletteDistance(left, right);
  assert.ok(distance > 0 && distance < 1, String(distance));
});

test('palette distance ignores weight order', () => {
  const left = palette([['1:2:3', 0.7], ['4:5:6', 0.3]]);
  const right = palette([['4:5:6', 0.3], ['1:2:3', 0.7]]);
  assert.equal(paletteDistance(left, right), 0);
});

test('empty palettes do not produce NaN', () => {
  const empty = { palette: [], luminance: 0, hash: '' };
  assert.equal(paletteDistance(empty, empty), 0);
});

test('hamming distance grows with the number of differing bits', () => {
  assert.equal(hamming('0000', '0000'), 0);
  assert.equal(hamming('0000', '1111'), 1);
  assert.equal(hamming('0000', '0011'), 0.5);
});

test('hamming tolerates different lengths', () => {
  assert.equal(hamming('000', '00000'), 0);
  assert.equal(hamming('', ''), 0);
});
