(function (root) {
  'use strict';

  // The series compiler. Deliberately deterministic: the same canon + shot + gallery
  // must always render the same prompt string, because series consistency depends on
  // the anchor block being byte-identical across every frame.
  const { formatReferenceGuidance, referencedIndexes } = typeof module === 'object' && module.exports
    ? require('./reference-guidance')
    : root.ReferenceGuidance;

  const PROMPT_LIMIT = 10000;
  const ANCHOR_POSITION = 'first';
  const MAX_REFERENCES = 4;

  const BUDGET = { anchor: 2500, shot: 3000, lore: 1200, negative: 400, guidance: 600 };
  const BUDGET_TARGET = { anchor: 700, shot: 700, lore: 900, negative: 120, guidance: 480 };

  const SLOT_ORDER = ['character', 'style', 'scene', 'prop', 'previous'];
  const SLOT_LABELS = { character: '角色锚点', style: '风格锚点', scene: '场景参考', prop: '道具参考', previous: '相邻帧' };

  // Preserve/change guidance is derived from the slot, not typed by the user every time.
  const SLOT_GUIDANCE = {
    character: { purpose: 'person', preserve: '面部特征、发型、体型与服装结构', change: '姿态、表情与所处场景' },
    style: { purpose: 'style', preserve: '色板、光比、调色、颗粒与材质质感', change: '主体与构图' },
    scene: { purpose: 'composition', preserve: '空间结构、材质与标志物', change: '光线时段与画面中的人物' },
    prop: { purpose: 'product', preserve: '外形、标识与材质', change: '摆放方式与光线' },
    previous: { purpose: 'composition', preserve: '镜头、景别与机位', change: '主体动作与场景' }
  };

  const AXIS_LIMIT = 200;

  function clean(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function list(value, limit = 12) {
    if (!Array.isArray(value)) return [];
    return value.map(clean).filter(Boolean).slice(0, limit);
  }

  function clamp(text, limit) {
    const value = clean(text);
    if (value.length <= limit) return value;
    return value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
  }

  function hex(value) {
    const text = clean(value).toLowerCase();
    return /^#[0-9a-f]{6}$/.test(text) ? text : '';
  }

  // ---------------------------------------------------------------- canon render

  // Renders the anchor sentence from canon fields. This is the single place that turns
  // structured data into the frozen string, so two frames can never disagree.
  function renderAnchor(canon) {
    const value = canon && typeof canon === 'object' ? canon : {};
    const parts = [];
    const medium = clean(value.medium);
    const material = value.material || {};
    if (medium) parts.push(medium);
    if (clean(material.render) && clean(material.render) !== medium) parts.push(clean(material.render));

    const palette = Array.isArray(value.palette) ? value.palette.map(item => clean(item?.name)).filter(Boolean) : [];
    if (palette.length) parts.push(palette.slice(0, 5).join('、') + '的配色');

    const lighting = value.lighting || {};
    const lightParts = [clean(lighting.key), clean(lighting.ratio), clean(lighting.direction)].filter(Boolean);
    if (lightParts.length) parts.push(lightParts.join('，'));
    if (clean(lighting.colorTemp)) parts.push('色温 ' + clean(lighting.colorTemp));

    const grade = value.grade || {};
    const gradeParts = [clean(grade.contrast), clean(grade.saturation), clean(grade.shadows), clean(grade.highlights)].filter(Boolean);
    if (gradeParts.length) parts.push(gradeParts.join('，'));

    const lens = value.lens || {};
    const lensParts = [clean(lens.focal), clean(lens.aperture), clean(lens.distance), clean(lens.angle)].filter(Boolean);
    if (lensParts.length) parts.push(lensParts.join('，'));

    const composition = value.composition || {};
    const frameParts = [clean(composition.frame), clean(composition.placement), clean(composition.negativeSpace), clean(composition.horizon)].filter(Boolean);
    if (frameParts.length) parts.push(frameParts.join('，'));

    if (clean(material.texture)) parts.push(clean(material.texture));
    if (clean(material.finish)) parts.push(clean(material.finish));
    if (clean(value.characterLook)) parts.push('角色外观：' + clean(value.characterLook));
    if (clean(value.atmosphere)) parts.push(clean(value.atmosphere));

    const sentence = parts.map(part => (/[。，；、]$/.test(part) ? part : part + '，')).join('').replace(/，+$/, '') + '。';
    return sentence.replace(/^[，。]+/, '');
  }

  // Terms are applied to the frame text only. The anchor block stays frozen so that
  // editing a term cannot silently change every already-approved frame's anchor.
  // Only explicit {{term}} placeholders are substituted; bare word replacement would
  // corrupt ordinary prose such as "city" inside a longer sentence.
  function applyTerms(text, terms) {
    let value = clean(text);
    if (!terms || typeof terms !== 'object') return value;
    for (const [key, term] of Object.entries(terms)) {
      const target = clean(term);
      if (!target) continue;
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      value = value.replace(new RegExp('\\{\\{\\s*' + escaped + '\\s*\\}\\}', 'g'), target);
    }
    return value;
  }

  // Reports placeholders that were used but never defined, so the UI can warn before
  // the user sends a prompt containing literal "{{hero}}" to the image model.
  function unresolvedTerms(text) {
    const found = new Set();
    const pattern = /\{\{\s*([A-Za-z0-9_-]{1,40})\s*\}\}/g;
    let match;
    const value = String(text || '');
    while ((match = pattern.exec(value)) !== null) found.add(match[1]);
    return [...found];
  }

  // ---------------------------------------------------------------- shot section

  function renderShotSection(shot, canon) {
    const value = shot && typeof shot === 'object' ? shot : {};
    const terms = canon?.terms;
    const parts = [];
    const subject = clean(value.subject);
    if (subject) parts.push('主体：' + applyTerms(subject, terms));
    const action = clean(value.action);
    if (action) parts.push('动作：' + applyTerms(action, terms));
    const scene = clean(value.scene);
    if (scene) parts.push('场景：' + applyTerms(scene, terms));
    const detail = clean(value.detail);
    if (detail) parts.push(applyTerms(detail, terms));
    const note = clean(value.overrides?.note);
    if (note) parts.push('本帧差异：' + applyTerms(note, terms));
    return parts.length ? parts.join('；') + '。' : '';
  }

  function renderNegative(canon, shot) {
    const base = list(canon?.negative, 12);
    const extra = list(shot?.negative, 8);
    const merged = [...new Set([...base, ...extra])].slice(0, 8);
    return merged.length ? '避免' + merged.join('、') + '。' : '';
  }

  // ---------------------------------------------------------------- references

  function normalizeSlot(value) {
    const slot = clean(value);
    return SLOT_ORDER.includes(slot) ? slot : 'style';
  }

  // Picks at most four images in a fixed priority order, so two shots that reference the
  // same set always upload them in the same order and the server numbering stays stable.
  function assembleReferences(shot, gallery) {
    const requested = Array.isArray(shot?.references) ? shot.references : [];
    const assets = Array.isArray(gallery) ? gallery : [];
    const byId = new Map(assets.map(asset => [asset?.id, asset]));
    const chosen = [];
    const seen = new Set();
    const dropped = [];
    const candidates = requested.map(entry => ({
      slot: normalizeSlot(entry?.slot),
      asset: byId.get(entry?.assetId),
      entry
    })).filter(item => item.asset);
    candidates.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    for (const item of candidates) {
      if (seen.has(item.asset.id)) continue;
      if (chosen.length >= MAX_REFERENCES) { dropped.push(item.asset.id); continue; }
      seen.add(item.asset.id);
      const defaults = SLOT_GUIDANCE[item.slot] || SLOT_GUIDANCE.style;
      const entry = item.entry || {};
      chosen.push({
        assetId: item.asset.id,
        slot: item.slot,
        purpose: clean(entry.purpose) || defaults.purpose,
        customPurpose: clean(entry.customPurpose),
        preserve: clamp(entry.preserve || defaults.preserve, 120),
        change: clamp(entry.change || defaults.change, 120)
      });
    }
    return { references: chosen, dropped };
  }

  // ---------------------------------------------------------------- compile

  function estimateBudget(prompt) {
    return clean(prompt).length;
  }

  // Trims the frame section by dropping whole trailing clauses, never mid-sentence. The
  // anchor block is never trimmed; an over-long canon is reported instead of silently cut.
  function trimShotSection(section, overBy) {
    let value = clean(section);
    if (overBy <= 0) return value;
    const target = Math.max(0, value.length - overBy);
    const clauses = value.split(/(?<=[。；])/).map(clean).filter(Boolean);
    // Keep at least one clause: a frame with no description at all is worse than a long one.
    while (clauses.length > 1 && value.length > target) {
      clauses.pop();
      value = clauses.join('');
    }
    return value;
  }

  function compileShot({ canon, shot, gallery = [], lore = [], size, quality, n = 1, limit = PROMPT_LIMIT, requirements }) {
    const warnings = [];
    const anchor = clean(canon?.anchorSentence) || renderAnchor(canon || {});
    if (!anchor) warnings.push('风格圣经缺少可编译的锚点内容，请至少填写媒介、光线或色板。');
    if (anchor.length > BUDGET.anchor) warnings.push('锚点块超过 ' + BUDGET.anchor + ' 字符，建议精简风格圣经。');

    const { references, dropped } = assembleReferences(shot, gallery);
    if (dropped.length) warnings.push('参考图超过 ' + MAX_REFERENCES + ' 张，已按优先级保留前 ' + MAX_REFERENCES + ' 张。');

    let shotSection = renderShotSection(shot, canon || {});
    const loreText = list(shot?.loreRefs, 3)
      .map(id => (Array.isArray(lore) ? lore.find(item => item?.id === id) : null))
      .filter(Boolean)
      .map(item => clamp(item.text, 400))
      .filter(Boolean)
      .join('；');
    const loreSection = loreText ? '设定摘录：' + loreText + '。' : '';
    const negative = renderNegative(canon, shot);
    const guidanceText = formatReferenceGuidance(references).trim();
    const requirementText = typeof requirements === 'function' ? String(requirements({ size, quality, n }) || '') : '';

    const build = section => {
      const blocks = ANCHOR_POSITION === 'last'
        ? [section, loreSection, negative, anchor, requirementText]
        : [anchor, section, loreSection, negative, requirementText];
      return blocks.filter(Boolean).join(' ').trim();
    };

    let prompt = build(shotSection);
    let total = prompt.length + (guidanceText ? guidanceText.length + 2 : 0);
    if (total > limit && shotSection) {
      const over = total - limit;
      const trimmed = trimShotSection(shotSection, over);
      if (trimmed !== shotSection) {
        shotSection = trimmed;
        prompt = build(shotSection);
        total = prompt.length + (guidanceText ? guidanceText.length + 2 : 0);
        warnings.push('本帧描述过长，已按语句边界自动精简。');
      }
    }
    if (total > limit) {
      warnings.push('编译结果 ' + total + ' 字符，超过上限 ' + limit + '，请拆分或精简本帧后再生成。');
    }

    const unresolved = unresolvedTerms(prompt);
    if (unresolved.length) warnings.push('提示词中还有未定义的占位符：' + unresolved.map(item => '{{' + item + '}}').join('、') + '。');

    const indexes = referencedIndexes(prompt + guidanceText);
    const highest = indexes.length ? Math.max(...indexes) : 0;
    if (highest > references.length) {
      warnings.push('提示词引用了参考图' + highest + '，但本次只装配了 ' + references.length + ' 张，编号对应关系会错位。');
    }

    return {
      prompt,
      references,
      dropped,
      guidance: guidanceText,
      warnings,
      characters: total,
      overLimit: total > limit,
      anchorHash: hashString(anchor),
      anchor
    };
  }

  // ---------------------------------------------------------------- hashing

  // Small non-cryptographic hash used for drift bookkeeping, not for security.
  function hashString(value) {
    let hash = 0x811c9dc5;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  // ---------------------------------------------------------------- matrix

  function expandMatrix(axes) {
    const usable = (Array.isArray(axes) ? axes : [])
      .map(axis => ({
        id: clean(axis?.id),
        label: clean(axis?.label) || clean(axis?.id),
        values: list(axis?.values, 24)
      }))
      .filter(axis => axis.id && axis.values.length);
    if (!usable.length) return { combinations: [], total: 0, truncated: false };
    let combinations = [{}];
    for (const axis of usable) {
      const next = [];
      for (const combo of combinations) {
        for (const value of axis.values) next.push({ ...combo, [axis.id]: value });
      }
      combinations = next;
      if (combinations.length > AXIS_LIMIT) break;
    }
    const total = combinations.length;
    const truncated = total > AXIS_LIMIT;
    return { combinations: combinations.slice(0, AXIS_LIMIT), total, truncated };
  }

  // ---------------------------------------------------------------- import/export

  const EXPORT_VERSION = 1;

  function exportSeries({ series, shots = [], assets = [], lore = [] }) {
    return {
      format: 'prompt-studio-series',
      version: EXPORT_VERSION,
      exportedAt: Date.now(),
      series,
      shots,
      assets: assets.map(asset => ({
        id: asset.id,
        seriesId: asset.seriesId,
        shotId: asset.shotId,
        role: asset.role,
        name: asset.name,
        note: asset.note,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        sha256: asset.sha256,
        analysis: asset.analysis,
        data: asset.data || null
      })),
      lore
    };
  }

  function validateImport(payload) {
    const errors = [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, errors: ['导入内容必须是系列包对象。'] };
    }
    if (payload.format !== 'prompt-studio-series') errors.push('不是 Prompt Studio 系列包。');
    if (!Number.isInteger(payload.version) || payload.version < 1) errors.push('系列包版本号无效。');
    if (payload.version > EXPORT_VERSION) errors.push('系列包版本较新，请升级应用后再导入。');
    const series = payload.series;
    if (!series || typeof series !== 'object') errors.push('缺少系列数据。');
    else {
      if (!clean(series.id)) errors.push('系列缺少 id。');
      if (!clean(series.title)) errors.push('系列缺少标题。');
      if (!series.canon || typeof series.canon !== 'object') errors.push('系列缺少风格圣经。');
    }
    if (payload.shots !== undefined && !Array.isArray(payload.shots)) errors.push('shots 必须是数组。');
    if (payload.assets !== undefined && !Array.isArray(payload.assets)) errors.push('assets 必须是数组。');
    return { ok: errors.length === 0, errors };
  }

  function normalizeImportedSeries(payload, { newId } = {}) {
    const check = validateImport(payload);
    if (!check.ok) throw new Error(check.errors.join(' '));
    const sourceId = clean(payload.series.id);
    const id = clean(newId) || sourceId;
    // Importing as a new series must also re-key every child record. Reusing the original
    // ids would make IndexedDB overwrite the source series' frames and images.
    const suffix = id === sourceId ? '' : '-' + id.slice(-6);
    const remap = value => (suffix && typeof value === 'string' && value ? value + suffix : value);

    const assets = (payload.assets || []).map(asset => ({
      ...asset,
      id: remap(asset.id),
      shotId: remap(asset.shotId),
      seriesId: id
    }));
    const lore = (payload.lore || []).map(item => ({ ...item, id: remap(item.id), seriesId: id }));
    const shots = (payload.shots || []).map(shot => ({
      ...shot,
      id: remap(shot.id),
      seriesId: id,
      references: Array.isArray(shot.references)
        ? shot.references.map(entry => (entry ? { ...entry, assetId: remap(entry.assetId) } : entry))
        : [],
      loreRefs: Array.isArray(shot.loreRefs) ? shot.loreRefs.map(remap) : [],
      result: shot.result && shot.result.assetId
        ? { ...shot.result, assetId: remap(shot.result.assetId) }
        : shot.result
    }));

    const gallery = payload.series.gallery;
    const series = {
      ...payload.series,
      id,
      gallery: gallery && gallery.defaults
        ? { ...gallery, defaults: Object.fromEntries(Object.entries(gallery.defaults).map(([slot, assetId]) => [slot, remap(assetId)])) }
        : gallery
    };
    return { series, shots, assets, lore };
  }

  const api = {
    PROMPT_LIMIT,
    ANCHOR_POSITION,
    MAX_REFERENCES,
    SLOT_ORDER,
    SLOT_LABELS,
    SLOT_GUIDANCE,
    AXIS_LIMIT,
    BUDGET,
    BUDGET_TARGET,
    EXPORT_VERSION,
    renderAnchor,
    applyTerms,
    renderShotSection,
    renderNegative,
    unresolvedTerms,
    assembleReferences,
    compileShot,
    estimateBudget,
    trimShotSection,
    hashString,
    expandMatrix,
    exportSeries,
    validateImport,
    normalizeImportedSeries
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeriesEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
