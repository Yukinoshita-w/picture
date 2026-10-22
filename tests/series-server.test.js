'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
let upstream, app, apiUrl, appUrl, lastRequest;
const stats = { chatCalls: 0, lastMessages: null, imageParts: 0 };

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function post(route, body) {
  return fetch(appUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function config(extra = {}) {
  return { apiUrl: apiUrl + '/v1', apiKey: 'test-secret', model: 'text-model', input: '一段素材', ...extra };
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'text-model' }] }));
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    lastRequest = { path: req.url, body };
    stats.chatCalls++;
    stats.lastMessages = body?.messages || null;
    const system = body?.messages?.[0]?.content || '';
    const user = body?.messages?.[1]?.content;
    if (Array.isArray(user)) stats.imageParts = user.filter(part => part?.type === 'image_url').length;

    if (body?.model === 'bad-key') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Invalid key test-secret' } }));
    }
    if (body?.model === 'rate-limit') {
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
    }
    if (body?.model === 'non-json') return res.end('<html>wrong endpoint</html>');

    // Malformed JSON, used to verify the browser-side repair path keeps the raw text.
    if (body?.model === 'broken-json') {
      return res.end(JSON.stringify({ choices: [{ message: { content: '{"themes": ["a",]}' } }] }));
    }
    // JSON wrapped in prose and a code fence.
    if (body?.model === 'fenced-json') {
      return res.end(JSON.stringify({ choices: [{ message: { content: '好的，结果如下：\n```json\n{"themes":["记忆"]}\n```\n希望有帮助。' } }] }));
    }
    if (body?.model === 'refusal') {
      return res.end(JSON.stringify({ choices: [{ message: { refusal: 'no' }, finish_reason: 'content_filter' }] }));
    }
    if (body?.model === 'truncated') {
      return res.end(JSON.stringify({ choices: [{ message: { content: '{"themes": ["a"' }, finish_reason: 'length' }] }));
    }
    if (body?.model === 'empty') {
      return res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    }
    if (/describe|角色参考图/.test(system)) {
      return res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: '短黑发年轻男性', appearance: '短黑发微湿，深灰呢大衣', palette: ['深灰', '黑'], props: [], suggestedTerms: { hero: '林野' }, notes: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      }));
    }
    if (/帧清单/.test(system)) {
      return res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ title: '雨夜邮差', beats: ['第一幕'], axes: [], shots: [{ code: 'S01', title: '邮局', subject: '林野', action: '投递', scene: '邮局', detail: '雨', axisValues: {} }] }) } }]
      }));
    }
    return res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ themes: ['记忆'], visualClues: ['钠灯'], characters: [], places: [], props: [], mood: [], era: '', paletteHints: [], taboos: [], notableLines: [] }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 60 }
    }));
  });
  apiUrl = await listen(upstream);
  app = createServer();
  appUrl = await listen(app);
});

