'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Llm = require('../public/series-llm');

// ---------------------------------------------------------------- chunking

test('normalizes text without destroying paragraph structure', () => {
  const text = Llm.normalizeText('<p>第一段</p>\r\n\r\n\r\n\r\n第二段   \n');
  assert.equal(text, '第一段\n\n第二段');
});

test('splits long text into bounded chunks', () => {
  const source = Array.from({ length: 200 }, (_, index) => '第' + index + '段内容，' + '填充文字'.repeat(10) + '。').join('\n');
  const { chunks, total } = Llm.splitChunks(source);
  assert.ok(total > 1);
  assert.equal(chunks.length, total);
  for (const chunk of chunks) {
    assert.ok(chunk.chars <= Llm.CHUNK_TARGET + 200, 'chunk ' + chunk.index + ' is ' + chunk.chars);
    assert.ok(chunk.text.length > 0);
  }
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[total - 1].index, total - 1);
});

test('respects heading boundaries and carries the heading path', () => {
  // Sections are long enough to force their own chunk; short sections are merged on purpose.
  const body = '雨落在旧城的屋檐上，钠灯把水洼照成橙色。'.repeat(300);
  const source = '第一章 雨夜\n' + body + '\n\n第二章 天桥\n' + body;
  const { chunks } = Llm.splitChunks(source);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some(chunk => chunk.headingPath.includes('第一章 雨夜')));
  assert.ok(chunks.some(chunk => chunk.headingPath.includes('第二章 天桥')));
});

test('caps the number of chunks and reports truncation', () => {
  const source = '内容。'.repeat(130000);
  const { chunks, truncated } = Llm.splitChunks(source);
  assert.equal(truncated, true);
  assert.equal(chunks.length, Llm.MAX_CHUNKS);
});

test('returns nothing for empty input', () => {
  const result = Llm.splitChunks('   \n\n  ');
  assert.equal(result.total, 0);
  assert.deepEqual(result.chunks, []);
});

test('hard-splits a single paragraph larger than one chunk', () => {
  const source = '很长的句子。'.repeat(3000);
  const { chunks } = Llm.splitChunks(source);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.chars <= Llm.CHUNK_TARGET + 200);
});

// ---------------------------------------------------------------- cache key

test('cache key changes with input, model and prompt version', () => {
  const base = { input: 'abc', model: 'm', promptVersion: 1 };
  assert.equal(Llm.cacheKey(base), Llm.cacheKey({ ...base }));
  assert.notEqual(Llm.cacheKey(base), Llm.cacheKey({ ...base, input: 'abd' }));
  assert.notEqual(Llm.cacheKey(base), Llm.cacheKey({ ...base, model: 'm2' }));
  assert.notEqual(Llm.cacheKey(base), Llm.cacheKey({ ...base, promptVersion: 2 }));
  assert.notEqual(Llm.cacheKey(base), Llm.cacheKey({ ...base, gallerySignature: 'g' }));
});

// ---------------------------------------------------------------- validation

test('validates and clamps an extraction result', () => {
  const { ok, data } = Llm.validateExtraction({
    themes: ['记忆', '记忆', ''],
    visualClues: Array.from({ length: 20 }, (_, index) => '线索' + index),
    characters: [{ role: 'hero', name: '林野', traits: ['旧呢大衣'] }, { name: '', traits: [] }],
    mood: ['忧郁'],
    era: '近未来',
    paletteHints: ['钠灯橙'],
    taboos: [],
    notableLines: ['一句话']
  });
  assert.equal(ok, true);
  assert.deepEqual(data.themes, ['记忆']);
  assert.equal(data.visualClues.length, 10);
  assert.equal(data.characters.length, 1);
  assert.equal(data.characters[0].role, 'hero');
});

test('rejects an empty extraction so the chunk can be marked degraded', () => {
  const { ok, errors } = Llm.validateExtraction({ themes: [], visualClues: [] });
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
  assert.equal(Llm.validateExtraction(null).ok, false);
  assert.equal(Llm.validateExtraction([]).ok, false);
});

