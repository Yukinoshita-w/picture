'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');
let app, optimizer, imageApi, appUrl, optimizerUrl, imageUrl;
const chatCalls = [], imageCalls = [];
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function post(route, extra = {}) {
  return fetch(appUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl: optimizerUrl + '/v1', apiKey: 'optimizer-secret', model: 'text-model', prompt: '画一只橘猫', ...extra })
  });
}
before(async () => {
  optimizer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    chatCalls.push({ path: req.url, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'text-model' }] }));
    if (body.model === 'denied') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'invalid optimizer-secret' } }));
    }
    if (body.model === 'empty') return res.end(JSON.stringify({ choices: [{ message: { content: '  ' } }] }));
    if (body.model === 'refusal') return res.end(JSON.stringify({ choices: [{ message: { refusal: 'no', content: null } }] }));
    if (body.model === 'long') return res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(10001) } }] }));
    if (body.model === 'truncated') return res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }] }));
    if (body.model === 'array') return res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '优化' }, { type: 'text', text: '内容' }] } }] }));
    res.end(JSON.stringify({ choices: [{ message: { content: ' 一只橘猫坐在窗边，柔和晨光，温暖色调，细腻毛发。 ' } }] }));
  });
  imageApi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    imageCalls.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ url: 'https://example.com/image.png' }] }));
  });
  optimizerUrl = await listen(optimizer);
  imageUrl = await listen(imageApi);
  app = createServer();
  appUrl = await listen(app);
});
after(async () => {
  for (const server of [app, optimizer, imageApi]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
test('optimization uses independent chat API, key and model without generating', async () => {
  const beforeImages = imageCalls.length;
  const response = await post('/api/optimize');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).prompt, '一只橘猫坐在窗边，柔和晨光，温暖色调，细腻毛发。');
  const call = chatCalls.at(-1);
  assert.equal(call.auth, 'Bearer optimizer-secret');
  assert.equal(call.path, '/v1/chat/completions');
  assert.equal(call.body.model, 'text-model');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.messages[1].content, '画一只橘猫');
  assert.match(call.body.messages[0].content, /本次优化强度：标准优化/);
  assert.equal(imageCalls.length, beforeImages);
});
test('strength changes editing scope while preserving subjects, instructions and API independence', async () => {
  const beforeImages = imageCalls.length;
  for (const [strength, prompt, scope] of [
    ['light', '两只雪豹，灰白皮毛，不要添加背景', /不要新增原文未提及的环境/],
    ['standard', '哑光黑耳机，保留品牌标识', /只增加少量与主题一致的中性细节/],
    ['rich', '咖啡 Logo，文字内容：“HELLO”，保持简洁', /允许围绕原主题扩展协调的场景/]
  ]) {
    const response = await post('/api/optimize', { strength, prompt });
    assert.equal(response.status, 200);
    const call = chatCalls.at(-1);
    assert.equal(call.body.messages[1].content, prompt);
    assert.match(call.body.messages[0].content, scope);
    assert.match(call.body.messages[0].content, /不要擅自替换主题、添加无关主体、改变身份或数量/);
    assert.match(call.body.messages[0].content, /不.*虚构参考图内容/);
    assert.equal(call.body.strength, undefined);
    assert.equal(call.body.model, 'text-model');
  }
  assert.equal(imageCalls.length, beforeImages);
});
test('generation never triggers optimization and uses current prompt verbatim', async () => {
  const beforeChats = chatCalls.length;
  const response = await post('/api/generate', { apiUrl: imageUrl + '/v1', apiKey: 'image-secret', model: 'image-model', prompt: '原始提示词不优化' });
  assert.equal(response.status, 200);
  assert.equal(chatCalls.length, beforeChats);
  assert.equal(imageCalls.at(-1).auth, 'Bearer image-secret');
  assert.equal(imageCalls.at(-1).body.prompt, '原始提示词不优化');
});
test('full chat URL preserves query and reference relationships use text metadata only', async () => {
  const response = await post('/api/optimize', { apiUrl: optimizerUrl + '/v1/chat/completions/?tenant=abc', referenceCount: 2 });
  assert.equal(response.status, 200);
  const call = chatCalls.at(-1);
  assert.equal(call.path, '/v1/chat/completions?tenant=abc');
  assert.match(call.body.messages[0].content, /2 张参考图/);
  assert.match(call.body.messages[0].content, /不要虚构/);
  assert.ok(call.body.messages.every(message => typeof message.content === 'string'));
});
test('optimization receives numbered reference guidance without image content', async () => {
  const response = await post('/api/optimize', {
    referenceCount: 2,
    referenceGuidance: [
      { purpose: 'person', preserve: '发型和外套颜色', change: '改为侧身姿势' },
      { purpose: 'custom', customPurpose: '材质', preserve: '金属纹理' }
    ]
  });
  assert.equal(response.status, 200);
  const instructions = chatCalls.at(-1).body.messages[0].content;
  assert.match(instructions, /参考图1（用途：人物）/);
  assert.match(instructions, /需要保留：发型和外套颜色/);
  assert.match(instructions, /参考图2（用途：材质）/);
  assert.match(instructions, /不.*声称看过图片/);
  assert.equal(chatCalls.at(-1).body.messages.every(message => typeof message.content === 'string'), true);
});
test('optimization receives canvas context without changing subject count or image API', async () => {
  const beforeImages = imageCalls.length;
  const response = await post('/api/optimize', { prompt: '两只雪豹 --ar 16:9 --no 水印', canvasSize: '1536x1024', imageCount: 4, referenceCount: 1 });
  assert.equal(response.status, 200);
  const call = chatCalls.at(-1);
  assert.equal(call.body.messages[1].content, '两只雪豹 --ar 16:9 --no 水印');
  const instructions = call.body.messages[0].content;
  assert.match(instructions, /当前页面画布尺寸为 1536x1024，比例为 3:2/);
  assert.match(instructions, /当前页面请求生成 4 张图片/);
  assert.match(instructions, /不能因此增减主体/);
  assert.match(instructions, /1 张参考图/);
  assert.equal(imageCalls.length, beforeImages);
});
test('optimizer test checks its own models endpoint without rewriting', async () => {
  const response = await post('/api/optimizer/test', { apiUrl: optimizerUrl + '/v1/chat/completions?tenant=abc' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).found, true);
  assert.equal(chatCalls.at(-1).path, '/v1/models?tenant=abc');
  assert.equal(chatCalls.at(-1).body, null);
});
test('optimizer accepts custom canvas dimensions and computes the actual aspect ratio', async () => {
  const response = await post('/api/optimize', { prompt: 'landscape', canvasSize: '2048x1152' });
  assert.equal(response.status, 200);
  assert.match(chatCalls.at(-1).body.messages[0].content, /当前页面画布尺寸为 2048x1152，比例为 16:9/);
  for (const canvasSize of ['1025x1024', '8193x1024', '0x1024', {}]) {
    assert.equal((await post('/api/optimize', { prompt: 'landscape', canvasSize })).status, 400);
  }
});
test('rejects invalid config and inputs before calling the optimizer', async () => {
  const beforeCount = chatCalls.length;
  for (const extra of [{ apiKey: '' }, { apiUrl: '' }, { model: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(10001) }, { strength: 'unknown' }, { strength: '' }, { strength: null }, { strength: {} }, { referenceCount: 5 }, { referenceCount: 0.5 }, { canvasSize: 'wrong' }, { imageCount: 5 }, { imageCount: 1.5 }]) {
    assert.equal((await post('/api/optimize', extra)).status, 400);
  }
  assert.equal(chatCalls.length, beforeCount);
});
test('invalid, refused, long and truncated outputs return errors instead of replacing text', async () => {
  for (const model of ['empty', 'refusal', 'long', 'truncated']) {
    const response = await post('/api/optimize', { model });
    assert.equal(response.status, 502);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const denied = await post('/api/optimize', { model: 'denied' });
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.json()).error.includes('optimizer-secret'));
});
test('supports structured text content', async () => {
  const response = await post('/api/optimize', { model: 'array' });
  assert.equal((await response.json()).prompt, '优化内容');
});