after(async () => {
  for (const server of [app, upstream]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('serves the new series scripts', async () => {
  for (const route of ['/series-engine.js', '/series-store.js', '/series-prompts.js', '/reference-guidance.js']) {
    const response = await fetch(appUrl + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 0);
  }
});

test('extract returns parsed JSON and the resolved model', async () => {
  const response = await post('/api/series/extract', config({ chunkIndex: 0, chunkTotal: 3, headingPath: ['第一幕'] }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.model, 'text-model');
  assert.deepEqual(data.data.themes, ['记忆']);
  assert.equal(data.usage.prompt_tokens, 120);
  assert.match(stats.lastMessages[0].content, /第 1 块，共 3 块/);
  assert.match(stats.lastMessages[0].content, /第一幕/);
});

test('extract tolerates JSON wrapped in prose and code fences', async () => {
  const response = await post('/api/series/extract', config({ model: 'fenced-json' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.data, { themes: ['记忆'] });
});

test('extract returns null data instead of failing on malformed JSON', async () => {
  const response = await post('/api/series/extract', config({ model: 'broken-json' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data, null);
  assert.ok(data.text.includes('themes'));
});

test('extract rejects refusals, truncation and empty content', async () => {
  for (const model of ['refusal', 'truncated', 'empty']) {
    const response = await post('/api/series/extract', config({ model }));
    assert.equal(response.status, 502, model);
    const data = await response.json();
    assert.ok(data.error.length > 0);
  }
});

test('extract surfaces upstream auth and rate-limit errors with diagnostics', async () => {
  const auth = await post('/api/series/extract', config({ model: 'bad-key' }));
  assert.equal(auth.status, 401);
  assert.equal((await auth.json()).diagnostic.category, 'auth');
  const limited = await post('/api/series/extract', config({ model: 'rate-limit' }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).diagnostic.category, 'rate_limit');
});

test('extract validates input length, emptiness and chunk metadata', async () => {
  assert.equal((await post('/api/series/extract', config({ input: '' }))).status, 400);
  assert.equal((await post('/api/series/extract', config({ input: 'x'.repeat(30001) }))).status, 400);
  assert.equal((await post('/api/series/extract', config({ chunkTotal: 0 }))).status, 400);
  assert.equal((await post('/api/series/extract', config({ chunkIndex: -1 }))).status, 400);
  assert.equal((await post('/api/series/extract', config({ chunkTotal: 500 }))).status, 400);
});

test('describe sends the image as an image_url part', async () => {
  const response = await post('/api/series/describe', config({
    role: 'character',
    image: 'data:image/png;base64,' + png.toString('base64'),
    context: '胶片摄影'
  }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.summary, '短黑发年轻男性');
  assert.equal(stats.imageParts, 1);
  assert.match(stats.lastMessages[0].content, /角色参考图/);
  const user = stats.lastMessages[1].content;
  assert.match(user[0].text, /胶片摄影/);
  assert.match(user[1].image_url.url, /^data:image\/png;base64,/);
});

test('describe rejects bad payloads and unsupported roles fall back to other', async () => {
  assert.equal((await post('/api/series/describe', config({ image: 'not-an-image' }))).status, 400);
  assert.equal((await post('/api/series/describe', config({ image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }))).status, 400);
  const response = await post('/api/series/describe', config({ role: 'nonsense', image: 'data:image/png;base64,' + png.toString('base64') }));
  assert.equal(response.status, 200);
  assert.match(stats.lastMessages[0].content, /一张参考图/);
});

test('outline validates frame count and returns shots', async () => {
  assert.equal((await post('/api/series/outline', config({ count: 0 }))).status, 400);
  assert.equal((await post('/api/series/outline', config({ count: 25 }))).status, 400);
  const response = await post('/api/series/outline', config({ count: 10, axes: [{ id: 'scene', label: '场景', values: ['邮局', '天桥'] }] }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.shots.length, 1);
  assert.match(stats.lastMessages[0].content, /拆成 10 帧/);
  assert.match(stats.lastMessages[0].content, /场景（scene）/);
  // The lore flag changes the instruction set: with lore, frames must be cut from it.
  assert.match(stats.lastMessages[0].content, /没有提供档案/);
  const withLore = await post('/api/series/outline', config({ count: 3, hasLore: true, loreTitles: ['信匣'], input: '档案原文' }));
  assert.equal(withLore.status, 200);
  assert.match(stats.lastMessages[0].content, /信匣/);
  assert.match(stats.lastMessages[0].content, /帧必须从其中取材/);
});

test('shot endpoint forwards axis values', async () => {
  const response = await post('/api/series/shot', config({ axisValues: { scene: '天桥', time: '雨夜' } }));
  assert.equal(response.status, 200);
  assert.match(stats.lastMessages[0].content, /scene=天桥/);
});

test('reduce accepts a larger payload and reports gallery awareness', async () => {
  const response = await post('/api/series/reduce', config({ input: 'x'.repeat(20000), hasGallery: true }));
  assert.equal(response.status, 200);
  assert.match(stats.lastMessages[0].content, /已上传参考图/);
});

test('series endpoints reject cross-site origins', async () => {
  const response = await fetch(appUrl + '/api/series/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify(config())
  });
  assert.equal(response.status, 403);
});
