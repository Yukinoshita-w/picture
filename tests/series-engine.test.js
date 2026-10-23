'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/series-engine');
const { TEMPLATES } = require('../public/series-templates');
const { formatReferenceGuidance, referencedIndexes } = require('../public/reference-guidance');
const generationRequirements = require('../public/generation-requirements');

const canon = {
  version: 1,
  medium: '35mm 胶片摄影',
  palette: [
    { name: '湿沥青', hex: '#1b1f24', weight: 0.4 },
    { name: '钠灯橙', hex: '#c9762f', weight: 0.35 }
  ],
  lighting: { key: '单侧钠灯硬光', ratio: '1:8', direction: '左后侧', colorTemp: '2700K' },
  lens: { focal: '35mm', aperture: 'f/2.0', distance: '中景', angle: '平视略低' },
  composition: { frame: '3:2 横构图', placement: '主体偏左三分', negativeSpace: '上方留出雨幕' },
  grade: { contrast: '高对比', saturation: '低饱和', shadows: '青黑压暗', highlights: '橙黄溢出' },
  material: { render: '真实摄影', texture: '胶片颗粒' },
  terms: { hero: '林野' },
  negative: ['水印', '文字', '多余人物'],
  anchorSentence: '35mm 胶片摄影，湿沥青与钠灯橙的冷暖对照，单侧钠灯硬光 1:8，低饱和青黑阴影。'
};

const gallery = [
  { id: 'ast_char', role: 'character', name: '主角' },
  { id: 'ast_style', role: 'style', name: '风格' },
  { id: 'ast_scene', role: 'scene', name: '场景' },
  { id: 'ast_prop', role: 'prop', name: '道具' },
  { id: 'ast_extra', role: 'prop', name: '多余道具' }
];

const shot = {
  id: 'sht_1',
  index: 1,
  subject: '{{hero}}',
  action: '把信匣塞进锈蚀的信箱',
  scene: '霓虹天桥',
  references: [
    { assetId: 'ast_style', slot: 'style' },
    { assetId: 'ast_char', slot: 'character' }
  ]
};

// ---------------------------------------------------------------- anchor rendering

test('renders a stable anchor sentence from canon fields', () => {
  const first = Engine.renderAnchor(canon);
  const second = Engine.renderAnchor(JSON.parse(JSON.stringify(canon)));
  assert.equal(first, second);
  assert.ok(first.includes('35mm 胶片摄影'));
  assert.ok(first.includes('单侧钠灯硬光'));
  assert.ok(first.includes('湿沥青'));
  assert.ok(first.endsWith('。'));
  assert.ok(!first.startsWith('，'));
});

test('anchor sentence is identical across different shots', () => {
  const a = Engine.compileShot({ canon, shot, gallery });
  const b = Engine.compileShot({ canon, shot: { ...shot, id: 'sht_2', action: '站在天桥上' }, gallery });
  assert.equal(a.anchor, b.anchor);
  assert.equal(a.anchorHash, b.anchorHash);
  assert.ok(a.prompt.startsWith(a.anchor));
  assert.ok(b.prompt.startsWith(b.anchor));
});

test('editing a term does not change the frozen anchor', () => {
  const before = Engine.compileShot({ canon, shot, gallery });
  const edited = { ...canon, terms: { hero: '另一个人' } };
  const after = Engine.compileShot({ canon: edited, shot, gallery });
  assert.equal(before.anchor, after.anchor);
  assert.ok(after.prompt.includes('另一个人'));
  assert.ok(!after.prompt.includes('{{hero}}'));
});

test('unknown placeholders are reported instead of sent literally', () => {
  const result = Engine.compileShot({ canon, shot: { ...shot, subject: '{{villain}}' }, gallery });
  assert.ok(result.prompt.includes('{{villain}}'));
  assert.ok(result.warnings.some(line => line.includes('{{villain}}')));
});

// ---------------------------------------------------------------- references

