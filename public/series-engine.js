(function (root) {
  'use strict';

  // Deterministic compilation: shared identity/style stays intact, while explicitly
  // selected frame variables replace only the corresponding composition defaults.
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

  // Optional fields keep version-1 databases and existing series packages readable.
  function ensureCanonHistory(series, source = 'legacy-current') {
    series.canonVersions ||= [];
    const version = series.canon.version || 1;
    if (!series.canonVersions.some(entry => entry.version === version)) {
      const canon = structuredClone(series.canon);
      canon.version = version;
      canon.anchorSentence ||= renderAnchor(canon);
      series.canonVersions.push({ id: 'canon-' + version + '-' + hashString(JSON.stringify(canon)),
        version, canon, createdAt: Date.now(), source });
    }
    return series;
  }

  function selectedCanon(series) {
    const version = series.generationVersion || series.canon.version || 1;
    return series.canonVersions?.find(entry => entry.version === version)?.canon || series.canon;
  }

  function canonContent(canon) {
    const { version, anchorSentence, ...content } = canon;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(content));
  }

  function applyCanonDraft(series) {
    const next = ensureCanonHistory(structuredClone(series));
    if (!next.canonDraft) return next;
    const draft = next.canonDraft;
    if (canonContent(draft.canon) !== canonContent(next.canon)) {
      const version = Math.max(next.canon.version || 1, ...next.canonVersions.map(entry => entry.version)) + 1;
      next.canon = structuredClone(draft.canon);
      next.canon.version = version;
      next.canon.anchorSentence = renderAnchor(next.canon);
      ensureCanonHistory(next, 'applied');
      next.generationVersion = null;
    }
    if (draft.theme) next.theme = structuredClone(draft.theme);
    next.canonDraft = null;
    next.canonDirty = false;
    next.updatedAt = Date.now();
    return next;
  }

  function generationParameters(value = {}) {
    const capabilities = value.capabilities?.mode === 'custom' ? {
      mode: 'custom', sizes: value.capabilities.sizes?.slice(), qualities: value.capabilities.qualities?.slice(),
      responseFormats: value.capabilities.responseFormats?.slice(), maxCount: value.capabilities.maxCount,
      maxReferences: value.capabilities.maxReferences, imageField: value.capabilities.imageField,
      customSizes: value.capabilities.customSizes === true
    } : { mode: 'auto' };
    return { model: String(value.model || '').trim(), size: value.size || 'default',
      quality: value.quality || 'default', responseFormat: value.responseFormat || 'auto', capabilities };
  }

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

  const AXIS_KINDS = {
    scene: /^(scene|place|location|场景|地点)$/i,
    time: /^(time|时间|时段)$/i,
    distance: /^(shot|distance|framing|shot[_-]?size|景别)$/i,
    angle: /^(view|angle|camera[_-]?angle|机位|角度|视角|机位角度)$/i
  };
  const AXIS_LABELS = { scene: '场景', time: '时间', distance: '景别', angle: '机位' };
  // These checks cover explicit, recognisable contradictions; they are not a
  // general natural-language or visual consistency judgement.
  const VARIABLE_TERMS = {
    distance: [
      ['close', /特写|close[ -]?up/ig], ['half', /半身|half[ -]?body|waist[ -]?up/ig],
      ['full', /全身|full[ -]?(?:body|length)/ig], ['medium', /中近景|中景|medium shot/ig], ['wide', /远景|全景|wide shot/ig]
    ],
    time: [
      ['night', /雨夜|夜晚|夜间|深夜|午夜|夜景|\bnight\b/ig], ['morning', /清晨|凌晨|黎明|早晨|\bmorning\b|\bdawn\b/ig],
      ['noon', /正午|中午|\bnoon\b/ig], ['dusk', /黄昏|傍晚|日落|\bdusk\b|\bsunset\b/ig], ['day', /白天|日间|\bdaytime\b/ig]
    ],
    angle: [
      ['up', /仰视|低机位|low[ -]angle/ig], ['down', /俯视|高机位|鸟瞰|high[ -]angle|bird.s[ -]eye/ig], ['level', /平视|eye[ -]level/ig],
      ['front', /正面|front view/ig], ['side', /侧面|侧视|side view/ig], ['back', /背面|背视|back view/ig]
    ]
  };

  function variableTokens(text, kind, includeNegated = false) {
    const tokens = [];
    for (const [name, pattern] of VARIABLE_TERMS[kind] || []) {
      pattern.lastIndex = 0;
      for (const match of String(text || '').matchAll(pattern)) {
        if (includeNegated || !/(?:不要|避免|禁止|并非|不是|不采用|非)\s*$/.test(String(text).slice(Math.max(0, match.index - 6), match.index))) {
          tokens.push(name);
          break;
        }
      }
    }
    return tokens;
  }

  function opposed(a, b, kind) {
    if (a === b) return false;
    if (kind === 'angle') {
      const vertical = ['up', 'down', 'level'];
      return vertical.includes(a) === vertical.includes(b);
    }
    if (kind === 'time' && ((a === 'day' && b !== 'night') || (b === 'day' && a !== 'night'))) return false;
    if (kind === 'distance' && (['half', 'medium'].includes(a) && ['half', 'medium'].includes(b)
      || ['full', 'wide'].includes(a) && ['full', 'wide'].includes(b))) return false;
    return true;
  }

  function selectedVariables(shot, axes) {
    const definitions = new Map((Array.isArray(axes) ? axes : []).map(axis => [clean(axis?.id), axis]));
    return Object.entries(shot?.axisValues || {}).filter(([, value]) => clean(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, raw]) => {
        const axis = definitions.get(id);
        const label = clean(axis?.label);
        const kind = Object.keys(AXIS_KINDS).find(key => AXIS_KINDS[key].test(label) || AXIS_KINDS[key].test(id)) || '';
        return { id, label: label || AXIS_LABELS[kind] || id, value: clean(raw), kind, axis };
      });
  }

  function variableContext(canon, shot, axes, baseAnchor, warnings) {
    const variables = selectedVariables(shot, axes).map(entry => ({ ...entry, value: applyTerms(entry.value, canon?.terms) }));
    if (!variables.length) return { variables, anchor: baseAnchor, section: '', effectiveShot: shot };
    const defaults = [];
    for (const entry of variables) {
      if (entry.kind === 'distance' && clean(canon?.lens?.distance)) defaults.push(clean(canon.lens.distance));
      if (entry.kind === 'angle' && clean(canon?.lens?.angle)) defaults.push(clean(canon.lens.angle));
      if (entry.kind === 'time') {
        const selected = variableTokens(entry.value, 'time');
        if (selected.some(a => variableTokens(canon?.lighting?.key, 'time').some(b => opposed(a, b, 'time')))) {
          defaults.push(clean(canon.lighting.key));
        }
      }
      if (entry.axis && !list(entry.axis.values, 24).includes(clean(shot.axisValues[entry.id]))) {
        warnings.push('变量「' + entry.label + '：' + entry.value + '」已不在当前轴取值中，本次保留帧的原取值。');
      }
    }
    const omit = new Set(defaults.flatMap(value => value.split(/[，,；;。]/).map(clean)).filter(Boolean));
    const clauses = baseAnchor.split(/[，,；;。]/).map(clean).filter(Boolean);
    const retained = clauses.filter(clause => !omit.has(clause));
    const anchor = retained.length === clauses.length ? baseAnchor : (retained.length ? retained.join('，') + '。' : '');
    const scene = variables.find(entry => entry.kind === 'scene');
    const effectiveShot = scene ? { ...shot, scene: scene.value } : shot;
    if (scene && clean(shot?.scene) && applyTerms(shot.scene, canon?.terms) !== scene.value) {
      warnings.push('本次场景采用变量「' + scene.value + '」，替代帧场景「' + applyTerms(shot.scene, canon?.terms) + '」；原描述仍保留在帧中。');
    }
    const section = '【本帧变量】\n' + variables.map(entry => entry.label + '：' + entry.value).join('；')
      + '。\n角色外观、产品外形与标识等稳定特征保持不变；本帧指定的场景、时间、景别、机位及其他变量，覆盖共同设定中的同类默认值。';
    return { variables, anchor, section, effectiveShot };
  }

  function variableConflicts(context, canon, sources) {
    const conflicts = [];
    for (const entry of context.variables) {
      if (/^(角色外观|发色|发型|体型)$/i.test(entry.label) && clean(canon?.characterLook)
        && !clean(canon.characterLook).includes(entry.value)) {
        conflicts.push('变量「' + entry.label + '：' + entry.value + '」可能改变角色稳定外观「' + canon.characterLook + '」，请先协调设定。');
      }
      const selected = variableTokens(entry.value, entry.kind);
      if (selected.some(a => selected.some(b => opposed(a, b, entry.kind)))) {
        conflicts.push('变量「' + entry.label + '：' + entry.value + '」包含互相冲突的描述，请拆分为独立取值。');
      }
      for (const source of sources) {
        // Appearance descriptions such as 全身银色鳞片 describe identity, not framing.
        const text = source.text.replace('角色外观：' + clean(canon?.characterLook), '')
          .split(/[，,；;。]/).filter(clause => !clause.startsWith('角色外观：')).join('；');
        const mentioned = variableTokens(text, entry.kind, source.negative);
        if (selected.some(a => mentioned.some(b => source.negative ? a === b : opposed(a, b, entry.kind)))) {
          conflicts.push('变量「' + entry.label + '：' + entry.value + '」与' + source.label + '「' + clamp(text, 150) + '」冲突，请修改后再生成。');
        }
      }
      for (const other of context.variables) {
        if (other.id <= entry.id || !entry.kind || other.kind !== entry.kind) continue;
        if (selected.some(a => variableTokens(other.value, entry.kind).some(b => opposed(a, b, entry.kind)))) {
          conflicts.push('变量「' + entry.label + '：' + entry.value + '」与变量「' + other.label + '：' + other.value + '」冲突，请只保留一致的取值。');
        }
      }
    }
    return [...new Set(conflicts)];
  }

  function compileShot({ canon, shot, axes = [], gallery = [], lore = [], size, quality, n = 1, limit = PROMPT_LIMIT, requirements }) {
    const warnings = [];
    const baseAnchor = clean(canon?.anchorSentence) || renderAnchor(canon || {});
    const context = variableContext(canon, shot, axes, baseAnchor, warnings);
    const anchor = context.anchor;
    if (!anchor) warnings.push('风格圣经缺少可编译的锚点内容，请至少填写媒介、光线或色板。');
    if (anchor.length > BUDGET.anchor) warnings.push('锚点块超过 ' + BUDGET.anchor + ' 字符，建议精简风格圣经。');

    const { references, dropped } = assembleReferences(shot, gallery);
    if (context.variables.some(entry => entry.kind === 'distance' || entry.kind === 'angle')) {
      for (const ref of references) {
        const original = (shot?.references || []).find(entry => entry.assetId === ref.assetId);
        if (ref.slot === 'previous' && !original?.preserve) {
          ref.preserve = '主体稳定特征与画面质感';
          ref.change += '，景别与机位采用本帧变量';
        }
      }
    }
    if (dropped.length) warnings.push('参考图超过 ' + MAX_REFERENCES + ' 张，已按优先级保留前 ' + MAX_REFERENCES + ' 张。');

    let shotSection = renderShotSection(context.effectiveShot, canon || {});
    const loreExcerpts = [];
    const missingLoreRefs = [];
    const loreText = list(shot?.loreRefs, 3)
      .map(id => {
        const item = Array.isArray(lore) ? lore.find(entry => entry?.id === id) : null;
        if (!item) {
          missingLoreRefs.push('档案条目已不存在');
          return '';
        }
        const selection = (Array.isArray(shot?.loreSelections) ? shot.loreSelections : []).find(entry => entry?.loreId === id);
        if (selection?.pending) {
          missingLoreRefs.push(item.title || '未命名条目');
          return '';
        }
        if (selection) {
          const start = Number(selection.start);
          const end = Number(selection.end);
          const excerpt = String(selection.text || '');
          if (!excerpt || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start
            || String(item.text || '').slice(start, end) !== excerpt) {
            missingLoreRefs.push((item.title || '未命名条目') + '（引用范围已失效）');
            return '';
          }
          loreExcerpts.push({ loreId: id, title: item.title || '未命名条目', text: excerpt, start, end });
          return excerpt;
        }
        missingLoreRefs.push((item.title || '未命名条目') + '（旧引用需要确认摘录）');
        return '';
      })
      .filter(Boolean)
      .join('；');
    const loreSection = loreText ? '设定摘录：' + loreText + '。' : '';
    if (loreExcerpts.some(item => item.text.length > BUDGET.lore)) {
      warnings.push('原文摘录超过建议的 ' + BUDGET.lore + ' 字符；实际发送内容未截断，请选择更短的相关片段。');
    }
    for (const title of missingLoreRefs) warnings.push('「' + title + '」尚未选定有效原文片段，无法生成。');
    const negative = renderNegative(canon, shot);
    const guidanceText = formatReferenceGuidance(references.map(ref => ref.purpose === 'custom' ? { ...ref, purpose: '' } : ref));
    const requirementText = typeof requirements === 'function' ? String(requirements({ size, quality, n }) || '') : '';

    const build = section => {
      const blocks = ANCHOR_POSITION === 'last'
        ? [context.section, section, loreSection, negative, anchor]
        : [anchor, context.section, section, loreSection, negative];
      return blocks.filter(Boolean).join(' ').trim();
    };
    // Multipart text fields use CRLF on the wire. Reflect that in the final
    // preview/result while leaving the API's base prompt free of appended suffixes.
    const finalize = base => {
      const full = base + guidanceText + requirementText;
      return references.length ? full.replace(/\r?\n/g, '\r\n') : full;
    };

    let requestPrompt = build(shotSection);
    let prompt = finalize(requestPrompt);
    let total = prompt.length;
    if (total > limit && shotSection && !loreExcerpts.length) {
      const over = total - limit;
      const trimmed = trimShotSection(shotSection, over);
      if (trimmed !== shotSection) {
        shotSection = trimmed;
        requestPrompt = build(shotSection);
        prompt = finalize(requestPrompt);
        total = prompt.length;
        warnings.push('本帧描述过长，已按语句边界自动精简。');
      }
    }
    if (total > limit) {
      warnings.push('编译结果 ' + total + ' 字符，超过上限 ' + limit + '，请拆分或精简本帧后再生成。');
    }

    const conflicts = variableConflicts(context, canon, [
      { label: '共同设定', text: anchor }, { label: '本帧描述', text: shotSection },
      { label: '原文摘录', text: loreSection }, { label: '负向约束', text: negative, negative: true },
      ...references.flatMap((ref, index) => [
        { label: '参考图' + (index + 1) + '保留要求', text: ref.preserve },
        { label: '参考图' + (index + 1) + '修改要求', text: ref.change }
      ])
    ]);
    warnings.push(...conflicts);

    const unresolved = unresolvedTerms(prompt);
    if (unresolved.length) warnings.push('提示词中还有未定义的占位符：' + unresolved.map(item => '{{' + item + '}}').join('、') + '。');

    const indexes = referencedIndexes(prompt + guidanceText);
    const highest = indexes.length ? Math.max(...indexes) : 0;
    if (highest > references.length) {
      warnings.push('提示词引用了参考图' + highest + '，但本次只装配了 ' + references.length + ' 张，编号对应关系会错位。');
    }

    return {
      prompt,
      requestPrompt,
      references,
      dropped,
      guidance: guidanceText,
      warnings,
      characters: total,
      overLimit: total > limit,
      conflicts,
      blocked: conflicts.length > 0 || missingLoreRefs.length > 0,
      loreExcerpts,
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

  function matrixKey(values) {
    return JSON.stringify(Object.entries(values && typeof values === 'object' ? values : {})
      .map(([id, value]) => [id, clean(value)]).filter(([, value]) => value)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }

  function expandMatrix(axes) {
    const usable = (Array.isArray(axes) ? axes : [])
      .map(axis => ({
        id: clean(axis?.id),
        label: clean(axis?.label) || clean(axis?.id),
        values: [...new Set((Array.isArray(axis?.values) ? axis.values : []).map(clean).filter(Boolean))].slice(0, 24)
      }))
      .filter(axis => axis.id && axis.values.length);
    const ids = new Set();
    const errors = [];
    for (const axis of usable) {
      if (ids.has(axis.id)) errors.push('变量轴 ID「' + axis.id + '」重复，请删除重复轴后重新添加，避免覆盖已有帧取值。');
      ids.add(axis.id);
    }
    if (!usable.length || errors.length) return { combinations: [], total: 0, truncated: false, axes: usable, errors };
    const count = usable.reduce((product, axis) => product * BigInt(axis.values.length), 1n);
    const total = count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count.toString();
    const truncated = count > BigInt(AXIS_LIMIT);
    const combinations = [];
    const indexes = usable.map(() => 0);
    // Mixed-radix counting visits at most 200 complete combinations, regardless
    // of how large the full Cartesian product is.
    const displayed = truncated ? AXIS_LIMIT : Number(count);
    for (let index = 0; index < displayed; index++) {
      combinations.push(Object.fromEntries(usable.map((axis, position) => [axis.id, axis.values[indexes[position]]])));
      for (let cursor = usable.length - 1; cursor >= 0; cursor--) {
        indexes[cursor]++;
        if (indexes[cursor] < usable[cursor].values.length) break;
        indexes[cursor] = 0;
      }
    }
    return { combinations, total, truncated, axes: usable, errors };
  }

  // ---------------------------------------------------------------- import/export

  function resultHistory(shot) {
    const results = new Map();
    for (const result of [...(Array.isArray(shot?.generationHistory) ? shot.generationHistory : []), shot?.result]) {
      if (result?.assetId && !results.has(result.assetId)) results.set(result.assetId, structuredClone(result));
    }
    return [...results.values()];
  }

  function resultUsers(assetId, shots, series = {}, runs = []) {
    const users = [];
    for (const shot of shots) {
      const references = [...(shot.references || []), ...resultHistory(shot).flatMap(result => result.references || []),
        ...(shot.pendingGeneration?.result?.references || [])];
      if (references.some(ref => ref.assetId === assetId)) users.push(shot.code || shot.title || shot.id);
    }
    if (Object.values(series.gallery?.defaults || {}).includes(assetId)) users.push('系列默认参考图');
    for (const run of runs) {
      if (run.items?.some(item => ['pending', 'submitting', 'unknown', 'failed', 'cancelled'].includes(item.status)
        && item.shot.references?.some(ref => ref.assetId === assetId))) users.push('批次 ' + run.id);
      const source = run.items?.find(item => item.assetId === assetId);
      if (source && run.items.some(item => ['pending', 'submitting', 'unknown', 'failed', 'cancelled'].includes(item.status)
        && item.shot.references?.some(ref => ref.slot === 'previous'
          && run.context?.assets?.some(asset => asset.id === ref.assetId && asset.shotId === source.shot.id)))) users.push('批次 ' + run.id);
    }
    return [...new Set(users)];
  }

  function runSummary(run) {
    const counts = { total: run.items.length, success: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0, submitting: 0, unknown: 0, 'pending-save': 0 };
    for (const item of run.items) if (Object.hasOwn(counts, item.status)) counts[item.status]++;
    return counts;
  }

  function recoverRun(record, shots) {
    const run = structuredClone(record);
    for (const item of run.items) {
      const shot = shots.find(entry => entry.id === item.shot.id);
      const result = shot && resultHistory(shot).find(entry => entry.runId === run.id);
      if (result) { item.status = 'success'; item.assetId = result.assetId; item.error = ''; }
      else if (shot?.pendingGeneration?.result?.runId === run.id) item.status = 'pending-save';
      else if (item.status === 'submitting') { item.status = 'unknown'; item.error = '请求已提交，但结果尚未确认。请核对供应商记录，不会自动重发。'; }
      else if (item.status === 'pending-save' && !shot?.pendingGeneration) { item.status = 'skipped'; item.error = '待保存结果已放弃或目标已删除，未重发。'; }
    }
    if (['running', 'paused', 'stopping'].includes(run.status)) run.status = 'interrupted';
    return run;
  }

  const EXPORT_VERSION = 3;

  function exportSeries({ series, shots = [], assets = [], lore = [], runs = [] }) {
    return {
      format: 'prompt-studio-series',
      version: EXPORT_VERSION,
      exportedAt: Date.now(),
      series: { ...structuredClone(series), ...(series.generationParameters ? { generationParameters: generationParameters(series.generationParameters) } : {}) },
      shots: shots.map(shot => ({ ...structuredClone(shot),
        generationHistory: resultHistory(shot).map(result => ({ ...result,
          ...(result.parameters ? { parameters: { ...generationParameters(result.parameters), n: 1 } } : {}) })),
        ...(shot.result?.parameters ? { result: { ...shot.result, parameters: { ...generationParameters(shot.result.parameters), n: 1 } } } : {}),
        ...(shot.pendingGeneration?.result?.parameters ? { pendingGeneration: { ...shot.pendingGeneration,
          result: { ...shot.pendingGeneration.result, parameters: { ...generationParameters(shot.pendingGeneration.result.parameters), n: 1 } } } } : {}) })),
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
      lore,
      runs: runs.filter(run => Array.isArray(run.items)).map(run => {
        const snapshot = exportSeries({ ...run.context, shots: run.items.map(item => item.shot) });
        return { ...structuredClone(run), context: { series: snapshot.series, assets: snapshot.assets, lore: snapshot.lore },
          items: run.items.map((item, index) => ({ ...structuredClone(item), shot: snapshot.shots[index],
            ...(item.actual ? { actual: { ...item.actual, parameters: generationParameters(item.actual.parameters) } } : {}) })) };
      })
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
      if (series.canonDraft && (!series.canonDraft.canon || typeof series.canonDraft.canon !== 'object' || Array.isArray(series.canonDraft.canon))) errors.push('设定草稿格式无效。');
      if (series.canonVersions !== undefined) {
        const versions = series.canonVersions;
        if (!Array.isArray(versions) || versions.length > 10000 || versions.some(entry => !entry || !clean(entry.id)
          || !Number.isInteger(entry.version) || entry.version < 1 || !entry.canon || entry.canon.version !== entry.version)
          || new Set(versions.map(entry => entry.version)).size !== versions.length
          || new Set(versions.map(entry => entry.id)).size !== versions.length) errors.push('设定版本快照无效或重复。');
        else if (series.generationVersion && !versions.some(entry => entry.version === series.generationVersion)) errors.push('所选生成版本缺少快照。');
        else if (versions.length && !versions.some(entry => entry.version === (series.canon?.version || 1))) errors.push('当前采用的设定版本缺少快照。');
      }
      if (series.generationVersion && !Array.isArray(series.canonVersions)) errors.push('所选生成版本缺少快照。');
      if (series.generationParameters && (typeof series.generationParameters !== 'object' || Array.isArray(series.generationParameters))) errors.push('系列参数格式无效。');
    }
    if (payload.shots !== undefined && !Array.isArray(payload.shots)) errors.push('shots 必须是数组。');
    if (payload.assets !== undefined && !Array.isArray(payload.assets)) errors.push('assets 必须是数组。');
    if (payload.lore !== undefined && !Array.isArray(payload.lore)) errors.push('lore 必须是数组。');
    if (payload.runs !== undefined && !Array.isArray(payload.runs)) errors.push('runs 必须是数组。');
    for (const name of ['shots', 'assets', 'lore']) {
      if (!Array.isArray(payload[name])) continue;
      if (payload[name].some(record => !record || typeof record !== 'object' || !clean(record.id))
        || new Set(payload[name].map(record => record?.id)).size !== payload[name].length) errors.push(name + ' 存在无效记录或重复 ID。');
    }
    if (Array.isArray(payload.shots)) for (const shot of payload.shots) {
      if (!shot || typeof shot !== 'object') continue;
      if (shot.generationHistory !== undefined && (!Array.isArray(shot.generationHistory)
        || shot.generationHistory.some(result => !result || !clean(result.assetId))
        || new Set(shot.generationHistory.map(result => result.assetId)).size !== shot.generationHistory.length)) {
        errors.push('生成历史格式无效或存在重复版本。'); continue;
      }
      for (const result of [...(shot.generationHistory || []), shot?.result, shot?.pendingGeneration?.result]) {
        if (result?.canonSnapshotId && (!Array.isArray(series?.canonVersions) || !series.canonVersions.some(entry => entry.id === result.canonSnapshotId && entry.version === result.canonVersion))) errors.push('生成结果关联的设定快照不存在。');
      }
      const pending = shot?.pendingGeneration;
      if (!pending) continue;
      const asset = pending.asset;
      const result = pending.result;
      if (!clean(pending.id) || !clean(asset?.id) || result?.assetId !== asset?.id
        || asset?.seriesId !== series?.id || asset?.shotId !== shot.id || asset?.role !== 'output'
        || !/^https?:\/\//i.test(asset?.data || '')
        || (result?.references !== undefined && (!Array.isArray(result.references)
          || result.references.some(entry => !entry || typeof entry !== 'object' || !clean(entry.assetId))))) {
        errors.push('待保存图片记录无效或与目标帧不匹配。');
      }
    }
    if (Array.isArray(payload.runs)) {
      const states = ['pending', 'submitting', 'success', 'failed', 'skipped', 'cancelled', 'unknown', 'pending-save'];
      if (new Set(payload.runs.map(run => run?.id)).size !== payload.runs.length) errors.push('批次 ID 重复。');
      for (const run of payload.runs) {
        if (!clean(run?.id) || run.seriesId !== series?.id || run.context?.series?.id !== series?.id
          || !Array.isArray(run.items) || run.items.some(item => !item?.shot?.id || item.shot.seriesId !== series?.id || !states.includes(item.status))
          || new Set(run.items.map(item => item.shot.id)).size !== run.items.length) { errors.push('批次记录格式或归属无效。'); continue; }
        const context = { series: run.context.series, assets: run.context.assets, lore: run.context.lore,
          shots: run.items.map(item => item.shot), format: payload.format, version: payload.version };
        if (!validateImport(context).ok) errors.push('批次生成条件快照无效。');
      }
    }
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
      loreSelections: Array.isArray(shot.loreSelections)
        ? shot.loreSelections.map(selection => ({ ...selection, loreId: remap(selection.loreId) }))
        : [],
      generationHistory: resultHistory(shot).map(result => ({ ...result, assetId: remap(result.assetId),
        ...(result.runId ? { runId: remap(result.runId) } : {}),
        ...(result.parameters ? { parameters: { ...generationParameters(result.parameters), n: 1 } } : {}),
        references: (result.references || []).map(entry => ({ ...entry, assetId: remap(entry.assetId) })) })),
      result: shot.result && shot.result.assetId
        ? { ...shot.result, assetId: remap(shot.result.assetId),
          ...(shot.result.runId ? { runId: remap(shot.result.runId) } : {}),
          ...(shot.result.parameters ? { parameters: { ...generationParameters(shot.result.parameters), n: 1 } } : {}),
          references: (shot.result.references || []).map(entry => ({ ...entry, assetId: remap(entry.assetId) })) }
        : shot.result,
      ...(shot.pendingGeneration ? { pendingGeneration: {
        ...shot.pendingGeneration,
        id: remap(shot.pendingGeneration.id),
        asset: { ...shot.pendingGeneration.asset, id: remap(shot.pendingGeneration.asset.id),
          seriesId: id, shotId: remap(shot.id) },
        result: { ...shot.pendingGeneration.result, assetId: remap(shot.pendingGeneration.result.assetId),
          ...(shot.pendingGeneration.result.runId ? { runId: remap(shot.pendingGeneration.result.runId) } : {}),
          ...(shot.pendingGeneration.result.parameters ? { parameters: { ...generationParameters(shot.pendingGeneration.result.parameters), n: 1 } } : {}),
          references: (shot.pendingGeneration.result.references || []).map(entry => ({ ...entry, assetId: remap(entry.assetId) })) }
      } } : {})
    }));

    const gallery = payload.series.gallery;
    const series = {
      ...structuredClone(payload.series),
      id,
      ...(payload.series.generationParameters ? { generationParameters: generationParameters(payload.series.generationParameters) } : {}),
      gallery: gallery && gallery.defaults
        ? { ...gallery, defaults: Object.fromEntries(Object.entries(gallery.defaults).map(([slot, assetId]) => [slot, remap(assetId)])) }
        : gallery
    };
    const runs = (payload.runs || []).map(record => {
      const snapshot = normalizeImportedSeries({ series: record.context.series, assets: record.context.assets, lore: record.context.lore, shots: record.items.map(item => item.shot),
        format: payload.format, version: payload.version }, { newId: id });
      const run = { ...record, id: remap(record.id), seriesId: id,
        context: { series: snapshot.series, assets: snapshot.assets, lore: snapshot.lore },
        items: record.items.map((item, index) => ({ ...item, shot: snapshot.shots[index],
          ...(item.assetId ? { assetId: remap(item.assetId) } : {}),
          ...(item.actual ? { actual: { ...item.actual, parameters: generationParameters(item.actual.parameters),
            references: (item.actual.references || []).map(ref => ({ ...ref, assetId: remap(ref.assetId) })) } } : {}) })) };
      return recoverRun(run, shots);
    });
    return { series, shots, assets, lore, runs };
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
    resultHistory,
    resultUsers,
    runSummary,
    recoverRun,
    ensureCanonHistory,
    selectedCanon,
    applyCanonDraft,
    generationParameters,
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
    matrixKey,
    expandMatrix,
    exportSeries,
    validateImport,
    normalizeImportedSeries
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeriesEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
