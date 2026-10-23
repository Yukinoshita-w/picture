'use strict';
const http = require('node:http');
const { createServer } = require('../server');
const stats = { summaries: [], outlines: 0, generations: 0, failTail: false, hold: false };
const held = new Set();
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/stats') return send(res, 200, stats);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (url.pathname === '/control') {
    Object.assign(stats, body);
    if (body.release) { for (const finish of held) finish(); held.clear(); }
    return send(res, 200, { ok: true });
  }
  if (url.pathname.endsWith('/images/generations')) { stats.generations++; return send(res, 500, { error: { message: 'Browser test must not generate images' } }); }
  const system = body.messages?.[0]?.content || '';
  const input = body.messages?.[1]?.content || '';
  let output;
  if (system.includes('章节内容与情节事件')) {
    stats.summaries.push(input);
    if (stats.failTail && input.includes('末尾关键事件')) return send(res, 503, { error: { message: '模拟末段失败' } });
    const quote = input.includes('末尾关键事件') ? '末尾关键事件：邮差在桥头找到铜制信匣，帽子始终戴在头上。' : '开场事件：邮差带着信匣沿河岸启程。';
    output = { chapterTitle: input.includes('末尾关键事件') ? '第二章' : '第一章', summary: quote, events: [{ beat: quote, sourceQuote: quote, importance: 4 }] };
  } else if (system.includes('帧清单')) {
    stats.outlines++;
    const refs = [...new Set([...input.matchAll(/【(F\d+E\d+)】/g)].map(match => match[1]))];
    output = { shots: refs.map((sourceRef, index) => ({ code: 'S0' + (index + 1), title: index ? '找到信匣' : '沿河启程', subject: '邮差', action: index ? '在桥头找到铜制信匣' : '沿河岸启程', scene: index ? '桥头' : '河岸', detail: '帽子戴在头上', sourceRef, axisValues: {} })), axes: [] };
  } else return send(res, 500, { error: { message: 'Unexpected model task' } });
  const finish = () => { if (!res.destroyed) send(res, 200, { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }); };
  if (stats.hold) held.add(finish); else finish();
});
const app = createServer();
upstream.listen(0, '127.0.0.1', () => app.listen(0, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + upstream.address().port;
  console.log(JSON.stringify({ app: 'http://127.0.0.1:' + app.address().port, api: base + '/v1', stats: base + '/stats', control: base + '/control' }));
}));