test('canon draft drops invalid hex colours instead of guessing', () => {
  const { ok, data } = Llm.validateCanonDraft({
    medium: '35mm 胶片摄影',
    lighting: { key: '硬光', ratio: '1:8' },
    palette: [{ name: '湿沥青', hex: '#1B1F24' }, { name: '坏色', hex: 'not-a-colour' }, { name: '', hex: '' }],
    terms: { hero: '林野', 'bad key!': 'x' },
    characterLook: '短黑发',
    negative: ['水印']
  });
  assert.equal(ok, true);
  assert.equal(data.medium, '35mm 胶片摄影');
  // A named colour with no valid hex is kept for its name, but its hex stays empty so the
  // UI can prompt for a real value instead of inventing one.
  assert.equal(data.palette.length, 2);
  assert.equal(data.palette[0].hex, '#1b1f24');
  assert.equal(data.palette[1].name, '坏色');
  assert.equal(data.palette[1].hex, '');
  assert.deepEqual(data.terms, { hero: '林野' });
});

test('canon draft with no usable field is rejected', () => {
  const { ok, errors } = Llm.validateCanonDraft({ medium: '', palette: [], lighting: {} });
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
});

test('outline validates shots and trims to the requested count', () => {
  const raw = {
    title: '雨夜邮差',
    beats: ['第一幕'],
    axes: [{ id: 'scene', label: '场景', values: ['邮局'] }],
    shots: Array.from({ length: 20 }, (_, index) => ({ code: 'S' + index, subject: '主体' + index, action: '动作', scene: '场景' }))
  };
  const { ok, data } = Llm.validateOutline(raw, 8);
  assert.equal(ok, true);
  assert.equal(data.shots.length, 8);
  assert.equal(data.axes.length, 1);
});

test('outline rejects a shot list with no usable frame', () => {
  assert.equal(Llm.validateOutline({ shots: [{ title: '空' }] }, 5).ok, false);
  assert.equal(Llm.validateOutline({ shots: [] }, 5).ok, false);
});

test('description requires a summary or appearance', () => {
  assert.equal(Llm.validateDescription({ summary: '短黑发' }).ok, true);
  assert.equal(Llm.validateDescription({ summary: '', appearance: '' }).ok, false);
  const { data } = Llm.validateDescription({ summary: 's', suggestedTerms: { hero: '林野', 'bad!': 'x' } });
  assert.deepEqual(data.suggestedTerms, { hero: '林野' });
});

// ---------------------------------------------------------------- merge

test('merges chunk extractions by frequency and keeps hero first', () => {
  const merged = Llm.mergeExtractions([
    { themes: ['记忆', '孤独'], characters: [{ name: '林野', role: 'supporting', traits: ['旧呢大衣'] }], era: '近未来', places: [], props: [], visualClues: [], mood: [], taboos: [], paletteHints: [], notableLines: [] },
    { themes: ['记忆'], characters: [{ name: '林野', role: 'hero', traits: ['左手有旧伤'] }, { name: '老邮差', role: '', traits: [] }], era: '近未来', places: [], props: [], visualClues: [], mood: [], taboos: [], paletteHints: [], notableLines: [] }
  ]);
  assert.deepEqual(merged.themes, ['记忆', '孤独']);
  assert.equal(merged.characters[0].name, '林野');
  assert.equal(merged.characters[0].role, 'hero');
  assert.deepEqual(merged.characters[0].traits.sort(), ['左手有旧伤', '旧呢大衣'].sort());
  assert.equal(merged.characters.length, 2);
  assert.equal(merged.era, '近未来');
});

// ---------------------------------------------------------------- orchestration

function fakeRequest(handler) {
  const calls = [];
  const request = async (route, body, signal) => {
    calls.push({ route, body });
    return handler(route, body, signal, calls.length - 1);
  };
  request.calls = calls;
  return request;
}

const chunkResult = index => ({
  text: JSON.stringify({ themes: ['主题' + index], visualClues: [], characters: [], places: [], props: [], mood: [], era: '', paletteHints: [], taboos: [], notableLines: [] }),
  data: { themes: ['主题' + index], visualClues: [], characters: [], places: [], props: [], mood: [], era: '', paletteHints: [], taboos: [], notableLines: [] },
  usage: { prompt_tokens: 10 }
});