test('assembles references in fixed slot priority order', () => {
  const result = Engine.compileShot({
    canon,
    shot: { ...shot, references: [
      { assetId: 'ast_prop', slot: 'prop' },
      { assetId: 'ast_char', slot: 'character' },
      { assetId: 'ast_style', slot: 'style' }
    ] },
    gallery
  });
  assert.deepEqual(result.references.map(item => item.slot), ['character', 'style', 'prop']);
  assert.deepEqual(result.references.map(item => item.assetId), ['ast_char', 'ast_style', 'ast_prop']);
});

test('caps references at four and reports the dropped ones', () => {
  const result = Engine.compileShot({
    canon,
    shot: { ...shot, references: [
      { assetId: 'ast_extra', slot: 'prop' },
      { assetId: 'ast_prop', slot: 'prop' },
      { assetId: 'ast_scene', slot: 'scene' },
      { assetId: 'ast_style', slot: 'style' },
      { assetId: 'ast_char', slot: 'character' }
    ] },
    gallery
  });
  assert.equal(result.references.length, 4);
  assert.equal(result.dropped.length, 1);
  assert.ok(result.warnings.some(line => line.includes('参考图超过')));
});

test('reference guidance numbering matches the assembled array', () => {
  const result = Engine.compileShot({ canon, shot, gallery });
  assert.ok(result.guidance.includes('参考图1（用途：人物）'));
  assert.ok(result.guidance.includes('参考图2（用途：风格）'));
  assert.equal(result.references.length, 2);
});

test('compile is stable across repeated calls', () => {
  const first = Engine.compileShot({ canon, shot, gallery });
  const second = Engine.compileShot({ canon, shot, gallery });
  assert.deepEqual(first.references, second.references);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.characters, second.characters);
});

test('warns when the prompt points at a reference that is not uploaded', () => {
  const result = Engine.compileShot({
    canon,
    shot: { ...shot, detail: '保持参考图3的场景结构' },
    gallery
  });
  assert.ok(result.warnings.some(line => line.includes('参考图3')));
});

test('reference guidance module and server format agree', () => {
  const guidance = [{ purpose: '人物', preserve: '发型', change: '背景' }, { purpose: '风格', preserve: '', change: '' }];
  const text = formatReferenceGuidance(guidance);
  assert.equal(text, '\n\n参考图使用说明（按编号对应上传图片）：\n参考图1（用途：人物），需要保留：发型，需要修改：背景\n参考图2（用途：风格）');
  assert.deepEqual(referencedIndexes('参考图1 和 参考图 12'), [1, 12]);
});

// ---------------------------------------------------------------- budget

test('keeps a normal prompt well under the limit', () => {
  const result = Engine.compileShot({
    canon, shot, gallery,
    requirements: size => generationRequirements({ size, quality: 'high', n: 1 })
  });
  assert.ok(result.characters <= Engine.PROMPT_LIMIT);
  assert.equal(result.overLimit, false);
});

test('trims an over-long shot section at clause boundaries', () => {
  const longShot = { ...shot, detail: Array.from({ length: 800 }, (_, index) => '这是第' + (index + 1) + '段很长的画面描述内容。').join('') };
  const result = Engine.compileShot({ canon, shot: longShot, gallery });
  assert.ok(result.characters <= Engine.PROMPT_LIMIT);
  assert.ok(result.warnings.some(line => line.includes('精简')));
  assert.ok(result.prompt.includes('主体：'));
});

test('reports overflow instead of truncating the anchor', () => {
  const hugeCanon = { ...canon, anchorSentence: '锚'.repeat(Engine.PROMPT_LIMIT + 500) };
  const result = Engine.compileShot({ canon: hugeCanon, shot, gallery });
  assert.equal(result.overLimit, true);
  assert.ok(result.prompt.startsWith(hugeCanon.anchorSentence));
  assert.ok(result.warnings.some(line => line.includes('超过上限')));
});

test('respects a custom limit', () => {
  const result = Engine.compileShot({ canon, shot, gallery, limit: 80 });
  assert.equal(result.overLimit, true);
});

test('trimShotSection never returns an empty frame from a non-empty input', () => {
  const section = '主体：甲；动作：乙。';
  const trimmed = Engine.trimShotSection(section, 5);
  assert.ok(trimmed.length > 0);
  assert.ok(trimmed.length <= section.length);
});

