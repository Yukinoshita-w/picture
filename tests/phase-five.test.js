'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Llm = require('../public/series-llm');
const Engine = require('../public/series-engine');
const canon = { version: 1, anchorSentence: '水彩绘画' };
const config = { apiUrl: 'http://local.test/v1', apiKey: 'test-secret', model: 'text-test' };
const response = data => ({ data, text: JSON.stringify(data) });

test('原文范围保留 CRLF、标题、后半段和所有非空白字符', () => {
  const source = '# 第一章\r\n' + '开场细节。'.repeat(1700) + '\r\n# 第二章\r\n后半段关键事件：邮差在桥头找到铜制信匣。';
  const result = Llm.splitSourceFragments(source);
  assert.equal(result.truncated, false);
  assert(result.fragments.at(-1).text.includes('桥头找到铜制信匣'));
  assert(result.fragments.some(fragment => fragment.headingPath.includes('第二章')));
  for (const fragment of result.fragments) assert.equal(source.slice(fragment.start, fragment.end), fragment.text);
  assert.equal(result.fragments.map(fragment => fragment.text).join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
});

test('片段超限会明确报告，原文不会被修改', () => {
  const source = '文字'.repeat(100);
  const result = Llm.splitSourceFragments(source, { target: 20, maxFragments: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.source, source);
});

test('确认摘录完整进入提示词，旧引用及失效引用阻止生成', () => {
  const excerpt = '不可删除的角色约束。'.repeat(150);
  const text = '开头。' + excerpt + '末尾。';
  const shot = { subject: '邮差', loreRefs: ['l1'], loreSelections: [{ loreId: 'l1', start: 3, end: 3 + excerpt.length, text: excerpt }] };
  const lore = [{ id: 'l1', title: '设定原文', text }];
  const compiled = Engine.compileShot({ canon, shot, lore });
  assert(compiled.prompt.includes(excerpt));
  assert.equal(compiled.loreExcerpts[0].text, excerpt);
  assert(compiled.warnings.some(warning => warning.includes('未截断')));
  assert.equal(compiled.blocked, false);
  assert.equal(Engine.compileShot({ canon, shot: { ...shot, loreSelections: [] }, lore }).blocked, true);
  assert.equal(Engine.compileShot({ canon, shot: { ...shot, loreSelections: [{ loreId: 'l1', pending: true }] }, lore }).blocked, true);
  assert.equal(Engine.compileShot({ canon, shot, lore: [{ ...lore[0], text: '已修改' }] }).blocked, true);
  assert.equal(Engine.compileShot({ canon, shot, lore: [] }).blocked, true);
});

test('摘录过长保留全文与约束并报告超限', () => {
  const text = '约束'.repeat(6000) + '必须保留的末尾';
  const shot = { subject: '主体', detail: '主体细节', loreRefs: ['l1'], loreSelections: [{ loreId: 'l1', start: 0, end: text.length, text }] };
  const result = Engine.compileShot({ canon, shot, lore: [{ id: 'l1', text }] });
  assert.equal(result.overLimit, true);
  assert(result.prompt.includes(text));
  assert(result.prompt.includes('主体细节'));
  assert(!result.warnings.some(warning => warning.includes('自动精简')));
});

test('来源 ID 必须有效且按原文顺序排列', () => {
  const shot = sourceRef => ({ subject: '邮差', sourceRef });
  assert.equal(Llm.validateOutline({ shots: [shot('E1'), shot('E2')] }, 2, ['E1', 'E2']).ok, true);
  assert.equal(Llm.validateOutline({ shots: [shot('E2'), shot('E1')] }, 2, ['E1', 'E2']).ok, false);
  assert.equal(Llm.validateOutline({ shots: [shot('invented')] }, 1, ['E1']).ok, false);
});

test('部分摘要失败可重试并复用成功缓存，配置和原文改变会失效', async () => {
  const cache = new Map();
  const store = { getExtraction: async key => cache.get(key), putExtraction: async record => cache.set(record.id, record) };
  const calls = [];
  let fail = true;
  const chunks = ['邮差启程，沿着河岸步行。', '末尾结局：邮差在桥头找到铜制信匣。'].map((text, index) => ({ text, index, total: 2, headingPath: ['章节 ' + index] }));
  const request = async (route, body) => {
    calls.push(body.input);
    if (body.chunkIndex === 1 && fail) throw new Error('模拟片段失败');
    return response({ summary: body.input, events: [{ beat: body.input, sourceQuote: body.input, importance: 4 }] });
  };
  const run = (nextConfig = config, nextChunks = chunks) => Llm.createSeriesLlm({ request, store }).summarizeLore({ chunks: nextChunks, config: nextConfig, seriesId: 's1' });
  const first = await run();
  assert.equal(first.outcomes[0].outcome.ok, true);
  assert.equal(first.outcomes[1].outcome.ok, false);
  fail = false;
  const second = await run();
  assert.equal(second.reused, 1);
  assert.equal(calls.length, 3);
  assert(second.outcomes.every(record => record.outcome.ok));
  assert.equal((await run()).reused, 2);
  for (const changed of [{ ...config, apiUrl: 'http://other.test/v1' }, { ...config, model: 'other' }, { ...config, apiKey: 'another-secret' }]) {
    assert.equal((await run(changed)).reused, 0);
  }
  const modified = chunks.map((chunk, index) => index ? { ...chunk, text: chunk.text + '修改后。' } : chunk);
  assert.equal((await run(config, modified)).reused, 1);
  assert(!JSON.stringify([...cache.values()]).includes('test-secret'));
});

test('摘要引句逐字校验，换行保留，虚构及过长引句不被接受', async () => {
  const text = '第一行原句。\r\n第二行原句。';
  const summary = quote => response({ summary: '摘要', events: [{ beat: '事件', sourceQuote: quote, importance: 3 }] });
  const run = quote => Llm.createSeriesLlm({ request: async () => summary(quote) }).summarizeLore({ chunks: [{ text, index: 0, total: 1 }], config, seriesId: 's1' });
  assert.equal((await run(text)).outcomes[0].outcome.data.events[0].sourceQuote, text);
  assert.equal((await run('原文没有这句话。')).outcomes[0].outcome.ok, false);
  assert.equal(Llm.validateLoreSummary({ summary: '摘要', events: [{ beat: '事件', sourceQuote: '字'.repeat(241) }] }).ok, false);
});

test('系列包导入重映射摘录 ID，范围与全文保留', () => {
  const text = '角色不得摘下帽子。';
  const series = { id: 's1', title: '系列', canon };
  const shot = { id: 'shot1', seriesId: 's1', subject: '角色', loreRefs: ['l1'], loreSelections: [{ loreId: 'l1', start: 0, end: text.length, text }] };
  const payload = Engine.exportSeries({ series, shots: [shot], lore: [{ id: 'l1', seriesId: 's1', text }] });
  const restored = Engine.normalizeImportedSeries(payload, { newId: 'imported2' });
  assert.equal(restored.shots[0].loreSelections[0].loreId, restored.lore[0].id);
  const compiled = Engine.compileShot({ canon, shot: restored.shots[0], lore: restored.lore });
  assert.equal(compiled.blocked, false);
  assert(compiled.prompt.includes(text));
  assert.equal(restored.lore[0].text, text);
});