const canonResult = {
  text: '{}',
  data: { medium: '胶片摄影', lighting: { key: '硬光' }, lens: {}, composition: {}, grade: {}, material: {}, palette: [], terms: {}, characterLook: '', atmosphere: '', negative: [], themes: [], mood: [], era: '', taboos: [] },
  usage: { prompt_tokens: 20 }
};

test('extract maps chunks, reports progress and reduces', async () => {
  const progress = [];
  const request = fakeRequest(route => (route === '/api/series/reduce' ? canonResult : chunkResult(0)));
  const llm = Llm.createSeriesLlm({ request, onProgress: event => progress.push(event), concurrency: 2 });
  const source = '第一章\n' + '内容。'.repeat(4000) + '\n第二章\n' + '更多内容。'.repeat(4000);
  const result = await llm.extract({ text: source, config: { apiKey: 'k' }, seriesId: 's1', model: 'm', promptVersion: 1 });
  assert.ok(result.cached === false);
  assert.ok(result.coverage.used >= 2);
  assert.equal(result.degraded.length, 0);
  assert.equal(result.canonDraft.medium, '胶片摄影');
  assert.ok(progress.some(event => event.phase === 'extract' && event.done === event.total));
  assert.ok(progress.some(event => event.phase === 'reduce'));
  const reduceCall = request.calls.find(call => call.route === '/api/series/reduce');
  assert.ok(reduceCall.body.input.includes('主题0'));
});