// ---------------------------------------------------------------- matrix

test('frame variables change the prompt with their names, including custom and legacy axes', () => {
  const axes = [{ id: 'prop', label: '关键道具', values: ['{{mail}}'] }];
  const input = { canon: { ...canon, terms: { ...canon.terms, mail: '铜制信匣' } }, axes,
    shot: { ...shot, axisValues: { time: '雨夜', shot: '全身', prop: '{{mail}}' } }, gallery };
  const before = JSON.stringify(input);
  const night = Engine.compileShot(input);
  const morning = Engine.compileShot({ ...input, shot: { ...input.shot, axisValues: { prop: '{{mail}}', shot: '特写', time: '清晨' } } });
  assert.match(night.prompt, /时间：雨夜/);
  assert.match(night.prompt, /景别：全身/);
  assert.match(night.prompt, /关键道具：铜制信匣/);
  assert.match(morning.prompt, /时间：清晨/);
  assert.match(morning.prompt, /景别：特写/);
  assert.notEqual(night.prompt, morning.prompt);
  assert.equal(JSON.stringify(input), before);
  assert.equal(night.blocked, false);
});

test('explicit frame values replace structured defaults while keeping stable identity and style', () => {
  const shared = { ...canon, lens: { ...canon.lens, distance: '固定半身', angle: '平视' },
    lighting: { ...canon.lighting, key: '夜间月光' }, characterLook: '短黑发，深灰呢大衣' };
  shared.anchorSentence = Engine.renderAnchor(shared);
  const result = Engine.compileShot({ canon: shared, shot: { ...shot, scene: '旧街区',
    axisValues: { scene: '海边', time: '清晨', shot: '全身', view: '俯视' } } });
  assert.equal(result.blocked, false, result.conflicts.join('\n'));
  assert.doesNotMatch(result.prompt, /固定半身|平视|夜间月光|场景：旧街区/);
  assert.match(result.prompt, /场景：海边/);
  assert.match(result.prompt, /短黑发/);
  assert.match(result.prompt, /深灰呢大衣/);
  assert.match(result.prompt, /35mm/);
  assert.match(result.prompt, /低饱和/);
  assert.equal(shared.lens.distance, '固定半身');
  assert.ok(shared.anchorSentence.includes('夜间月光'));
  const appearance = { ...shared, characterLook: '短黑发，全身银色鳞片' };
  appearance.anchorSentence = Engine.renderAnchor(appearance);
  const close = Engine.compileShot({ canon: appearance, shot: { ...shot, axisValues: { shot: '特写' } } });
  assert.equal(close.blocked, false, close.conflicts.join('\n'));
  assert.match(close.prompt, /全身银色鳞片/);
});

test('unresolved variable contradictions block generation with the conflicting source', () => {
  const frozen = Engine.compileShot({ canon: { ...canon, lens: {}, anchorSentence: '胶片摄影，固定半身。' },
    shot: { ...shot, axisValues: { shot: '全身' } } });
  assert.equal(frozen.blocked, true);
  assert.ok(frozen.conflicts.some(line => line.includes('共同设定') && line.includes('固定半身') && line.includes('全身')));
  const negative = Engine.compileShot({ canon: { ...canon, negative: ['全身'] }, shot: { ...shot, axisValues: { shot: '全身' } } });
  assert.ok(negative.conflicts.some(line => line.includes('负向约束')));
  const detail = Engine.compileShot({ canon, shot: { ...shot, detail: '固定半身构图', axisValues: { shot: '全身' } } });
  assert.ok(detail.conflicts.some(line => line.includes('本帧描述')));
  const reference = Engine.compileShot({ canon, gallery,
    shot: { ...shot, axisValues: { shot: '全身' }, references: [{ assetId: 'ast_style', preserve: '保持半身构图' }] } });
  assert.ok(reference.conflicts.some(line => line.includes('参考图1保留要求')));
  const allowed = Engine.compileShot({ canon, shot: { ...shot, detail: '不要半身', axisValues: { shot: '全身' } } });
  assert.equal(allowed.blocked, false);
});

