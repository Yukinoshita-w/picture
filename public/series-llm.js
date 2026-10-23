(function (root) {
  'use strict';

  // Client-side orchestration for the series model calls. The server forwards one request
  // at a time; chunking, concurrency, caching, repair and progress all live here so that a
  // closed tab cannot lose finished work and the UI can show real progress.

  const CHUNK_TARGET = 6000;
  const CHUNK_OVERLAP = 400;
  const MAX_CHUNKS = 60;
  const DEFAULT_CONCURRENCY = 2;

  function clean(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------- chunking

  const HEADING = /^(?:#{1,6}\s+|第[一二三四五六七八九十百零〇\d]+[章节回卷幕部]|【[^】]{1,40}】)/;

  function splitSourceFragments(input, { target = CHUNK_TARGET, maxFragments = 200 } = {}) {
    const source = String(input || '');
    if (!source.trim()) return { fragments: [], total: 0, truncated: false, source };
    const lineHeadings = [];
    let lineStart = 0;
    while (lineStart < source.length) {
      let lineEnd = source.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = source.length;
      const rawLine = source.slice(lineStart, lineEnd).replace(/\r$/, '');
      const heading = headingOf(rawLine);
      if (heading) lineHeadings.push({ start: lineStart, heading });
      lineStart = lineEnd + 1;
    }

    const sections = [];
    if (!lineHeadings.length) sections.push({ start: 0, end: source.length, headingPath: [] });
    else {
      if (source.slice(0, lineHeadings[0].start).trim()) sections.push({ start: 0, end: lineHeadings[0].start, headingPath: [] });
      lineHeadings.forEach((entry, index) => sections.push({
        start: entry.start,
        end: lineHeadings[index + 1]?.start ?? source.length,
        headingPath: [entry.heading]
      }));
    }

    const fragments = [];
    const addSection = section => {
      const length = section.end - section.start;
      if (length <= target) {
        if (source.slice(section.start, section.end).trim()) fragments.push({ ...section });
        return;
      }
      let offset = section.start;
      while (offset < section.end) {
        let end = Math.min(section.end, offset + target);
        if (end < section.end) {
          const floor = offset + Math.floor(target * 0.65);
          const breaks = [source.lastIndexOf('\n\n', end), source.lastIndexOf('。', end), source.lastIndexOf('！', end), source.lastIndexOf('？', end), source.lastIndexOf('. ', end)];
          const boundary = Math.max(...breaks.filter(index => index >= floor));
          if (boundary >= floor) end = boundary + (source[boundary] === '\n' ? 2 : 1);
        }
        while (end > offset && /\s/.test(source[end - 1])) end--;
        if (end <= offset) end = Math.min(section.end, offset + target);
        if (source.slice(offset, end).trim()) fragments.push({ start: offset, end, headingPath: section.headingPath.slice() });
        offset = end;
        while (offset < section.end && /\s/.test(source[offset])) offset++;
      }
    };
    for (const section of sections) addSection(section);

    const truncated = fragments.length > maxFragments;
    const kept = truncated ? fragments.slice(0, maxFragments) : fragments;
    return {
      fragments: kept.map((fragment, index) => ({
        ...fragment,
        index,
        id: 'F' + String(index + 1).padStart(3, '0'),
        text: source.slice(fragment.start, fragment.end),
        chars: fragment.end - fragment.start,
        total: kept.length
      })),
      total: kept.length,
      truncated,
      source
    };
  }

  function normalizeText(input) {
    return String(input || '')
      .replace(/\r\n?/g, '\n')
      .replace(/<[^>]{1,200}>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function headingOf(line) {
    const value = line.trim();
    if (!value || value.length > 60) return '';
    return HEADING.test(value) ? value.replace(/^#{1,6}\s+/, '').trim() : '';
  }

  // Splits on the strongest boundary available so a chunk rarely ends mid-sentence. The
  // overlap keeps cross-boundary context alive without duplicating whole paragraphs.
  function splitChunks(input, { target = CHUNK_TARGET, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS } = {}) {
    const text = normalizeText(input);
    if (!text) return { chunks: [], total: 0, truncated: false, normalized: '' };
    const paragraphs = [];
    let buffer = '';
    let headingPath = [];
    for (const rawLine of text.split('\n')) {
      const heading = headingOf(rawLine);
      if (heading) {
        if (buffer.trim()) { paragraphs.push({ text: buffer.trim(), headingPath: headingPath.slice() }); buffer = ''; }
        headingPath = headingPath.concat(heading).slice(-3);
        continue;
      }
      if (!rawLine.trim()) {
        if (buffer.trim()) { paragraphs.push({ text: buffer.trim(), headingPath: headingPath.slice() }); buffer = ''; }
        continue;
      }
      buffer += (buffer ? '\n' : '') + rawLine;
    }
    if (buffer.trim()) paragraphs.push({ text: buffer.trim(), headingPath: headingPath.slice() });

    const chunks = [];
    let current = '';
    let currentPath = [];
    const flush = () => {
      const value = current.trim();
      if (!value) return;
      chunks.push({ text: value, headingPath: currentPath.slice() });
      current = '';
    };
    for (const paragraph of paragraphs) {
      const piece = paragraph.text;
      if (piece.length > target) {
        flush();
        for (let offset = 0; offset < piece.length; offset += target - overlap) {
          const slice = piece.slice(offset, offset + target);
          if (slice.trim()) chunks.push({ text: slice.trim(), headingPath: paragraph.headingPath.slice() });
          if (offset + target >= piece.length) break;
        }
        continue;
      }
      if (current.length + piece.length + 1 > target) {
        const previous = current;
        flush();
        // Carry a tail of the previous chunk so a scene split across the boundary keeps context.
        const tail = previous.slice(Math.max(0, previous.length - overlap));
        current = (tail ? tail + '\n' : '') + piece;
        currentPath = paragraph.headingPath.slice();
      } else {
        current += (current ? '\n' : '') + piece;
        currentPath = paragraph.headingPath.slice();
      }
    }
    flush();

    const truncated = chunks.length > maxChunks;
    const kept = truncated ? chunks.slice(0, maxChunks) : chunks;
    return {
      chunks: kept.map((chunk, index) => ({ ...chunk, index, total: kept.length, chars: chunk.text.length })),
      total: kept.length,
      truncated,
      normalized: text
    };
  }

  // ---------------------------------------------------------------- hashing

  // Cached extractions must be invalidated by any input that would change the result.
  function cacheKey({ input, model, promptVersion, gallerySignature = '', serviceSignature = '' }) {
    let hash = 0x811c9dc5;
    const text = [String(input || ''), String(model || ''), String(promptVersion || ''), String(gallerySignature || ''), String(serviceSignature || '')].join('\u0000');
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'ext_' + hash.toString(16).padStart(8, '0') + '_' + text.length;
  }

  // ---------------------------------------------------------------- validation

  const ARRAY_LIMITS = {
    themes: 5, visualClues: 10, mood: 3, taboos: 5, notableLines: 3, paletteHints: 6,
    negative: 6, characters: 5, places: 5, props: 5, palette: 6
  };

  function text(value, limit = 80) {
    return clean(value).slice(0, limit);
  }

  function stringList(value, limit, itemLimit = 80) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => text(item, itemLimit)).filter(Boolean))].slice(0, limit);
  }

  function entityList(value, limit, traitLimit) {
    if (!Array.isArray(value)) return [];
    return value
      .map(item => ({
        name: text(item?.name, 40),
        role: ['hero', 'supporting', 'minor'].includes(item?.role) ? item.role : '',
        traits: stringList(item?.traits, traitLimit, 40)
      }))
      .filter(item => item.name || item.traits.length)
      .slice(0, limit);
  }

  function validateExtraction(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null, errors: ['输出不是 JSON 对象。'] };
    const data = {
      themes: stringList(raw.themes, ARRAY_LIMITS.themes),
      visualClues: stringList(raw.visualClues, ARRAY_LIMITS.visualClues),
      characters: entityList(raw.characters, ARRAY_LIMITS.characters, 8),
      places: entityList(raw.places, ARRAY_LIMITS.places, 6),
      props: entityList(raw.props, ARRAY_LIMITS.props, 6),
      mood: stringList(raw.mood, ARRAY_LIMITS.mood),
      era: text(raw.era, 60),
      paletteHints: stringList(raw.paletteHints, ARRAY_LIMITS.paletteHints, 40),
      taboos: stringList(raw.taboos, ARRAY_LIMITS.taboos),
      notableLines: stringList(raw.notableLines, ARRAY_LIMITS.notableLines, 200)
    };
    const errors = [];
    const empty = !data.themes.length && !data.visualClues.length && !data.characters.length && !data.places.length && !data.props.length;
    if (empty) errors.push('这一块没有提取到任何有效内容。');
    return { ok: errors.length === 0, data, errors };
  }

  function hexOf(value) {
    const match = String(value || '').trim().toLowerCase().match(/^#?([0-9a-f]{6})$/);
    return match ? '#' + match[1] : '';
  }

  // Palette hex values are dropped rather than guessed: a wrong colour is worse than no
  // colour, and the UI already offers a picker.
  function validateCanonDraft(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null, errors: ['风格草案不是 JSON 对象。'] };
    const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const lighting = object(raw.lighting);
    const lens = object(raw.lens);
    const composition = object(raw.composition);
    const grade = object(raw.grade);
    const material = object(raw.material);
    const palette = (Array.isArray(raw.palette) ? raw.palette : [])
      .map(item => ({ name: text(item?.name, 30), hex: hexOf(item?.hex), weight: Number(item?.weight) }))
      .filter(item => item.name || item.hex)
      .map((item, index, all) => ({ ...item, weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : Number((1 / all.length).toFixed(2)) }))
      .slice(0, 6);
    const terms = {};
    for (const [key, value] of Object.entries(object(raw.terms))) {
      const term = text(value, 40);
      if (term && /^[A-Za-z0-9_-]{1,40}$/.test(key)) terms[key] = term;
    }
    const data = {
      medium: text(raw.medium, 80),
      lighting: { key: text(lighting.key, 60), ratio: text(lighting.ratio, 20), direction: text(lighting.direction, 40), colorTemp: text(lighting.colorTemp, 40) },
      lens: { focal: text(lens.focal, 20), aperture: text(lens.aperture, 20), distance: text(lens.distance, 30), angle: text(lens.angle, 40) },
      composition: { frame: text(composition.frame, 30), placement: text(composition.placement, 40), negativeSpace: text(composition.negativeSpace, 40), horizon: text(composition.horizon, 30) },
      grade: { contrast: text(grade.contrast, 30), saturation: text(grade.saturation, 30), shadows: text(grade.shadows, 30), highlights: text(grade.highlights, 30) },
      material: { render: text(material.render, 40), texture: text(material.texture, 40), finish: text(material.finish, 40) },
      palette,
      terms,
      characterLook: text(raw.characterLook, 300),
      atmosphere: text(raw.atmosphere, 120),
      negative: stringList(raw.negative, ARRAY_LIMITS.negative),
      themes: stringList(raw.themes, ARRAY_LIMITS.themes),
      mood: stringList(raw.mood, ARRAY_LIMITS.mood),
      era: text(raw.era, 60),
      taboos: stringList(raw.taboos, ARRAY_LIMITS.taboos)
    };
    const filled = [data.medium, data.lighting.key, data.palette.length, data.characterLook, data.atmosphere].filter(Boolean).length;
    return { ok: filled > 0, data, errors: filled > 0 ? [] : ['风格草案为空，请检查文本模型输出。'] };
  }

  function validateOutline(raw, count, allowedSourceRefs = []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null, errors: ['帧清单不是 JSON 对象。'] };
    const shots = (Array.isArray(raw.shots) ? raw.shots : [])
      .map((item, index) => ({
        code: text(item?.code, 12) || 'S' + String(index + 1).padStart(2, '0'),
        title: text(item?.title, 24),
        beat: text(item?.beat, 60),
        subject: text(item?.subject, 80),
        action: text(item?.action, 120),
        scene: text(item?.scene, 80),
        detail: text(item?.detail, 200),
        loreTitle: text(item?.loreTitle, 60),
        sourceRef: text(item?.sourceRef, 48),
        axisValues: Object.fromEntries(Object.entries(item?.axisValues && typeof item.axisValues === 'object' ? item.axisValues : {}).slice(0, 8).map(([key, value]) => [text(key, 40), text(value, 60)]))
      }))
      .filter(item => item.subject || item.action || item.scene)
      .slice(0, count);
    const axes = (Array.isArray(raw.axes) ? raw.axes : [])
      .map(axis => ({ id: text(axis?.id, 40), label: text(axis?.label, 40), values: stringList(axis?.values, 24, 60) }))
      .filter(axis => axis.id && axis.values.length)
      .slice(0, 6);
    const data = { title: text(raw.title, 40), beats: stringList(raw.beats, 4, 80), axes, shots };
    const errors = shots.length ? [] : ['帧清单为空。'];
    if (allowedSourceRefs.length) {
      const allowed = new Set(allowedSourceRefs);
      let previous = -1;
      for (const [index, shot] of shots.entries()) {
        if (!allowed.has(shot.sourceRef)) errors.push('第 ' + (index + 1) + ' 帧缺少有效的原文来源标识。');
        const position = allowedSourceRefs.indexOf(shot.sourceRef);
        if (position >= 0 && position < previous) errors.push('第 ' + (index + 1) + ' 帧的来源顺序倒置，请按原文顺序拆帧。');
        previous = Math.max(previous, position);
      }
    }
    return { ok: errors.length === 0, data, errors };
  }

  function validateLoreSummary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null, errors: ['章节摘要不是 JSON 对象。'] };
    const events = (Array.isArray(raw.events) ? raw.events : []).map(item => ({
      beat: text(item?.beat, 180),
      sourceQuote: String(item?.sourceQuote || '').trim(),
      importance: Math.max(1, Math.min(5, Number(item?.importance) || 1))
    })).filter(item => item.beat && item.sourceQuote).slice(0, 16);
    const data = { chapterTitle: text(raw.chapterTitle, 80), summary: text(raw.summary, 900), events };
    const errors = [];
    if (!data.summary) errors.push('章节摘要为空。');
    if (!events.length) errors.push('没有可定位到原文的关键事件。');
    if (events.some(item => item.sourceQuote.length > 240)) errors.push('关键事件引用超过 240 字符，请选择完整且更短的原句。');
    return { ok: errors.length === 0, data, errors };
  }

  function validateShotFields(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null, errors: ['分帧结果不是 JSON 对象。'] };
    const data = { subject: text(raw.subject, 80), action: text(raw.action, 120), scene: text(raw.scene, 80), detail: text(raw.detail, 300) };
    const ok = Boolean(data.subject || data.action || data.scene);
    return { ok, data, errors: ok ? [] : ['分帧结果为空。'] };
  }

  function validateDescription(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null, errors: ['图片分析不是 JSON 对象。'] };
    const terms = {};
    for (const [key, value] of Object.entries(raw.suggestedTerms && typeof raw.suggestedTerms === 'object' ? raw.suggestedTerms : {})) {
      const term = text(value, 40);
      if (term && /^[A-Za-z0-9_-]{1,40}$/.test(key)) terms[key] = term;
    }
    const data = {
      summary: text(raw.summary, 120),
      appearance: text(raw.appearance, 400),
      palette: stringList(raw.palette, 5, 30),
      props: stringList(raw.props, 4, 40),
      suggestedTerms: terms,
      notes: stringList(raw.notes, 2, 120)
    };
    const ok = Boolean(data.summary || data.appearance);
    return { ok, data, errors: ok ? [] : ['图片分析为空。'] };
  }

  // ---------------------------------------------------------------- repair

  // A single repair round turns "almost JSON" into usable data without paying for a full
  // re-run; the server builds the actual repair messages from `problem` and `input`.
  function repairMessages({ original, problem }) {
    return { input: String(original || ''), problem: String(problem || '') };
  }

  function createSeriesLlm({ request, onProgress = () => {}, concurrency = DEFAULT_CONCURRENCY, store = null } = {}) {
    if (typeof request !== 'function') throw new Error('createSeriesLlm 需要 request 函数');

    let cancelled = false;
    const controllers = new Set();

    function cancel() {
      cancelled = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    }

    async function call(route, body, signal) {
      if (cancelled || signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      controllers.add(controller);
      try {
        return await request(route, body, controller.signal);
      } finally {
        controllers.delete(controller);
        signal?.removeEventListener('abort', abort);
      }
    }

    // One model call plus at most one repair round. Returns the parsed object or null.
    async function callJson(route, body, validate, signal) {
      const first = await call(route, body, signal);
      if (first.data) {
        const checked = validate(first.data);
        if (checked.ok) return { ...checked, usage: first.usage, repaired: false, raw: first.text };
      }
      const problem = first.data ? '字段缺失或内容为空，未通过结构校验。' : '输出不是合法的 JSON 对象。';
      const repaired = await call(route, { ...body, repair: true, problem, input: first.text }, signal);
      const checked = repaired.data ? validate(repaired.data) : { ok: false, data: null, errors: ['修复后仍无法解析。'] };
      return { ...checked, usage: repaired.usage, repaired: true, raw: first.text };
    }

    // Runs tasks with a bounded number in flight; results keep their input order. A cancel
    // must surface as a rejection: returning partial results would look like a successful
    // extraction that silently lost chunks.
    async function pool(items, limit, worker, signal) {
      const results = new Array(items.length);
      let cursor = 0;
      let failure = null;
      const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
          if (cancelled || failure) return;
          const index = cursor++;
          if (index >= items.length) return;
          try {
            results[index] = await worker(items[index], index);
          } catch (error) {
            if (error?.name === 'AbortError' || cancelled) { failure = failure || error; return; }
            results[index] = { error };
          }
        }
      });
      await Promise.all(runners);
      if (failure) throw failure;
      if (signal?.aborted || cancelled) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      return results;
    }

    // ---------------------------------------------------------------- extract

    // Chunk results are cached individually so a cancelled run can resume without paying
    // for the chunks that already succeeded.
    function chunkCacheKey(key, index) {
      return key + ':c' + index;
    }

    async function readChunkCache(key, index, seriesId) {
      if (!store || !seriesId) return null;
      const record = await store.getExtraction(chunkCacheKey(key, index)).catch(() => null);
      return record?.outcome?.ok ? record.outcome : null;
    }

    async function writeChunkCache(key, index, shotCount, seriesId, outcome) {
      if (!store || !seriesId || !outcome?.ok) return;
      await store.putExtraction({
        id: chunkCacheKey(key, index),
        seriesId,
        parentKey: key,
        chunkIndex: index,
        outcome,
        createdAt: Date.now()
      }).catch(() => {});
    }

    async function extract({ text: source, config, seriesId, gallerySignature = '', model, promptVersion, signal, onChunk = null }) {
      const prepared = splitChunks(source);
      if (!prepared.total) throw new Error('没有可提炼的文本内容。');
      const key = cacheKey({ input: prepared.normalized, model, promptVersion, gallerySignature });
      if (store && seriesId) {
        const cached = await store.getExtraction(key).catch(() => null);
        if (cached?.result) {
          onProgress({ phase: 'cache', done: prepared.total, total: prepared.total, cached: true });
          return { ...cached.result, cached: true, key, chunks: cached.chunks, truncated: prepared.truncated };
        }
      }

      const chunks = prepared.chunks;
      onProgress({ phase: 'extract', done: 0, total: chunks.length, cached: false });
      let done = 0;
      let reused = 0;
      const outcomes = await pool(chunks, concurrency, async chunk => {
        if (cancelled) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
        const hit = await readChunkCache(key, chunk.index, seriesId);
        if (hit) {
          done++;
          reused++;
          onProgress({ phase: 'extract', done, total: chunks.length, cached: false, reused });
          if (onChunk) onChunk({ chunk, outcome: hit, fromCache: true });
          return hit;
        }
        const outcome = await callJson('/api/series/extract', {
          ...config,
          input: chunk.text,
          chunkIndex: chunk.index,
          chunkTotal: chunk.total,
          headingPath: chunk.headingPath
        }, validateExtraction, signal);
        await writeChunkCache(key, chunk.index, chunks.length, seriesId, outcome);
        done++;
        onProgress({ phase: 'extract', done, total: chunks.length, cached: false, reused });
        if (onChunk) onChunk({ chunk, outcome });
        return outcome;
      }, signal);

      const collected = [];
      const degraded = [];
      chunks.forEach((chunk, index) => {
        const outcome = outcomes[index];
        if (outcome && outcome.ok) collected.push({ chunk, data: outcome.data });
        else degraded.push({ index: chunk.index, headingPath: chunk.headingPath, reason: outcome?.error?.message || outcome?.errors?.[0] || '提取失败' });
      });

      if (!collected.length) {
        throw new Error('所有分块都没有提取到有效内容。' + (degraded.length ? '首个错误：' + degraded[0].reason : ''));
      }

      // Reduce is a second model call, so it must be cancellable and reported separately.
      onProgress({ phase: 'reduce', done: collected.length, total: chunks.length, degraded: degraded.length, reused });
      const merged = mergeExtractions(collected.map(item => item.data));
      const reduceBody = { ...config, input: JSON.stringify(merged), hasGallery: Boolean(gallerySignature) };
      let reduced = null;
      try {
        const outcome = await callJson('/api/series/reduce', reduceBody, validateCanonDraft, signal);
        if (outcome.ok) reduced = outcome.data;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }

      const result = {
        canonDraft: reduced,
        merged,
        degraded,
        coverage: { used: collected.length, total: chunks.length },
        reused,
        truncated: prepared.truncated
      };
      if (store && seriesId) {
        await store.putExtraction({
          id: key,
          seriesId,
          model,
          promptVersion,
          gallerySignature,
          createdAt: Date.now(),
          chunks: chunks.map(chunk => ({ index: chunk.index, headingPath: chunk.headingPath, chars: chunk.chars })),
          result
        }).catch(() => {});
      }
      return { ...result, cached: false, key };
    }

    async function textServiceSignature(config) {
      const raw = [config?.apiUrl, config?.model, config?.apiKey].map(value => String(value || '')).join('\u0000');
      if (root.crypto?.subtle && root.TextEncoder) {
        const digest = await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(raw));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return cacheKey({ input: raw, promptVersion: 'service-config' });
    }

    async function summarizeLore({ chunks, config, seriesId, promptVersion = 'lore-summary-v1', signal }) {
      const serviceSignature = await textServiceSignature(config);
      let done = 0;
      let reused = 0;
      onProgress({ phase: 'summarize', done, total: chunks.length, reused });
      const outcomes = await pool(chunks, concurrency, async chunk => {
        if (cancelled) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
        const input = String(chunk.text || '');
        const key = cacheKey({
          input: [input, JSON.stringify(chunk.headingPath || [])].join('\u0000'),
          model: config?.model,
          promptVersion,
          serviceSignature
        });
        const cached = store && seriesId ? await store.getExtraction(key).catch(() => null) : null;
        if (cached?.outcome?.ok) {
          done++;
          reused++;
          onProgress({ phase: 'summarize', done, total: chunks.length, reused });
          return { chunk, outcome: cached.outcome, key, fromCache: true };
        }
        const validate = raw => {
          const checked = validateLoreSummary(raw);
          if (!checked.ok) return checked;
          const positions = checked.data.events.map(event => input.indexOf(event.sourceQuote));
          if (positions.some(position => position < 0)) return { ok: false, data: checked.data, errors: ['关键事件引用必须是本段原文中的连续原句。'] };
          checked.data.events.sort((a, b) => input.indexOf(a.sourceQuote) - input.indexOf(b.sourceQuote));
          return checked;
        };
        let outcome;
        try {
          outcome = await callJson('/api/series/summarize', {
            ...config,
            input,
            chunkIndex: chunk.index,
            chunkTotal: chunk.total,
            headingPath: chunk.headingPath || []
          }, validate, signal);
        } catch (error) {
          if (error?.name === 'AbortError' || cancelled) throw error;
          outcome = { ok: false, data: null, errors: [error?.message || '摘要请求失败。'] };
        }
        if (outcome.ok && store && seriesId) {
          await store.putExtraction({
            id: key,
            seriesId,
            model: config?.model,
            serviceSignature,
            promptVersion,
            chunkIndex: chunk.index,
            headingPath: chunk.headingPath || [],
            outcome,
            createdAt: Date.now()
          }).catch(() => {});
        }
        done++;
        onProgress({ phase: 'summarize', done, total: chunks.length, reused });
        return { chunk, outcome, key, fromCache: false };
      }, signal);
      return { outcomes, reused, serviceSignature };
    }

    async function describe({ image, role, context, config, signal }) {
      const outcome = await callJson('/api/series/describe', { ...config, image, role, context }, validateDescription, signal);
      return outcome;
    }

    async function outline({ input, config, count, axes, hasLore = false, loreTitles = [], sourceRefs = [], signal }) {
      const outcome = await callJson(
        '/api/series/outline',
        { ...config, input, count, axes, hasLore, loreTitles, sourceRefs },
        raw => validateOutline(raw, count, sourceRefs.map(item => item.id)),
        signal
      );
      return outcome;
    }

    async function shot({ input, config, axisValues, signal }) {
      const outcome = await callJson('/api/series/shot', { ...config, input, axisValues }, validateShotFields, signal);
      return outcome;
    }

    return { extract, summarizeLore, describe, outline, shot, cancel, splitChunks, cacheKey, get cancelled() { return cancelled; } };
  }

  // ---------------------------------------------------------------- merge

  function mergeExtractions(list) {
    const mergeStrings = key => {
      const counts = new Map();
      for (const item of list) {
        for (const value of item[key] || []) counts.set(value, (counts.get(value) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
    };
    const mergeEntities = key => {
      const byName = new Map();
      for (const item of list) {
        for (const entity of item[key] || []) {
          const name = entity.name || entity.traits[0] || '';
          if (!name) continue;
          const existing = byName.get(name) || { name, role: entity.role || '', traits: new Set() };
          if (entity.role === 'hero') existing.role = 'hero';
          for (const trait of entity.traits) existing.traits.add(trait);
          byName.set(name, existing);
        }
      }
      return [...byName.values()]
        .map(item => ({ name: item.name, role: item.role, traits: [...item.traits] }))
        .sort((a, b) => (a.role === 'hero' ? -1 : 0) - (b.role === 'hero' ? -1 : 0) || b.traits.length - a.traits.length);
    };
    const eras = new Map();
    for (const item of list) if (item.era) eras.set(item.era, (eras.get(item.era) || 0) + 1);
    return {
      themes: mergeStrings('themes'),
      visualClues: mergeStrings('visualClues'),
      characters: mergeEntities('characters'),
      places: mergeEntities('places'),
      props: mergeEntities('props'),
      mood: mergeStrings('mood'),
      taboos: mergeStrings('taboos'),
      paletteHints: mergeStrings('paletteHints'),
      notableLines: mergeStrings('notableLines'),
      era: [...eras.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    };
  }

  const api = {
    CHUNK_TARGET,
    CHUNK_OVERLAP,
    MAX_CHUNKS,
    DEFAULT_CONCURRENCY,
    normalizeText,
    splitChunks,
    splitSourceFragments,
    cacheKey,
    mergeExtractions,
    repairMessages,
    validateExtraction,
    validateCanonDraft,
    validateOutline,
    validateLoreSummary,
    validateShotFields,
    validateDescription,
    createSeriesLlm
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeriesLlm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