test('extract marks a failing chunk as degraded without aborting the run', async () => {
  let chunkCalls = 0;
  const request = fakeRequest((route, body) => {
    if (route === '/api/series/reduce') return canonResult;
    // Fail both the first attempt and its repair round for the very first chunk.
    if (chunkCalls < 2) { chunkCalls++; return { text: 'not json', data: null, usage: null }; }
    return chunkResult(1);
  });
  const llm = Llm.createSeriesLlm({ request, concurrency: 1 });
  const source = '段落。'.repeat(8000);
  const result = await llm.extract({ text: source, config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  assert.ok(result.degraded.length >= 1);
  assert.ok(result.coverage.used >= 1);
  assert.ok(result.coverage.used < result.coverage.total);
});

test('a malformed first answer triggers exactly one repair round', async () => {
  const request = fakeRequest((route, body) => {
    if (route === '/api/series/reduce') return canonResult;
    if (body.repair) return chunkResult(0);
    return { text: 'oops', data: null, usage: null };
  });
  const llm = Llm.createSeriesLlm({ request, concurrency: 1 });
  // A single chunk keeps the call count unambiguous: one extract + one repair + one reduce.
  const outcome = await llm.extract({ text: '一段素材。', config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  const repairs = request.calls.filter(call => call.body.repair);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].route, '/api/series/extract');
  assert.equal(outcome.degraded.length, 0);
  assert.equal(repairs[0].body.input, 'oops');
  assert.ok(repairs[0].body.problem.length > 0);
});

test('extract fails clearly when every chunk is unusable', async () => {
  const request = fakeRequest(() => ({ text: 'nope', data: null, usage: null }));
  const llm = Llm.createSeriesLlm({ request, concurrency: 1 });
  await assert.rejects(() => llm.extract({ text: '一段素材。', config: {}, seriesId: 's1', model: 'm', promptVersion: 1 }), /所有分块/);
});

test('extract returns the cached result without any model call', async () => {
  const request = fakeRequest(() => chunkResult(0));
  const cached = { chunks: [{ index: 0 }], result: { canonDraft: { medium: '缓存' }, degraded: [], coverage: { used: 1, total: 1 } } };
  const store = {
    getExtraction: async () => cached,
    putExtraction: async () => {}
  };
  const llm = Llm.createSeriesLlm({ request, store, concurrency: 1 });
  const outcome = await llm.extract({ text: '一段素材。', config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  assert.equal(outcome.cached, true);
  assert.equal(outcome.canonDraft.medium, '缓存');
  assert.equal(request.calls.length, 0);
});

test('extract writes the result to the cache on a cold run', async () => {
  const writes = [];
  const request = fakeRequest(route => (route === '/api/series/reduce' ? canonResult : chunkResult(0)));
  const store = { getExtraction: async () => null, putExtraction: async record => writes.push(record) };
  const llm = Llm.createSeriesLlm({ request, store, concurrency: 1 });
  await llm.extract({ text: '一段素材。', config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  // One record per chunk plus one final record that carries the reduced result.
  const finals = writes.filter(record => !record.parentKey);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].seriesId, 's1');
  assert.equal(finals[0].promptVersion, 1);
  assert.ok(writes.some(record => record.parentKey), 'chunk records should be cached too');
});

test('cancelling mid-run keeps finished chunks and resumes without re-calling them', async () => {
  const writes = [];
  let calls = 0;
  let abortedOnce = false;
  const request = (route, body, signal) => new Promise((resolve, reject) => {
    if (route === '/api/series/reduce') return resolve(canonResult);
    calls++;
    // The second call hangs until cancelled, which is what a paused run looks like.
    if (!abortedOnce && calls === 2) {
      signal.addEventListener('abort', () => {
        abortedOnce = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      return;
    }
    setTimeout(() => resolve(chunkResult(calls)), 2);
  });
  const store = {
    getExtraction: async id => writes.find(record => record.id === id) || null,
    putExtraction: async record => { writes.push(record); }
  };
  const llm = Llm.createSeriesLlm({ request, store, concurrency: 1 });
  const source = '段落。'.repeat(9000);
  const running = llm.extract({ text: source, config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  setTimeout(() => llm.cancel(), 30);
  await assert.rejects(() => running);

  const cachedChunks = writes.filter(record => record.parentKey);
  assert.ok(cachedChunks.length >= 1, 'at least one chunk should be cached before the abort');

  // A second run must reuse the cached chunks instead of paying for them again.
  const retry = Llm.createSeriesLlm({ request, store, concurrency: 1 });
  const result = await retry.extract({ text: source, config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  assert.ok(result.reused >= cachedChunks.length, 'reused ' + result.reused + ' of ' + cachedChunks.length);
});

test('reduce failure still yields merged data without a canon draft', async () => {
  const request = fakeRequest(route => {
    if (route === '/api/series/reduce') throw new Error('reduce 挂了');
    return chunkResult(0);
  });
  const llm = Llm.createSeriesLlm({ request, concurrency: 1 });
  const outcome = await llm.extract({ text: '一段素材。', config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  assert.equal(outcome.canonDraft, null);
  assert.ok(outcome.merged.themes.length > 0);
});

test('cancel aborts in-flight requests', async () => {
  let aborted = false;
  const request = (route, body, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  const llm = Llm.createSeriesLlm({ request, concurrency: 1 });
  const running = llm.extract({ text: '一段素材。', config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  setTimeout(() => llm.cancel(), 10);
  await assert.rejects(() => running);
  assert.equal(aborted, true);
});

test('describe and outline validate through the same repair path', async () => {
  const request = fakeRequest((route, body) => {
    if (route === '/api/series/describe') {
      return { text: '{"summary":"短黑发"}', data: { summary: '短黑发' }, usage: null };
    }
    return { text: '{"shots":[{"subject":"林野","action":"投递","scene":"邮局"}]}', data: { shots: [{ subject: '林野', action: '投递', scene: '邮局' }] }, usage: null };
  });
  const llm = Llm.createSeriesLlm({ request, concurrency: 1 });
  const described = await llm.describe({ image: 'data:image/png;base64,xx', role: 'character', context: '', config: {} });
  assert.equal(described.data.summary, '短黑发');
  const outlined = await llm.outline({ input: '素材', config: {}, count: 3, axes: [] });
  assert.equal(outlined.data.shots.length, 1);
  assert.equal(outlined.data.shots[0].code, 'S01');
});

test('concurrency never exceeds the configured limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const request = async route => {
    if (route === '/api/series/reduce') return canonResult;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    return chunkResult(0);
  };
  const llm = Llm.createSeriesLlm({ request, concurrency: 2 });
  await llm.extract({ text: '段落。'.repeat(8000), config: {}, seriesId: 's1', model: 'm', promptVersion: 1 });
  assert.ok(peak <= 2, 'peak concurrency was ' + peak);
});