test('conflicting variable axes and identity changes cannot silently override stable constraints', () => {
  const conflict = Engine.compileShot({ canon, axes: [{ id: 'custom', label: '景别', values: ['特写'] }],
    shot: { ...shot, axisValues: { shot: '全身', custom: '特写' } } });
  assert.equal(conflict.blocked, true);
  const identity = Engine.compileShot({ canon: { ...canon, characterLook: '短黑发' },
    axes: [{ id: 'hair', label: '发色', values: ['红发'] }], shot: { ...shot, axisValues: { hair: '红发' } } });
  assert.ok(identity.conflicts.some(line => line.includes('角色稳定外观')));
});

test('variable values survive trimming and preview includes the exact API suffix once', () => {
  const axes = [{ id: 'custom', label: '自定义要求', values: [] }];
  const input = { canon, axes, gallery, size: '1024x1024', quality: 'medium', requirements: generationRequirements,
    shot: { ...shot, axisValues: { custom: '结尾标记' }, detail: '细节描述。'.repeat(3000),
      references: [{ assetId: 'ast_style', purpose: 'custom', customPurpose: '纸张材质', preserve: '纸纹' }] } };
  const result = Engine.compileShot(input);
  assert.equal(result.overLimit, false);
  assert.match(result.prompt, /自定义要求：结尾标记/);
  const suffix = (formatReferenceGuidance([{ purpose: '', customPurpose: '纸张材质', preserve: '纸纹', change: '主体与构图' }])
    + generationRequirements(input)).replace(/\r?\n/g, '\r\n');
  assert.equal(result.prompt.slice(-suffix.length), suffix);
  assert.equal(result.prompt.slice(0, -suffix.length), result.requestPrompt.replace(/\r?\n/g, '\r\n'));
  assert.equal(result.characters, result.prompt.length);
  assert.equal(result.prompt.split('【本次生成要求】').length - 1, 1);
  const oversized = Engine.compileShot({ canon, limit: 100, axes, shot: { ...shot, axisValues: { custom: '值'.repeat(300) + '完整结尾' } } });
  assert.equal(oversized.overLimit, true);
  assert.match(oversized.prompt, /完整结尾/);
});

test('old frames without selected variables retain their anchor and do not acquire variable rules', () => {
  const a = Engine.compileShot({ canon, shot });
  const b = Engine.compileShot({ canon, shot: { ...shot, axisValues: { time: '' } } });
  assert.equal(a.anchor, canon.anchorSentence);
  assert.equal(a.prompt, b.prompt);
  assert.doesNotMatch(a.prompt, /本帧变量/);
  assert.equal(a.blocked, false);
});

test('expands axis combinations', () => {
  const { combinations, total } = Engine.expandMatrix([
    { id: 'scene', values: ['邮局', '天桥'] },
    { id: 'time', values: ['雨夜', '凌晨', '停电'] }
  ]);
  assert.equal(total, 6);
  assert.equal(combinations.length, 6);
  assert.deepEqual(combinations[0], { scene: '邮局', time: '雨夜' });
});

test('caps matrix expansion at the axis limit', () => {
  const axes = Array.from({ length: 4 }, (_, index) => ({
    id: 'axis' + index,
    values: Array.from({ length: 6 }, (_, value) => 'v' + value)
  }));
  const { combinations, truncated } = Engine.expandMatrix(axes);
  assert.equal(truncated, true);
  assert.equal(combinations.length, Engine.AXIS_LIMIT);
});

test('ignores empty axes', () => {
  assert.equal(Engine.expandMatrix([]).total, 0);
  assert.equal(Engine.expandMatrix([{ id: 'a', values: [] }]).total, 0);
});

