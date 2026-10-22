'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;
const model = import('../src/whiteboard-model.mjs');

test('whiteboard saves a bounded schema without runtime URLs, SVG or HTML', async () => {
  const { createBoard, validateBoard } = await model;
  const board = createBoard('<script>ordinary title</script>');
  board.nodes = [{ id: 'a', x: 12, y: 24, width: 260, height: 200, assetId: 'asset', title: '<img onerror=alert(1)>', attrs: { html: 'unsafe' }, src: 'blob:expired' }];
  const saved = validateBoard(board);
  assert.equal(saved.nodes[0].title, '<img onerror=alert(1)>');
  assert.equal(saved.nodes[0].src, undefined);
  assert.equal(saved.nodes[0].attrs, undefined);
  assert.deepEqual(saved.viewport, { x: 0, y: 0, zoom: 1 });
});

test('legacy prompts stay hidden and authored captions/frame choices roundtrip independently', async () => {
  const { createBoard, validateBoard } = await model;
  const board = createBoard();
  board.nodes = [
    { id: 'old', title: 'Legacy generation prompt' },
    { id: 'new', caption: 'My exhibition', framed: true },
    { id: 'plain', caption: '', framed: false }
  ];
  const saved = validateBoard(board);
  assert.equal(saved.nodes[0].caption, '');
  assert.equal(saved.nodes[0].framed, false);
  assert.equal(saved.nodes[1].caption, 'My exhibition');
  assert.equal(saved.nodes[1].framed, true);
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(saved))), saved);
});

test('whiteboard supports cycles, multiple relationships and relative image pins', async () => {
  const { createBoard, validateBoard } = await model;
  const board = createBoard();
  board.nodes = [{ id: 'a', pins: [{ id: 'pin', x: 0.3, y: 0.7 }] }, { id: 'b' }];
  board.edges = [
    { id: 'e1', source: { cell: 'a', port: 'pin' }, target: { cell: 'b' }, line: 'straight' },
    { id: 'e2', source: { cell: 'b' }, target: { cell: 'a' } },
    { id: 'e3', source: { cell: 'a' }, target: { cell: 'a' } }
  ];
  const saved = validateBoard(board);
  assert.equal(saved.edges.length, 3);
  assert.deepEqual(saved.nodes[0].pins[0], { id: 'pin', x: 0.3, y: 0.7 });
});

test('older curved and routed connections reopen as straight lines without changing endpoints', async () => {
  const { createBoard, validateBoard } = await model;
  const board = createBoard();
  board.nodes = [{ id: 'a' }, { id: 'b' }];
  board.edges = ['curve', 'orth', undefined].map((line, i) => ({
    id: 'edge-' + i, source: { cell: 'a' }, target: { cell: 'b' },
    line, vertices: [{ x: 50, y: 100 }], label: 'connection'
  }));
  for (const edge of validateBoard(board).edges) {
    assert.equal(edge.line, 'straight');
    assert.deepEqual(edge.vertices, []);
    assert.deepEqual(edge.source, { cell: 'a' });
    assert.deepEqual(edge.target, { cell: 'b' });
    assert.equal(edge.label, 'connection');
  }
});

test('whiteboard rejects broken relationships, duplicate IDs and unsupported versions', async () => {
  const { createBoard, validateBoard } = await model;
  const board = createBoard(); board.nodes = [{ id: 'a' }];
  assert.throws(() => validateBoard({ ...board, version: 99 }), /版本/);
  assert.throws(() => validateBoard({ ...board, nodes: [{ id: 'a' }, { id: 'a' }] }), /重复/);
  assert.throws(() => validateBoard({ ...board, edges: [{ id: 'e', source: { cell: 'a' }, target: { cell: 'missing' } }] }), /不存在/);
  assert.throws(() => validateBoard({ ...board, edges: [{ id: 'e', source: { cell: 'a', port: 'missing' }, target: { cell: 'a' } }] }), /连接点/);
});

test('whiteboard clamps malformed dimensions and rejects executable image formats in backups', async () => {
  const { createBoard, validateBoard, validatePackage, FORMAT, VERSION } = await model;
  const board = createBoard(); board.nodes = [{ id: 'a', assetId: 'image', x: Infinity, width: -1, height: 10000 }];
  const node = validateBoard(board).nodes[0];
  assert.equal(node.x, 0); assert.equal(node.width, 120); assert.equal(node.height, 4000);
  const wrap = assets => ({ format: FORMAT, version: VERSION, board, assets });
  assert.throws(() => validatePackage(wrap([])), /缺少/);
  assert.throws(() => validatePackage(wrap([{ id: 'image', data: 'data:image/svg+xml;base64,PHN2Zz4=' }])), /无效/);
  assert.throws(() => validatePackage(wrap([{ id: 'image', data: 'https://example.com/image.png' }])), /无效/);
});

test('backup roundtrip keeps image references and never changes the source board identity', async () => {
  const { createBoard, validatePackage, FORMAT, VERSION, assetIds } = await model;
  const { cloneImported } = await import('../src/whiteboard-store.mjs');
  const source = createBoard('作品展示'); source.nodes = [{ id: 'one', assetId: 'image' }, { id: 'two', assetId: 'image' }];
  const payload = { format: FORMAT, version: VERSION, board: source, assets: [{ id: 'image', data: 'data:image/png;base64,aGVsbG8=' }] };
  const restored = validatePackage(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(assetIds(restored.board), ['image']);
  const copy = cloneImported(restored.board);
  assert.notEqual(copy.id, source.id); assert.equal(restored.board.id, source.id);
});
