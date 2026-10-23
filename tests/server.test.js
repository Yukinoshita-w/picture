'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, generationEndpoint } = require('../server');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
let upstream, app, apiUrl, appUrl, lastRequest;
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function post(route, body, extraHeaders = {}) {
  return fetch(appUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
}
function config(extra = {}) { return { apiUrl: apiUrl + '/v1', apiKey: 'test-secret', model: 'gpt-image-1', prompt: 'a tiny cat', n: 1, ...extra }; }
function customCapabilities(extra = {}) { return { mode: 'custom', sizes: [], qualities: [], responseFormats: [], maxCount: 1, maxReferences: 0, imageField: 'auto', ...extra }; }
before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const multipart = contentType.startsWith('multipart/form-data');
    const form = multipart ? await new Response(raw, { headers: { 'Content-Type': contentType } }).formData() : null;
    const text = multipart ? '' : raw.toString();
    lastRequest = { path: req.url, method: req.method, auth: req.headers.authorization, contentType, form, body: text ? JSON.parse(text) : null };
    if (req.url === '/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }));
    if (form?.get('model') === 'no-edit') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    }
    if (lastRequest.body?.model === 'bad-key') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Invalid key test-secret' } }));
    }
    if (lastRequest.body?.model === 'forbidden') {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: { code: 'model_not_allowed', message: 'Model is not allowed for this project' } }));
    }
    if (lastRequest.body?.model === 'rate-limit') {
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
    }
    if (lastRequest.body?.model === 'bad-param') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { code: 'invalid_request_error', message: 'The selected size is not supported' } }));
    }
    if (lastRequest.body?.model === 'non-json') return res.end('<html>wrong endpoint</html>');
    if (lastRequest.body?.model === 'empty') return res.end(JSON.stringify({ data: [] }));
    if (lastRequest.body?.model === 'unsafe') return res.end(JSON.stringify({ data: [{ url: 'javascript:alert(1)' }] }));
    if (lastRequest.body?.response_format === 'url') return res.end(JSON.stringify({ data: [{ url: apiUrl + '/image.png' }] }));
    res.end(JSON.stringify({ created: 123, data: [{ b64_json: png.toString('base64'), revised_prompt: 'tiny illustrated cat' }] }));
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
test('serves usable HTML, scripts, stylesheet and health', async () => {
  for (const route of ['/', '/app.js', '/model-capabilities.js', '/size-picker.js', '/generation-requirements.js', '/styles.css', '/api/health']) {
    const response = await fetch(appUrl + route);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
  }
  const response = await fetch(appUrl + '/');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('custom text-only service omits disabled parameters and capability metadata', async () => {
  const response = await post('/api/generate', config({ capabilities: customCapabilities(), size: 'default', quality: 'default', responseFormat: 'auto' }));
  assert.equal(response.status, 200);
  assert.deepEqual(lastRequest.body, { model: 'gpt-image-1', prompt: 'a tiny cat', n: 1 });
  const previous = lastRequest;
  for (const extra of [{ size: '1024x1024' }, { quality: 'high' }, { responseFormat: 'url' }, { n: 2 }, { references: [{ mime: 'image/png', b64_json: png.toString('base64') }] }]) {
    assert.equal((await post('/api/generate', config({ capabilities: customCapabilities(), ...extra }))).status, 400);
    assert.equal(lastRequest, previous);
  }
});
test('custom supported values override model-name guesses and preserve actual parameters', async () => {
  const capabilities = customCapabilities({ sizes: ['512x512'], qualities: ['hd'], responseFormats: ['url'], maxCount: 2 });
  const response = await post('/api/generate', config({ capabilities, n: 2, size: '512x512', quality: 'hd', responseFormat: 'url' }));
  assert.equal(response.status, 200);
  assert.deepEqual({ ...lastRequest.body, prompt: undefined }, { model: 'gpt-image-1', prompt: undefined, n: 2, size: '512x512', quality: 'hd', response_format: 'url' });
  assert.match(lastRequest.body.prompt, /^a tiny cat\n\n【本次生成要求】/);
  assert.match(lastRequest.body.prompt, /宽 512 像素 × 高 512 像素；宽高比 1:1/);
  assert.match(lastRequest.body.prompt, /高清画质（HD）/);
  assert.match(lastRequest.body.prompt, /2 张独立图片/);
  assert.ok((await response.json()).images[0].url);
  const previous = lastRequest;
  for (const extra of [{ size: '1024x1024' }, { quality: 'high' }, { responseFormat: 'b64_json' }, { n: 3 }]) {
    assert.equal((await post('/api/generate', config({ capabilities, ...extra }))).status, 400);
    assert.equal(lastRequest, previous);
  }
});
test('single reference can use image[] without quality, and reference count is enforced', async () => {
  const capabilities = customCapabilities({ maxReferences: 1, imageField: 'image[]' });
  const reference = { mime: 'image/png', b64_json: png.toString('base64') };
  assert.equal((await post('/api/generate', config({ capabilities, references: [reference] }))).status, 200);
  assert.equal(lastRequest.form.has('image'), false);
  assert.equal(lastRequest.form.has('quality'), false);
  assert.equal(lastRequest.form.has('size'), false);
  assert.equal(lastRequest.form.getAll('image[]').length, 1);
  assert.deepEqual(Buffer.from(await lastRequest.form.get('image[]').arrayBuffer()), png);
  const previous = lastRequest;
  assert.equal((await post('/api/generate', config({ capabilities, references: [reference, reference] }))).status, 400);
  assert.equal(lastRequest, previous);
});
test('custom pixel sizes require opt-in and preserve exact dimensions for generation and edits', async () => {
  const capabilities = customCapabilities({ customSizes: true, maxReferences: 1 });
  for (const size of ['2048x1152', '4096x4096', '2880x2880']) {
    assert.equal((await post('/api/generate', config({ capabilities, size }))).status, 200);
    assert.equal(lastRequest.body.size, size);
    assert.equal(Object.hasOwn(lastRequest.body, 'capabilities'), false);
  }
  const reference = { mime: 'image/png', b64_json: png.toString('base64') };
  assert.equal((await post('/api/generate', config({ capabilities, size: '2048x1152', references: [reference] }))).status, 200);
  assert.equal(lastRequest.form.get('size'), '2048x1152');
  assert.equal((await post('/api/generate', config({ capabilities, size: 'default' }))).status, 200);
  assert.equal(Object.hasOwn(lastRequest.body, 'size'), false);
  const previous = lastRequest;
  for (const size of ['0x1024', '63x1024', '8193x1024', '1025x1024', '1e3x1024', '2048X1152', 'auto']) {
    assert.equal((await post('/api/generate', config({ capabilities, size }))).status, 400);
    assert.equal(lastRequest, previous);
  }
  for (const override of [{ mode: 'auto' }, customCapabilities(), customCapabilities({ customSizes: 'true' })]) {
    assert.equal((await post('/api/generate', config({ capabilities: override, size: '2048x1152' }))).status, 400);
    assert.equal(lastRequest, previous);
  }
});
test('multiple references honor configured image or image[] and supported multipart parameters', async () => {
  const references = [1, 2].map(() => ({ mime: 'image/png', b64_json: png.toString('base64') }));
  for (const imageField of ['image', 'image[]']) {
    const capabilities = customCapabilities({ maxReferences: 2, imageField, sizes: ['1024x1024'], qualities: ['high'], responseFormats: ['b64_json'] });
    assert.equal((await post('/api/generate', config({ capabilities, references, size: '1024x1024', quality: 'high', responseFormat: 'b64_json' }))).status, 200);
    assert.equal(lastRequest.form.getAll(imageField).length, 2);
    assert.equal(lastRequest.form.has(imageField === 'image' ? 'image[]' : 'image'), false);
    assert.equal(lastRequest.form.get('size'), '1024x1024');
    assert.equal(lastRequest.form.get('quality'), 'high');
    assert.equal(lastRequest.form.get('response_format'), 'b64_json');
    assert.equal(lastRequest.form.has('capabilities'), false);
    for (const file of lastRequest.form.getAll(imageField)) assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  }
});
test('malformed capability configurations and unsupported automatic parameters never call upstream', async () => {
  const previous = lastRequest;
  for (const capabilities of [null, [], 'custom', { mode: 'invalid' }, customCapabilities({ sizes: ['invalid'] }), customCapabilities({ qualities: 'high' }), customCapabilities({ responseFormats: ['url', 'url'] }), customCapabilities({ maxCount: 0 }), customCapabilities({ maxReferences: 5 }), customCapabilities({ maxReferences: 1.5 }), customCapabilities({ imageField: 'file' })]) {
    assert.equal((await post('/api/generate', config({ capabilities }))).status, 400);
    assert.equal(lastRequest, previous);
  }
  for (const extra of [{ responseFormat: 'url' }, { model: 'DALL-E-3', n: 2 }, { model: 'dall-e-3', quality: 'high' }, { model: 'dall-e-2', size: '1536x1024' }]) {
    assert.equal((await post('/api/generate', config(extra))).status, 400);
    assert.equal(lastRequest, previous);
  }
});
test('normalizes base URLs and full endpoint with query parameters', () => {
  assert.equal(generationEndpoint('https://example.com/v1/').href, 'https://example.com/v1/images/generations');
  assert.equal(generationEndpoint('https://example.com/v1/images/generations?tenant=abc').href, 'https://example.com/v1/images/generations?tenant=abc');
  assert.equal(generationEndpoint('https://example.com/v1/images/edits?tenant=abc').href, 'https://example.com/v1/images/generations?tenant=abc');
});
test('generation settings are appended for both JSON and multipart without changing user content', async () => {
  const capabilities = customCapabilities({ customSizes: true, qualities: ['hd'], maxCount: 4, maxReferences: 1 });
  const prompt = '两只猫，水彩风格';
  for (const references of [[], [{ mime: 'image/png', b64_json: png.toString('base64'), purpose: 'composition', preserve: '主体位置' }]]) {
    const response = await post('/api/generate', config({ capabilities, prompt, references, size: '4096x2304', quality: 'hd', n: 3 }));
    assert.equal(response.status, 200);
    const sent = references.length ? lastRequest.form.get('prompt') : lastRequest.body.prompt;
    assert.ok(sent.startsWith(prompt));
    assert.match(sent, /宽 4096 像素 × 高 2304 像素；宽高比 16:9，横向画布/);
    assert.match(sent, /高清画质（HD）/);
    assert.match(sent, /3 张独立图片/);
    assert.match(sent, /主体数量保持原提示词要求/);
    assert.equal(sent.split('【本次生成要求】').length - 1, 1);
    if (references.length) assert.match(sent, /参考图1（用途：构图）/);
  }
  const previous = lastRequest;
  assert.equal((await post('/api/generate', config({ prompt: 'x'.repeat(9990), size: '1024x1024' }))).status, 400);
  assert.equal(lastRequest, previous);
});
test('sends real multipart file bytes and prompt to edits for a single reference', async () => {
  const response = await post('/api/generate', config({ references: [{ mime: 'image/png', b64_json: png.toString('base64') }], size: '1024x1024', quality: 'high' }));
  assert.equal(response.status, 200);
  assert.equal(lastRequest.path, '/v1/images/edits');
  assert.equal(lastRequest.auth, 'Bearer test-secret');
  assert.match(lastRequest.contentType, /^multipart\/form-data; boundary=/);
  assert.equal(lastRequest.form.get('model'), 'gpt-image-1');
  assert.match(lastRequest.form.get('prompt'), /^a tiny cat\r?\n\r?\n【本次生成要求】/);
  assert.match(lastRequest.form.get('prompt'), /宽 1024 像素 × 高 1024 像素；宽高比 1:1/);
  assert.match(lastRequest.form.get('prompt'), /高画质（high）/);
  assert.equal(lastRequest.form.get('n'), '1');
  assert.equal(lastRequest.form.get('quality'), 'high');
  assert.equal(lastRequest.form.get('size'), '1024x1024');
  assert.equal(lastRequest.form.has('response_format'), false);
  const file = lastRequest.form.get('image');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'reference-1.png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal((await response.json()).images[0].b64_json, png.toString('base64'));
});
test('adds numbered reference guidance to image edit prompt and rejects invalid guidance', async () => {
  const reference = { mime: 'image/png', b64_json: png.toString('base64'), purpose: 'composition', preserve: '主体位置', change: '背景改成夜景' };
  const response = await post('/api/generate', config({ references: [reference] }));
  assert.equal(response.status, 200);
  assert.match(lastRequest.form.get('prompt'), /参考图1（用途：构图）/);
  assert.match(lastRequest.form.get('prompt'), /需要修改：背景改成夜景/);
  const previous = lastRequest;
  for (const invalid of [
    { purpose: 'unknown' },
    { purpose: 'custom' },
    { purpose: 'person', preserve: 'x'.repeat(501) }
  ]) {
    assert.equal((await post('/api/generate', config({ references: [{ ...reference, ...invalid }] }))).status, 400);
    assert.equal(lastRequest, previous);
  }
});
test('multiple references use image[] and full endpoint preserves query parameters', async () => {
  const response = await post('/api/generate', config({ apiUrl: apiUrl + '/v1/images/generations?tenant=abc', references: [1, 2].map(() => ({ mime: 'image/png', b64_json: png.toString('base64') })) }));
  assert.equal(response.status, 200);
  assert.equal(lastRequest.path, '/v1/images/edits?tenant=abc');
  const files = lastRequest.form.getAll('image[]');
  assert.equal(files.length, 2);
  assert.equal(lastRequest.form.has('image'), false);
  for (const file of files) assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
});
test('reference uploads over old 64 KB limit are forwarded intact', async () => {
  const largePng = Buffer.concat([png, Buffer.alloc(70 * 1024)]);
  const response = await post('/api/generate', config({ references: [{ mime: 'image/png', b64_json: largePng.toString('base64') }] }));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await lastRequest.form.get('image').arrayBuffer()), largePng);
});
test('rejects invalid reference data, formats, counts and incompatible model', async () => {
  const valid = { mime: 'image/png', b64_json: png.toString('base64') };
  for (const extra of [
    { references: {} }, { references: [null] }, { references: Array(5).fill(valid) },
    { references: [{ mime: 'image/svg+xml', b64_json: valid.b64_json }] },
    { references: [{ ...valid, b64_json: 'broken!' }] },
    { references: [{ ...valid, b64_json: Buffer.from('fake').toString('base64') }] },
    { references: [{ ...valid, mime: 'image/jpeg' }] },
    { references: [valid], model: 'dall-e-3' }, { references: [valid], model: 'dall-e-2' }
  ]) assert.equal((await post('/api/generate', config(extra))).status, 400);
});
test('gives clear unsupported-edit error and empty references remain text-to-image', async () => {
  const response = await post('/api/generate', config({ model: 'no-edit', references: [{ mime: 'image/png', b64_json: png.toString('base64') }] }));
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /images\/edits/);
  assert.equal((await post('/api/generate', config({ references: [] }))).status, 200);
  assert.equal(lastRequest.path, '/v1/images/generations');
  assert.deepEqual(lastRequest.body, { model: 'gpt-image-1', prompt: 'a tiny cat', n: 1 });
});
test('enforces individual and combined reference size limits', async () => {
  const tooLarge = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]).toString('base64');
  const oneResponse = await post('/api/generate', config({ references: [{ mime: 'image/png', b64_json: tooLarge }] }));
  assert.equal(oneResponse.status, 400);
  assert.match((await oneResponse.json()).error, /10 MB/);
  const sevenMb = Buffer.concat([png, Buffer.alloc(7 * 1024 * 1024 - png.length)]).toString('base64');
  const totalResponse = await post('/api/generate', config({ references: Array(3).fill({ mime: 'image/png', b64_json: sevenMb }) }));
  assert.equal(totalResponse.status, 400);
  assert.match((await totalResponse.json()).error, /20 MB/);
});
test('oversized small API requests return JSON errors without dropping the connection', async () => {
  const response = await post('/api/test', config({ padding: 'x'.repeat(70 * 1024) }));
  assert.equal(response.status, 413);
  assert.equal(typeof (await response.json()).error, 'string');
});
test('forwards auth and GPT Image JSON, omitting incompatible defaults', async () => {
  const response = await post('/api/generate', config({ size: 'default', quality: 'default', responseFormat: 'auto' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.images[0].b64_json, png.toString('base64'));
  assert.equal(data.images[0].mime, 'image/png');
  assert.equal(data.images[0].revised_prompt, 'tiny illustrated cat');
  assert.equal(lastRequest.auth, 'Bearer test-secret');
  assert.equal(lastRequest.path, '/v1/images/generations');
  assert.deepEqual(lastRequest.body, { model: 'gpt-image-1', prompt: 'a tiny cat', n: 1 });
});
test('forwards selected parameters and accepts url results', async () => {
  const response = await post('/api/generate', config({ model: 'dall-e-3', size: '1792x1024', quality: 'hd', responseFormat: 'url' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).images[0].url, apiUrl + '/image.png');
  assert.equal(lastRequest.body.size, '1792x1024');
  assert.equal(lastRequest.body.quality, 'hd');
  assert.equal(lastRequest.body.response_format, 'url');
});
test('connection test uses real models request without generating', async () => {
  const response = await post('/api/test', config());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).found, true);
  assert.equal(lastRequest.path, '/v1/models');
  assert.equal(lastRequest.method, 'GET');
  assert.equal(lastRequest.body, null);
});
test('downloads remote image with correct bytes and attachment headers', async () => {
  const response = await post('/api/download', { url: apiUrl + '/image.png' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});
test('preserves upstream status and hides key in error messages', async () => {
  const response = await post('/api/generate', config({ model: 'bad-key' }));
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.ok(!data.error.includes('test-secret'));
  assert.match(data.error, /Invalid key/);
  assert.equal(data.diagnostic.category, 'auth');
  assert.match(data.diagnostic.suggestion, /API Key/);
  assert.ok(!JSON.stringify(data.diagnostic).includes('test-secret'));
});
test('diagnoses permission, rate limit, parameter, reference and network errors without leaking keys', async () => {
  const permission = await post('/api/generate', config({ model: 'forbidden' }));
  assert.equal(permission.status, 403);
  assert.equal((await permission.json()).diagnostic.category, 'permission');
  const limited = await post('/api/generate', config({ model: 'rate-limit' }));
  const limitedData = await limited.json();
  assert.equal(limited.status, 429);
  assert.equal(limitedData.diagnostic.category, 'rate_limit');
  assert.match(limitedData.diagnostic.suggestion, /频率/);
  assert.doesNotMatch(limitedData.diagnostic.suggestion, /余额|额度/);
  const parameter = await post('/api/generate', config({ model: 'bad-param' }));
  assert.equal(parameter.status, 400);
  assert.equal((await parameter.json()).diagnostic.category, 'parameter');
  const reference = await post('/api/generate', config({ model: 'no-edit', references: [{ mime: 'image/png', b64_json: png.toString('base64') }] }));
  assert.equal(reference.status, 404);
  assert.equal((await reference.json()).diagnostic.category, 'reference');
  const network = await post('/api/generate', config({ apiUrl: 'http://127.0.0.1:1/v1' }));
  const networkData = await network.json();
  assert.equal(network.status, 502);
  assert.equal(networkData.diagnostic.category, 'network');
  assert.ok(!JSON.stringify(networkData).includes('test-secret'));
});
test('rejects unsupported body values before calling upstream', async () => {
  for (const extra of [{ prompt: ' ' }, { apiKey: '' }, { n: 5 }, { n: 1.5 }, { model: 'dall-e-3', n: 2 }, { size: 'evil' }, { quality: 'evil' }, { apiUrl: 'file:///etc' }]) {
    const response = await post('/api/generate', config(extra));
    assert.equal(response.status, 400);
  }
});
test('fails clearly for non-JSON, empty data and unsafe image URLs', async () => {
  for (const model of ['non-json', 'empty', 'unsafe']) {
    const response = await post('/api/generate', config({ model }));
    assert.ok(response.status >= 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});
test('rejects cross-site requests and never exposes server source', async () => {
  assert.equal((await post('/api/generate', config(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(appUrl + '/server.js')).status, 404);
  assert.equal((await fetch(appUrl + '/%2e%2e%5cserver.js')).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(appUrl + '/api/health', { headers: { Host: 'evil.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(status, 403);
});
test('cancels delayed upstream generation and optimization on timeout', async () => {
  const aborted = [];
  const delayedUpstream = http.createServer(async (req, res) => {
    let closed = false;
    res.on('close', () => {
      if (!res.writableEnded) { closed = true; aborted.push(req.url); }
    });
    for await (const _ of req) { /* consume request before waiting */ }
    await new Promise(resolve => setTimeout(resolve, 180));
    if (closed || res.destroyed) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/chat/completions')
      ? { choices: [{ message: { content: 'late optimization' } }] }
      : { data: [{ b64_json: png.toString('base64') }] }));
  });
  const delayedUrl = await listen(delayedUpstream);
  const timeoutApp = createServer({ requestTimeoutMs: 25 });
  const timeoutUrl = await listen(timeoutApp);
  try {
    const imageResponse = await fetch(timeoutUrl + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config({ apiUrl: delayedUrl + '/v1', prompt: 'wait for image' }))
    });
    assert.equal(imageResponse.status, 504);
    assert.match((await imageResponse.json()).error, /超时/);
    const optimizeResponse = await fetch(timeoutUrl + '/api/optimize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUrl: delayedUrl + '/v1', apiKey: 'optimizer-secret', model: 'text-model', prompt: 'wait for text' })
    });
    assert.equal(optimizeResponse.status, 504);
    assert.match((await optimizeResponse.json()).error, /超时/);
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 500;
      const check = () => aborted.length >= 2 ? resolve() : Date.now() >= deadline ? reject(new Error('upstream requests were not aborted')) : setTimeout(check, 10);
      check();
    });
    assert.ok(aborted.some(path => path.endsWith('/images/generations')));
    assert.ok(aborted.some(path => path.endsWith('/chat/completions')));
  } finally {
    timeoutApp.closeAllConnections();
    delayedUpstream.closeAllConnections();
    await Promise.all([new Promise(resolve => timeoutApp.close(resolve)), new Promise(resolve => delayedUpstream.close(resolve))]);
  }
});

test('derives the chat path from an image base URL', () => {
  const { chatEndpoint, generationEndpoint } = require('../server');
  const cases = [
    ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/images/generations', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/images/edits', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
    // Query parameters are preserved, matching the existing endpoint helpers.
    ['https://api.example.com/v1/chat/completions?api-version=2', 'https://api.example.com/v1/chat/completions?api-version=2']
  ];
  for (const [input, expected] of cases) {
    assert.equal(chatEndpoint(input).toString(), expected, input);
  }
  // The generation path keeps working as before.
  assert.equal(generationEndpoint('https://api.example.com/v1/images/edits').toString(), 'https://api.example.com/v1/images/generations');
  assert.throws(() => chatEndpoint('ftp://example.com/v1'), /http/);
});