test('1152 combinations report their full count and include all three axes in the first 200', () => {
  const values = Array.from({ length: 24 }, (_, index) => 'v' + index);
  const result = Engine.expandMatrix([{ id: 'a', values }, { id: 'b', values }, { id: 'c', values: ['x', 'y'] }]);
  assert.equal(result.total, 1152);
  assert.equal(result.truncated, true);
  assert.equal(result.combinations.length, 200);
  assert.ok(result.combinations.every(combo => Object.keys(combo).length === 3));
  assert.deepEqual(result.combinations[0], { a: 'v0', b: 'v0', c: 'x' });
  assert.deepEqual(result.combinations[1], { a: 'v0', b: 'v0', c: 'y' });
  assert.equal(new Set(result.combinations.map(Engine.matrixKey)).size, 200);
});

test('large products keep exact totals beyond safe integers while returning only complete bounded results', () => {
  const values = Array.from({ length: 24 }, (_, index) => String(index));
  const result = Engine.expandMatrix(Array.from({ length: 16 }, (_, index) => ({ id: 'a' + index, values })));
  assert.equal(result.total, (24n ** 16n).toString());
  assert.equal(result.combinations.length, 200);
  assert.ok(result.combinations.every(combo => Object.keys(combo).length === 16));
});

test('matrix keys ignore insertion order and empty selections, and invalid axes never overwrite each other', () => {
  assert.equal(Engine.matrixKey({ time: '雨夜', shot: '全身' }), Engine.matrixKey({ shot: '全身', unused: '', time: ' 雨夜 ' }));
  assert.notEqual(Engine.matrixKey({ time: '雨夜' }), Engine.matrixKey({ time: '清晨' }));
  const result = Engine.expandMatrix([{ id: 'x', values: [' a ', 'a', '', 'b'] }, { id: 'empty', values: [] }]);
  assert.equal(result.total, 2);
  assert.deepEqual(result.combinations, [{ x: 'a' }, { x: 'b' }]);
  const duplicate = Engine.expandMatrix([{ id: 'x', values: ['a'] }, { id: 'x', values: ['b'] }]);
  assert.equal(duplicate.combinations.length, 0);
  assert.match(duplicate.errors[0], /重复/);
});

// ---------------------------------------------------------------- import/export

test('round-trips a series export', () => {
  const payload = Engine.exportSeries({
    series: { id: 'srs_1', title: '雨夜邮差', canon },
    shots: [shot],
    assets: [{ id: 'ast_char', role: 'character', name: '主角' }],
    lore: [{ id: 'lore_1', text: '设定' }]
  });
  assert.equal(payload.format, 'prompt-studio-series');
  assert.equal(Engine.validateImport(payload).ok, true);
  const restored = Engine.normalizeImportedSeries(payload, { newId: 'srs_2' });
  assert.equal(restored.series.id, 'srs_2');
  assert.equal(restored.shots[0].seriesId, 'srs_2');
  assert.equal(restored.assets[0].seriesId, 'srs_2');
});

test('rejects malformed series packages', () => {
  assert.equal(Engine.validateImport(null).ok, false);
  assert.equal(Engine.validateImport({ format: 'other' }).ok, false);
  assert.equal(Engine.validateImport({ format: 'prompt-studio-series', version: 99, series: { id: 'a', title: 'b', canon: {} } }).ok, false);
  assert.throws(() => Engine.normalizeImportedSeries({ format: 'nope' }), /不是 Prompt Studio 系列包/);
});

test('pending remote results survive package import with new ownership and reference IDs', () => {
  const payload = Engine.exportSeries({
    series: { id: 'original', title: '待保存', canon: {} },
    shots: [{ id: 'frame', seriesId: 'original', status: 'pending-save', result: { assetId: 'old' },
      pendingGeneration: { id: 'pending', persisted: true,
        asset: { id: 'new', seriesId: 'original', shotId: 'frame', role: 'output', data: 'https://example.com/image.png' },
        result: { assetId: 'new', prompt: '启动时提示词', parameters: { model: 'snapshot' }, references: [{ assetId: 'ref', purpose: 'style' }] } } }],
    assets: [{ id: 'old', shotId: 'frame', role: 'output' }, { id: 'ref', role: 'style' }]
  });
  const source = JSON.stringify(payload);
  const restored = Engine.normalizeImportedSeries(JSON.parse(source), { newId: 'copy' });
  const frame = restored.shots[0];
  const pending = frame.pendingGeneration;
  assert.equal(pending.asset.seriesId, 'copy');
  assert.equal(pending.asset.shotId, frame.id);
  assert.equal(pending.asset.id, pending.result.assetId);
  assert.notEqual(pending.asset.id, 'new');
  assert.equal(pending.result.references[0].assetId, restored.assets[1].id);
  assert.equal(pending.result.prompt, '启动时提示词');
  assert.equal(pending.result.parameters.model, 'snapshot');
  assert.equal(frame.result.assetId, restored.assets[0].id);
  assert.equal(pending.asset.data, 'https://example.com/image.png');
  assert.equal(JSON.stringify(payload), source);
  const invalid = JSON.parse(source);
  invalid.shots[0].pendingGeneration.asset.seriesId = 'another-series';
  assert.equal(Engine.validateImport(invalid).ok, false);
  invalid.shots[0].pendingGeneration.asset = null;
  assert.equal(Engine.validateImport(invalid).ok, false);
});

test('hashString is deterministic and differs on change', () => {
  assert.equal(Engine.hashString('abc'), Engine.hashString('abc'));
  assert.notEqual(Engine.hashString('abc'), Engine.hashString('abd'));
  assert.match(Engine.hashString('abc'), /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------- templates

test('every built-in template compiles cleanly', () => {
  assert.equal(TEMPLATES.length, 5);
  for (const template of TEMPLATES) {
    const templateCanon = { ...template.canon, version: 1 };
    const anchor = Engine.renderAnchor(templateCanon);
    assert.ok(anchor.length > 20, template.id + ' anchor too short');
    const axisIds = new Set((template.axes || []).map(axis => axis.id));
    assert.ok(template.shots.length >= 2, template.id + ' needs frames');
    for (const item of template.shots) {
      const shot = {
        ...item,
        references: []
      };
      const compiled = Engine.compileShot({ canon: { ...templateCanon, anchorSentence: anchor }, shot, axes: template.axes, gallery: [] });
      assert.equal(compiled.overLimit, false, template.id + '/' + item.code + ' overflowed');
      assert.equal(compiled.blocked, false, template.id + '/' + item.code + ': ' + compiled.conflicts.join(' '));
      assert.ok(!compiled.warnings.some(line => line.includes('未定义的占位符')), template.id + '/' + item.code + ': ' + compiled.warnings.join(' '));
      for (const key of Object.keys(item.axisValues || {})) {
        assert.ok(axisIds.has(key), template.id + ' uses undeclared axis ' + key);
      }
    }
  }
});

test('importing as a new series re-keys child records instead of overwriting the source', () => {
  const payload = Engine.exportSeries({
    series: { id: 'srs_1', title: 'T', canon: {}, gallery: { defaults: { style: 'ast_style' } } },
    shots: [{
      id: 'sht_1',
      seriesId: 'srs_1',
      references: [{ assetId: 'ast_style', slot: 'style' }],
      loreRefs: ['lore_1'],
      result: { assetId: 'ast_out' }
    }],
    assets: [
      { id: 'ast_style', role: 'style' },
      { id: 'ast_out', role: 'output', shotId: 'sht_1' }
    ],
    lore: [{ id: 'lore_1', text: '设定' }]
  });
  const restored = Engine.normalizeImportedSeries(payload, { newId: 'srs_2' });
  assert.notEqual(restored.shots[0].id, 'sht_1');
  assert.equal(restored.shots[0].seriesId, 'srs_2');
  assert.equal(restored.shots[0].references[0].assetId, restored.assets[0].id);
  assert.equal(restored.shots[0].result.assetId, restored.assets[1].id);
  assert.equal(restored.shots[0].loreRefs[0], restored.lore[0].id);
  assert.equal(restored.assets[1].shotId, restored.shots[0].id);
  assert.equal(restored.series.gallery.defaults.style, restored.assets[0].id);
  // Re-importing under the same id is an explicit overwrite and keeps the original keys.
  const overwritten = Engine.normalizeImportedSeries(payload, { newId: 'srs_1' });
  assert.equal(overwritten.shots[0].id, 'sht_1');
});
