(function (root) {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const Engine = root.SeriesEngine;
  const Llm = root.SeriesLlm;
  const Prompts = root.SeriesPrompts;

  if (!Engine || !Llm) return;

  const store = root.createSeriesStore();
  const IMAGE_LIMIT = 1.5 * 1024 * 1024;
  const FRAME_TOTAL_LIMIT = 6 * 1024 * 1024;
  const LONG_EDGE = 2048;

  const state = {
    series: null,
    list: [],
    shots: [],
    assets: [],
    lore: [],
    view: 'outline',
    selectedShotId: null,
    // Frames ticked for batch generation, independent of the inspector selection.
    selectedShotIds: new Set(),
    busy: false,
    generationTask: null,
    volatileGenerations: new Map(),
    openRequest: null,
    uploads: new Map(),
    modelTasks: new Map(),
    extractTask: null,
    splitTask: null,
    extracting: false,
    analyzing: false,
    batch: null,
    llm: null
  };

  // ---------------------------------------------------------------- helpers

  function status(message, type = 'info') {
    const node = $('#seriesStatus');
    if (!node) return;
    node.textContent = message;
    node.dataset.type = type;
    node.hidden = !message;
  }

  function clearStatus() {
    const node = $('#seriesStatus');
    if (node) node.hidden = true;
  }

  function isCurrentSeries(seriesId) {
    return state.series?.id === seriesId;
  }

  function isVisibleSeries(seriesId) {
    return isCurrentSeries(seriesId) && !$('#seriesPage').hidden;
  }

  function isGeneratingShot(shot) {
    return state.generationTask?.seriesId === shot.seriesId && state.generationTask.shotId === shot.id;
  }

  function beginModelTask(type, seriesId, targetId = '') {
    const key = JSON.stringify([type, seriesId, targetId]);
    if (state.modelTasks.has(key)) return null;
    const task = { id: uid('model'), key, type, seriesId, targetId, cancelled: false };
    state.modelTasks.set(key, task);
    return task;
  }

  function finishModelTask(task) {
    if (state.modelTasks.get(task.key) === task) state.modelTasks.delete(task.key);
  }

  function modelStatus(task, message, type) {
    if (isVisibleSeries(task.seriesId)) status(message, type);
  }

  function syncSeriesRecord(series) {
    if (!series) return;
    const index = state.list.findIndex(item => item.id === series.id);
    if (index >= 0) state.list[index] = series;
    if (isCurrentSeries(series.id)) state.series = series;
    renderSeriesList();
  }

  function syncAssetRecord(asset) {
    if (!asset || !isCurrentSeries(asset.seriesId)) return;
    const index = state.assets.findIndex(item => item.id === asset.id);
    if (index >= 0) state.assets[index] = asset;
    else state.assets.push(asset);
  }

  // A single in-app confirmation dialog replaces window.confirm for every destructive or
  // billable action, so the look matches the rest of the workspace.
  let pendingConfirm = null;

  function confirmAction({ title = '确认操作', text = '', confirmLabel = '确定', danger = true }) {
    return new Promise(resolve => {
      const dialog = $('#seriesConfirmDialog');
      if (!dialog) { resolve(window.confirm(text)); return; }
      pendingConfirm = resolve;
      $('#seriesConfirmTitle').textContent = title;
      $('#seriesConfirmText').textContent = text;
      const ok = $('#seriesConfirmOk');
      ok.textContent = confirmLabel;
      ok.classList.toggle('confirm-delete', danger);
      ok.classList.toggle('confirm-primary', !danger);
      dialog.returnValue = 'cancel';
      if (!dialog.open) dialog.showModal();
    });
  }

  function settleConfirm(value) {
    const resolve = pendingConfirm;
    pendingConfirm = null;
    if (resolve) resolve(value === 'confirm');
  }

  function uid(prefix) {
    return prefix + '_' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10));
  }

  function bytes(value) {
    if (!value) return '—';
    return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(value / 1024)) + ' KB';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function imageConfig() {
    const config = {
      apiUrl: ($('#apiUrl')?.value || '').trim(),
      apiKey: ($('#apiKey')?.value || '').trim(),
      model: ($('#model')?.value || '').trim(),
      capabilities: readCapabilities()
    };
    return config;
  }

  function readCapabilities() {
    try {
      const raw = localStorage.getItem('prompt-studio-capabilities');
      if (!raw) return { mode: 'auto' };
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { mode: 'auto' };
    } catch { return { mode: 'auto' }; }
  }

  // Render settings follow the create page too: there is no per-series size/quality UI, so
  // reading the live composer values keeps the series consistent with what the user set.
  function renderConfig() {
    return {
      size: $('#size')?.value || 'default',
      quality: $('#quality')?.value || 'default',
      responseFormat: $('#responseFormat')?.value || 'auto'
    };
  }

  // Series model calls use the same path as 优化提示词: the optimizer configuration and the
  // same Chat Completions forwarding. That path is already known to work with the provider,
  // whereas the image model often rejects chat requests. Falls back to the create page
  // settings so a single configuration still works.
  function optimizerConfig() {
    const optimizer = {
      apiUrl: $('#optimizerUrl')?.value.trim() || '',
      apiKey: $('#optimizerKey')?.value.trim() || '',
      model: $('#optimizerModel')?.value.trim() || ''
    };
    if (optimizer.apiUrl && optimizer.apiKey && optimizer.model) return { ...optimizer, source: 'optimizer' };
    const image = {
      apiUrl: $('#apiUrl')?.value.trim() || '',
      apiKey: $('#apiKey')?.value.trim() || '',
      model: $('#model')?.value.trim() || ''
    };
    if (image.apiUrl && image.apiKey && image.model) return { ...image, source: 'image' };
    return { ...optimizer, source: 'none' };
  }

  function hasOptimizer() {
    return optimizerConfig().source !== 'none';
  }

  function requireOptimizer() {
    if (hasOptimizer()) return true;
    status('系列提炼、看图与建议帧都复用「提示词优化 API」：请在 设置 → 提示词优化 API 中填写 URL、Key 和文本模型。', 'error');
    return false;
  }

  async function post(route, body, signal) {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('本地服务未返回有效数据，请确认服务仍在运行。');
    }
    if (!response.ok) {
      // A 404 on a series route almost always means the Node process predates this build;
      // the page is new but the server was started before the update.
      const missing = response.status === 404 && route.startsWith('/api/series/');
      const error = new Error(missing
        ? '本地服务没有这个接口。通常是服务进程还是旧版本：请结束正在运行的 node server.js，重新运行 npm start 后刷新页面。'
        : (data.error || '请求失败'));
      error.status = response.status;
      error.diagnostic = data.diagnostic;
      throw error;
    }
    return data;
  }

  function describeError(error) {
    const diagnostic = error?.diagnostic;
    if (diagnostic?.label) return diagnostic.label + '：' + (diagnostic.suggestion || error.message);
    return error?.message || '请求失败';
  }

  // ---------------------------------------------------------------- image compression

  function supportsWebp() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.toDataURL('image/webp').startsWith('data:image/webp');
    } catch { return false; }
  }

  const WEBP = supportsWebp();

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('图片编码失败'))), type, quality);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  async function hashBlob(blob) {
    if (!crypto.subtle) return '';
    try {
      const buffer = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { return ''; }
  }

  // Uploaded references are re-encoded on the way in: the API accepts at most 4 images and
  // 20 MB per request, and base64 inflates by a third, so raw phone photos would not fit.
  async function compressImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, width, height);
    const original = { width: bitmap.width, height: bitmap.height, bytes: file.size };
    bitmap.close();
    const type = WEBP ? 'image/webp' : 'image/jpeg';
    let quality = 0.92;
    let blob = await toBlob(canvas, type, quality);
    while (blob.size > IMAGE_LIMIT && quality > 0.5) {
      quality -= 0.08;
      blob = await toBlob(canvas, type, quality);
    }
    const data = await blobToDataUrl(blob);
    return {
      mime: blob.type || type,
      data,
      width,
      height,
      bytes: blob.size,
      original,
      sha256: await hashBlob(blob)
    };
  }

  // ---------------------------------------------------------------- series lifecycle

  function blankCanon() {
    return {
      version: 1,
      medium: '',
      palette: [],
      lighting: { key: '', ratio: '', direction: '', colorTemp: '' },
      lens: { focal: '', aperture: '', distance: '', angle: '' },
      composition: { frame: '', placement: '', negativeSpace: '', horizon: '' },
      grade: { contrast: '', saturation: '', shadows: '', highlights: '' },
      material: { render: '', texture: '', finish: '' },
      terms: {},
      characterLook: '',
      atmosphere: '',
      negative: [],
      anchorSentence: ''
    };
  }

  function blankSeries(name, theme) {
    const now = Date.now();
    return {
      id: uid('srs'),
      title: name,
      theme: {
        statement: theme || '',
        keywords: [],
        mood: [],
        era: '',
        place: '',
        taboos: [],
        source: null
      },
      canon: blankCanon(),
      locks: ['palette', 'lighting', 'lens', 'grade', 'medium', 'terms', 'characterLook'],
      axes: [],
      gallery: { defaults: {}, maxPerShot: 4 },
      // Render settings are not stored per series: they follow the create page so a series
      // cannot silently use a stale size or quality.
      createdAt: now,
      updatedAt: now
    };
  }

  async function saveSeries(patch = {}) {
    if (!state.series) return;
    const series = state.series;
    Object.assign(series, patch, { updatedAt: Date.now() });
    series.canon.anchorSentence = Engine.renderAnchor(series.canon);
    await store.putSeries(series);
    // Keep the sidebar entry in sync; without this it keeps showing the old canon version.
    const index = state.list.findIndex(item => item.id === series.id);
    if (index >= 0) state.list[index] = series;
    else state.list.unshift(series);
    state.list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderHeader();
    renderSeriesList();
  }

  async function openSeries(id) {
    const request = { id };
    state.openRequest = request;
    let bundle;
    try { bundle = await store.readSeriesBundle(id); }
    catch (error) {
      if (state.openRequest === request) {
        state.openRequest = null;
        status('无法读取系列：' + describeError(error), 'error');
      }
      return false;
    }
    if (state.openRequest !== request) return false;
    state.openRequest = null;
    const { series, shots, assets, lore } = bundle;
    if (!series) return false;
    for (const shot of shots) {
      const pending = state.volatileGenerations.get(shot.id);
      if (!pending) continue;
      if (shot.pendingGeneration && shot.pendingGeneration.id !== pending.id) {
        state.volatileGenerations.delete(shot.id);
      } else {
        shot.pendingGeneration = pending;
        shot.status = 'pending-save';
      }
    }
    state.series = series;
    state.selectedShotId = null;
    state.selectedShotIds.clear();
    state.shots = shots;
    state.assets = assets;
    state.lore = lore;
    $('#seriesMain').hidden = false;
    $('#seriesInspector').hidden = true;
    $('#seriesName').value = series.title || '';
    $('#seriesExport').disabled = false;
    renderAll();
    closeInspector();
    renderSeriesList();
    clearStatus();
    if (state.generationTask?.seriesId === id) {
      status(state.generationTask.saving ? '正在保存 ' + state.generationTask.code + ' 的图片。' : '正在生成 ' + state.generationTask.code + '，最多等待 5 分钟。');
    } else if (shots.some(shot => shot.pendingGeneration)) {
      status('有图片待保存，请打开对应画面重试保存；不会重新调用生图模型。');
    }
    return true;
  }

  function closeSeries() {
    state.openRequest = null;
    state.series = null;
    state.shots = [];
    state.assets = [];
    state.lore = [];
    $('#seriesMain').hidden = true;
    $('#seriesInspector').hidden = true;
    document.querySelector('.series-layout')?.classList.remove('has-inspector');
    $('#seriesExport').disabled = true;
    renderSeriesList();
  }

  async function loadSeriesList() {
    try {
      state.list = await store.listSeries();
    } catch (error) {
      status('无法读取系列数据：' + describeError(error), 'error');
      state.list = [];
    }
    $('#seriesCount').textContent = String(state.list.length).padStart(2, '0');
    renderSeriesList();
  }

  function renderSeriesList() {
    const list = $('#seriesList');
    list.replaceChildren(...state.list.map(series => {
      const item = el('li', 'series-list-item');
      item.dataset.seriesId = series.id;
      if (state.series && series.id === state.series.id) item.classList.add('is-active');
      const open = button('', 'series-list-open', () => openSeries(series.id));
      open.append(
        el('strong', 'series-list-name', series.title || '未命名系列'),
        el('span', 'series-list-meta', '圣经 v' + (series.canon?.version || 1) + ' · ' + new Date(series.updatedAt || Date.now()).toLocaleDateString('zh-CN'))
      );
      const remove = button('×', 'series-list-remove', async event => {
        event.stopPropagation();
        if (state.generationTask?.seriesId === series.id) return;
        const ok = await confirmAction({
          title: '删除系列',
          text: '删除「' + (series.title || '未命名') + '」及其全部帧和图片？此操作无法撤销。',
          confirmLabel: '删除'
        });
        if (!ok || state.generationTask?.seriesId === series.id) return;
        if (state.openRequest?.id === series.id) state.openRequest = null;
        await store.deleteSeries(series.id);
        for (const [shotId, pending] of state.volatileGenerations) {
          if (pending.asset.seriesId === series.id) state.volatileGenerations.delete(shotId);
        }
        if (state.series && state.series.id === series.id) closeSeries();
        await loadSeriesList();
        status('已删除系列。');
      });
      remove.setAttribute('aria-label', '删除系列 ' + (series.title || ''));
      remove.dataset.action = 'delete-series';
      remove.disabled = state.generationTask?.seriesId === series.id;
      remove.title = remove.disabled ? '此系列正在生成，完成后可删除' : '删除系列';
      if (remove.disabled) remove.setAttribute('aria-label', '此系列正在生成，完成后可删除');
      item.append(open, remove);
      return item;
    }));
    $('#seriesListEmpty').hidden = state.list.length > 0;
  }

  // ---------------------------------------------------------------- header

  function renderHeader() {
    const series = state.series;
    if (!series) return;
    $('#seriesVersionBadge').textContent = '圣经 v' + (series.canon?.version || 1);
    $('#seriesGalleryBadge').textContent = '图库 ' + state.assets.filter(asset => asset.role !== 'output').length + ' 张';
    const done = state.shots.filter(shot => shot.result?.assetId).length;
    $('#seriesProgressBadge').textContent = done + ' / ' + state.shots.length + ' 帧出图';
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('[data-series-view]').forEach(node => {
      if (node.classList.contains('series-view')) node.hidden = node.dataset.seriesView !== view;
    });
    document.querySelectorAll('.series-tabs [data-series-view]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.seriesView === view));
    });
    if (view === 'matrix') renderMatrix();
    if (view === 'gallery') renderGallery();
    if (view === 'canon') renderCanon();
    if (view === 'lore') renderLore();
    if (view === 'outline') renderShots();
  }

  function renderAll() {
    renderHeader();
    renderShots();
    setView(state.view);
  }

  // ---------------------------------------------------------------- canon

  const CANON_GROUPS = [
    {
      title: '媒介与质感',
      fields: [
        ['medium', '媒介', '35mm 胶片摄影'],
        ['material.render', '渲染方式', '真实摄影'],
        ['material.texture', '质感', '胶片颗粒'],
        ['material.finish', '表面处理', '轻微眩光']
      ]
    },
    {
      title: '光线',
      fields: [
        ['lighting.key', '主光', '单侧钠灯硬光'],
        ['lighting.ratio', '光比', '1:8'],
        ['lighting.direction', '方向', '左后侧'],
        ['lighting.colorTemp', '色温', '2700K 主光 + 5600K 环境']
      ]
    },
    {
      title: '镜头',
      fields: [
        ['lens.focal', '焦距', '35mm'],
        ['lens.aperture', '光圈', 'f/2.0'],
        ['lens.distance', '景别', '中景'],
        ['lens.angle', '机位角度', '平视略低']
      ]
    },
    {
      title: '构图',
      fields: [
        ['composition.frame', '画幅', '3:2 横构图'],
        ['composition.placement', '主体位置', '主体偏左三分'],
        ['composition.negativeSpace', '留白', '上方留出雨幕'],
        ['composition.horizon', '地平线', '低地平线']
      ]
    },
    {
      title: '调色',
      fields: [
        ['grade.contrast', '对比度', '高对比'],
        ['grade.saturation', '饱和度', '低饱和'],
        ['grade.shadows', '阴影色调', '青黑压暗'],
        ['grade.highlights', '高光色调', '橙黄溢出']
      ]
    },
    {
      title: '角色与氛围',
      fields: [
        ['characterLook', '角色稳定外观', '短黑发微湿，深灰呢大衣', 'long'],
        ['atmosphere', '整体气质', '克制忧郁的近未来沿海旧城']
      ]
    }
  ];

  function readPath(object, path) {
    return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : ''), object) || '';
  }

  function writePath(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let target = object;
    for (const key of keys) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      target = target[key];
    }
    target[last] = value;
  }

  function renderCanon() {
    const series = state.series;
    if (!series) return;
    const canon = series.canon;
    const form = $('#seriesCanonForm');
    const groups = CANON_GROUPS.map(group => {
      const fieldset = el('fieldset', 'series-canon-group');
      fieldset.append(el('legend', '', group.title));
      for (const [path, label, placeholder, kind] of group.fields) {
        const row = el('label', 'series-canon-field');
        row.append(el('span', '', label));
        const input = kind === 'long' ? el('textarea') : el('input');
        if (kind === 'long') input.rows = 2;
        else input.type = 'text';
        input.value = readPath(canon, path);
        input.placeholder = placeholder || '';
        input.dataset.canonPath = path;
        input.addEventListener('input', () => {
          writePath(canon, path, input.value);
          series.canonDirty = true;
          updateAnchorPreview();
        });
        row.append(input);
        fieldset.append(row);
      }
      return fieldset;
    });

    // Palette
    const paletteGroup = el('fieldset', 'series-canon-group');
    paletteGroup.append(el('legend', '', '色板'));
    const paletteList = el('div', 'series-palette');
    canon.palette.forEach((entry, index) => {
      const row = el('div', 'series-palette-row');
      const name = el('input');
      name.type = 'text';
      name.value = entry.name || '';
      name.placeholder = '颜色名';
      name.setAttribute('aria-label', '第 ' + (index + 1) + ' 个颜色名称');
      name.addEventListener('input', () => { entry.name = name.value; series.canonDirty = true; updateAnchorPreview(); });
      const hex = el('input');
      hex.type = 'color';
      hex.value = /^#[0-9a-f]{6}$/.test(entry.hex || '') ? entry.hex : '#808080';
      hex.setAttribute('aria-label', '第 ' + (index + 1) + ' 个颜色');
      hex.addEventListener('input', () => { entry.hex = hex.value; series.canonDirty = true; });
      const remove = button('×', 'series-palette-remove', () => {
        canon.palette.splice(index, 1);
        series.canonDirty = true;
        renderCanon();
      });
      remove.setAttribute('aria-label', '移除颜色 ' + (entry.name || index + 1));
      row.append(name, hex, remove);
      paletteList.append(row);
    });
    paletteList.append(button('＋ 添加颜色', 'text-action', () => {
      canon.palette.push({ name: '', hex: '#808080', weight: 0.3 });
      series.canonDirty = true;
      renderCanon();
    }));
    paletteGroup.append(paletteList);

    // Terms
    const termGroup = el('fieldset', 'series-canon-group');
    termGroup.append(el('legend', '', '术语表'));
    const termHint = el('p', 'field-hint', '在帧描述里写 {{hero}} 这样的占位符，编译时会替换成这里填的名字。');
    termGroup.append(termHint);
    const termList = el('div', 'series-terms');
    for (const [key, value] of Object.entries(canon.terms)) {
      const row = el('div', 'series-term-row');
      const keyInput = el('input');
      keyInput.type = 'text';
      keyInput.value = key;
      keyInput.placeholder = 'hero';
      keyInput.setAttribute('aria-label', '占位符名称');
      keyInput.addEventListener('change', () => {
        const next = keyInput.value.trim();
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(next) || Object.hasOwn(canon.terms, next)) { keyInput.value = key; return; }
        delete canon.terms[key];
        canon.terms[next] = value;
        series.canonDirty = true;
        renderCanon();
      });
      const valueInput = el('input');
      valueInput.type = 'text';
      valueInput.value = value || '';
      valueInput.placeholder = '替换成的名字';
      valueInput.setAttribute('aria-label', '术语 ' + key + ' 的值');
      valueInput.addEventListener('input', () => { canon.terms[key] = valueInput.value; series.canonDirty = true; });
      const remove = button('×', 'series-palette-remove', () => {
        delete canon.terms[key];
        series.canonDirty = true;
        renderCanon();
      });
      remove.setAttribute('aria-label', '移除术语 ' + key);
      row.append(keyInput, valueInput, remove);
      termList.append(row);
    }
    termList.append(button('＋ 添加术语', 'text-action', () => {
      let index = 1;
      while (Object.hasOwn(canon.terms, 'term' + index)) index++;
      canon.terms['term' + index] = '';
      series.canonDirty = true;
      renderCanon();
    }));
    termGroup.append(termList);

    // Negative
    const negativeGroup = el('fieldset', 'series-canon-group');
    negativeGroup.append(el('legend', '', '负向约束'));
    const negativeInput = el('input');
    negativeInput.type = 'text';
    negativeInput.value = (canon.negative || []).join('、');
    negativeInput.placeholder = '水印、文字、多余人物';
    negativeInput.addEventListener('input', () => {
      canon.negative = negativeInput.value.split(/[、,，;；]/).map(item => item.trim()).filter(Boolean).slice(0, 8);
      series.canonDirty = true;
    });
    negativeGroup.append(negativeInput);
    negativeGroup.append(el('p', 'field-hint', '用顿号或逗号分隔。编译时会写成「避免……」追加在提示词末尾。'));

    // Axes
    const axisGroup = el('fieldset', 'series-canon-group');
    axisGroup.append(el('legend', '', '可变轴'));
    axisGroup.append(el('p', 'field-hint', '每个轴是一组取值。矩阵视图会按轴展开帧。'));
    (series.axes || []).forEach((axis, index) => {
      const row = el('div', 'series-axis-row');
      row.dataset.axisId = axis.id;
      const label = el('input');
      label.type = 'text';
      label.value = axis.label || '';
      label.placeholder = '轴名称，如场景';
      label.setAttribute('aria-label', '第 ' + (index + 1) + ' 个轴名称');
      label.addEventListener('input', () => { axis.label = label.value; series.canonDirty = true; });
      const values = el('input');
      values.type = 'text';
      values.value = (axis.values || []).join('、');
      values.placeholder = '取值，用顿号分隔';
      values.setAttribute('aria-label', '第 ' + (index + 1) + ' 个轴的取值');
      values.addEventListener('input', () => {
        axis.values = values.value.split(/[、,，;；]/).map(item => item.trim()).filter(Boolean).slice(0, 24);
        series.canonDirty = true;
      });
      const remove = button('×', 'series-palette-remove', () => {
        series.axes.splice(index, 1);
        series.canonDirty = true;
        renderCanon();
      });
      remove.setAttribute('aria-label', '移除轴 ' + (axis.label || index + 1));
      remove.dataset.action = 'remove-axis';
      row.append(label, values, remove);
      axisGroup.append(row);
    });
    const addAxis = button('＋ 添加轴', 'text-action', () => {
      series.axes = series.axes || [];
      const used = new Set([...series.axes.map(axis => axis.id), ...state.shots.flatMap(shot => Object.keys(shot.axisValues || {}))]);
      let id;
      do { id = uid('axis'); } while (used.has(id));
      series.axes.push({ id, label: '', values: [] });
      series.canonDirty = true;
      renderCanon();
    });
    addAxis.dataset.action = 'add-axis';
    axisGroup.append(addAxis);

    form.replaceChildren(...groups, paletteGroup, termGroup, negativeGroup, axisGroup);
    updateAnchorPreview();
  }

  function updateAnchorPreview() {
    const series = state.series;
    if (!series) return;
    const anchor = Engine.renderAnchor(series.canon);
    series.canon.anchorSentence = anchor;
    $('#seriesAnchorPreview').textContent = anchor || '还没有足够的信息生成锚点句。至少填写媒介、光线或色板。';
    $('#seriesAnchorChars').textContent = String(anchor.length);
    $('#seriesCanonVersion').textContent = String(series.canon.version || 1);
    const warning = $('#seriesCanonWarning');
    if (anchor.length > Engine.BUDGET.anchor) {
      warning.hidden = false;
      warning.textContent = '锚点句已超过 ' + Engine.BUDGET.anchor + ' 字符，建议精简，否则会挤占每帧的描述预算。';
    } else if (series.canonDirty) {
      warning.hidden = false;
      warning.textContent = '有未保存的改动。点击「保存为新手版本」才会写入新版本号。';
    } else {
      warning.hidden = true;
    }
  }

  async function saveCanonVersion() {
    const series = state.series;
    if (!series) return;
    series.canon.version = (series.canon.version || 1) + 1;
    series.canon.anchorSentence = Engine.renderAnchor(series.canon);
    series.canonDirty = false;
    await saveSeries();
    updateAnchorPreview();
    status('已保存为圣经 v' + series.canon.version + '。已生成的帧仍保留原版本号。', 'success');
  }

  // ---------------------------------------------------------------- shots

  // New frames inherit the series-level anchors so the common case needs no manual setup.
  // The user can still override or clear each slot per frame.
  function inheritedReferences(series = state.series, assets = state.assets) {
    const defaults = series?.gallery?.defaults || {};
    return ['character', 'style', 'scene', 'prop']
      .filter(slot => defaults[slot] && assets.some(asset => asset.id === defaults[slot]))
      .map(slot => ({ assetId: defaults[slot], slot }));
  }

  function newShot(index, series = state.series, assets = state.assets) {
    return {
      id: uid('sht'),
      seriesId: series.id,
      order: index,
      index,
      code: 'S' + String(index + 1).padStart(2, '0'),
      title: '',
      beat: '',
      subject: '',
      action: '',
      scene: '',
      detail: '',
      negative: [],
      axisValues: {},
      references: inheritedReferences(series, assets),
      loreRefs: [],
      status: 'draft',
      origin: 'manual',
      canonVersion: series.canon.version || 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async function persistShot(shot) {
    shot.updatedAt = Date.now();
    await store.putShot(shot);
    if (!isCurrentSeries(shot.seriesId)) return;
    const index = state.shots.findIndex(item => item.id === shot.id);
    if (index >= 0) state.shots[index] = shot;
    else state.shots.push(shot);
    state.shots.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    renderHeader();
  }

  async function addNewShot() {
    if (!state.series) return;
    const shot = newShot(state.shots.length);
    await persistShot(shot);
    renderShots();
    setView('outline');
    selectShot(shot.id);
  }

  function compileFor(shot, render = renderConfig()) {
    const series = state.series;
    return Engine.compileShot({
      canon: series.canon,
      shot,
      axes: series.axes || [],
      gallery: state.assets,
      lore: state.lore,
      size: render.size,
      quality: render.quality,
      n: 1,
      requirements: root.generationRequirements
    });
  }

  function assetFor(id) {
    return state.assets.find(asset => asset.id === id) || null;
  }

  // The nearest earlier frame that already produced an image, used as a composition anchor.
  function previousShotResult(shot) {
    const index = state.shots.findIndex(item => item.id === shot.id);
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const assetId = state.shots[cursor].result?.assetId;
      if (!assetId) continue;
      const asset = assetFor(assetId);
      if (asset?.data) return asset;
    }
    return null;
  }

  function renderShots({ updateInspector = true } = {}) {
    const list = $('#seriesShotList');
    if (!state.series) return;
    // Drop selections that no longer exist (frames deleted or series switched).
    const known = new Set(state.shots.map(shot => shot.id));
    for (const id of [...state.selectedShotIds]) if (!known.has(id)) state.selectedShotIds.delete(id);
    list.replaceChildren(...state.shots.map(shot => {
      const card = el('article', 'series-shot-card');
      card.dataset.shotId = shot.id;
      if (shot.id === state.selectedShotId) card.classList.add('is-active');
      if (state.selectedShotIds.has(shot.id)) card.classList.add('is-selected');

      // Selection drives batch generation; it is separate from "open this frame".
      const select = el('div', 'series-shot-select');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedShotIds.has(shot.id);
      checkbox.setAttribute('aria-label', '选择帧 ' + (shot.code || ''));
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedShotIds.add(shot.id);
        else state.selectedShotIds.delete(shot.id);
        card.classList.toggle('is-selected', checkbox.checked);
        renderSelectionBar();
      });
      select.append(checkbox);

      const code = el('span', 'series-shot-code', shot.code || '');
      const body = el('div', 'series-shot-body');
      const title = el('h3', 'series-shot-title', shot.title || shot.subject || '未命名帧');
      const summary = el('p', 'series-shot-summary', [shot.subject, shot.action, shot.scene].filter(Boolean).join(' · ') || '还没有描述');
      body.append(title, summary);
      const running = isGeneratingShot(shot);
      const saving = running && state.generationTask.saving;
      const state_ = el('span', 'series-shot-state', running ? (saving ? '保存中' : '生成中') : shot.pendingGeneration ? '待保存' : shot.result?.assetId ? '已出图' : shot.status === 'failed' ? '失败' : shot.status === 'deviation' ? '偏离' : '草稿');
      state_.dataset.state = running ? 'running' : shot.pendingGeneration ? 'pending-save' : shot.result?.assetId ? 'done' : shot.status;
      const thumb = el('div', 'series-shot-thumb');
      const result = shot.result?.assetId ? assetFor(shot.result.assetId) : null;
      if (result?.data) {
        const image = clickableImage(result.data, shot.title || '系列帧');
        // Clicking the thumbnail opens the lightbox; opening the frame itself must not fire.
        image.addEventListener('click', event => event.stopPropagation());
        thumb.append(image);
      } else {
        thumb.append(el('span', '', '—'));
      }
      card.append(select, code, thumb, body, state_);
      card.addEventListener('click', () => selectShot(shot.id));
      return card;
    }));
    // A brand-new series shows the three-step guide instead of a bare empty box.
    const fresh = state.shots.length === 0 && state.assets.length === 0;
    const guide = $('#seriesGuide');
    if (guide) guide.hidden = !fresh;
    $('#seriesShotsEmpty').hidden = state.shots.length > 0 || fresh;
    renderSelectionBar();
    updateGalleryButtons();
    if (updateInspector && state.selectedShotId) renderInspector();
  }

  function renderSelectionBar() {
    const bar = $('#seriesShotSelectBar');
    if (!bar) return;
    const total = state.shots.length;
    const count = [...state.selectedShotIds].filter(id => state.shots.some(shot => shot.id === id)).length;
    bar.hidden = total === 0;
    $('#seriesShotSelectionCount').textContent = count ? '已选 ' + count + ' 帧' : '未选择帧';
    $('#seriesBatchSelected').disabled = count === 0 || Boolean(state.batch);
    $('#seriesBatchSelected').textContent = count ? '批量生成所选（' + count + '）' : '批量生成所选';
    const all = $('#seriesSelectAllShots');
    if (all) {
      all.checked = count > 0 && count === total;
      all.indeterminate = count > 0 && count < total;
      all.disabled = total === 0;
    }
  }

  function selectShot(id) {
    state.selectedShotId = id;
    document.querySelectorAll('.series-shot-card').forEach(card => card.classList.toggle('is-active', card.dataset.shotId === id));
    renderInspector();
  }

  // ---------------------------------------------------------------- gallery submission

  // Series frames are copied into the independent artwork gallery. The gallery owns the
  // copy, so deleting a series later does not remove what was already collected.
  function galleryEntry(shot) {
    if (!state.series) return null;
    const assetId = shot?.result?.assetId;
    const asset = assetId ? assetFor(assetId) : null;
    if (!asset?.data) return null;
    let prompt = shot.result?.prompt || '';
    if (!prompt) { try { prompt = compileFor(shot).prompt || ''; } catch { prompt = ''; } }
    return {
      id: asset.id,
      src: asset.data,
      prompt,
      created: asset.created || Date.now(),
      seriesId: state.series.id,
      seriesTitle: state.series.title || '未命名系列',
      shotCode: shot.code || '',
      shotTitle: shot.title || shot.subject || '',
      shotOrder: Number.isFinite(shot.order) ? shot.order : 0
    };
  }

  function galleryReady() {
    return typeof root.ArtGallery?.submitMany === 'function';
  }

  function galleryHas(shot) {
    const id = shot?.result?.assetId;
    return Boolean(id && root.ArtGallery?.contains?.(id));
  }

  function galleryEntries() {
    return state.shots.map(galleryEntry).filter(Boolean);
  }

  // The toolbar button always says how many frames would actually be copied; frames
  // already in the gallery are not re-submitted.
  function updateGalleryButtons() {
    const button = $('#seriesAddAllGallery');
    if (!button) return;
    const entries = galleryEntries();
    const pending = entries.filter(entry => !root.ArtGallery?.contains?.(entry.id)).length;
    button.hidden = !galleryReady();
    button.disabled = !pending;
    button.textContent = !entries.length ? '全部加入画廊'
      : !pending ? '已全部加入画廊'
        : '全部加入画廊（' + pending + '）';
  }

  async function addShotToGallery(shot) {
    const entry = galleryEntry(shot);
    if (!entry) { status('这一帧还没有生成图片。', 'error'); return; }
    if (!galleryReady()) { status('作品画廊未就绪，刷新页面后重试。', 'error'); return; }
    if (root.ArtGallery.contains(entry.id)) { status('这一帧已经在作品画廊里了。'); return; }
    status('正在把 ' + (shot.code || '这一帧') + ' 加入作品画廊…');
    let report;
    try { report = await root.ArtGallery.submitMany([entry]); }
    catch (error) { status('加入画廊失败：' + describeError(error), 'error'); return; }
    if (report.added) status('已加入作品画廊，可在顶部「画廊」查看。', 'success');
    else if (report.skipped) status('这一帧已经在作品画廊里了。');
    else status('加入画廊失败：' + (report.reasons[0] || '未知错误'), 'error');
    renderShots();
    renderInspector();
  }

  async function addAllToGallery() {
    if (!galleryReady()) { status('作品画廊未就绪，刷新页面后重试。', 'error'); return; }
    const pending = galleryEntries().filter(entry => !root.ArtGallery.contains(entry.id));
    if (!pending.length) { status('没有新的图片需要加入画廊。'); return; }
    status('正在把 ' + pending.length + ' 张系列图片加入作品画廊…');
    let report;
    try { report = await root.ArtGallery.submitMany(pending); }
    catch (error) { status('加入画廊失败：' + describeError(error), 'error'); return; }
    const parts = [];
    if (report.added) parts.push('已加入 ' + report.added + ' 张');
    if (report.skipped) parts.push(report.skipped + ' 张已在画廊');
    if (report.failed) parts.push(report.failed + ' 张失败');
    status(parts.length ? parts.join('，') + '。可直接去「画廊」查看系列集。' : '没有可加入的图片。', report.failed ? 'error' : 'success');
    renderShots();
    renderInspector();
  }

  function closeInspector() {
    state.selectedShotId = null;
    $('#seriesInspector').hidden = true;
    document.querySelector('.series-layout')?.classList.remove('has-inspector');
    document.querySelectorAll('.series-shot-card').forEach(card => card.classList.remove('is-active'));
  }

  // ---------------------------------------------------------------- inspector

  function renderInspector() {
    const shot = state.shots.find(item => item.id === state.selectedShotId);
    if (!shot) { closeInspector(); return; }
    const series = state.series;
    $('#seriesInspector').hidden = false;
    document.querySelector('.series-layout')?.classList.add('has-inspector');
    $('#seriesInspectorLabel').textContent = shot.code + ' · ' + (shot.title || '未命名帧');
    const body = $('#seriesInspectorBody');
    body.replaceChildren();

    const fields = [
      ['title', '标题', '短标题'],
      ['beat', '所属幕', '第一幕'],
      ['subject', '主体', '画面主体，可用 {{hero}}'],
      ['action', '动作', '主体在做什么'],
      ['scene', '场景', '在哪里'],
      ['detail', '细节', '这一帧独有的视觉细节']
    ];
    for (const [key, label, placeholder] of fields) {
      const row = el('label', 'series-inspector-field');
      row.append(el('span', '', label));
      const input = key === 'detail' ? el('textarea') : el('input');
      if (key === 'detail') input.rows = 3;
      else input.type = 'text';
      input.value = shot[key] || '';
      input.dataset.shotField = key;
      input.placeholder = placeholder;
      input.addEventListener('input', () => { shot[key] = input.value; });
      input.addEventListener('change', async () => {
        await persistShot(shot);
        renderShots();
        updatePreview();
      });
      row.append(input);
      body.append(row);
    }

    // Axis values
    const inspectorAxes = (series.axes || []).filter(axis => axis.values?.length).slice();
    for (const [id, value] of Object.entries(shot.axisValues || {})) {
      if (value && !inspectorAxes.some(axis => axis.id === id)) inspectorAxes.push({ id, label: id, values: [] });
    }
    if (inspectorAxes.length) {
      const axisBox = el('div', 'series-inspector-axes');
      axisBox.append(el('span', 'section-label', '轴取值'));
      for (const axis of inspectorAxes) {
        const row = el('label', 'series-inspector-field');
        row.append(el('span', '', axis.label || axis.id));
        const select = el('select');
        select.dataset.axisId = axis.id;
        select.append(new Option('未指定', ''));
        for (const value of axis.values) select.append(new Option(value, value));
        if (shot.axisValues?.[axis.id] && !axis.values.includes(shot.axisValues[axis.id])) {
          select.append(new Option(shot.axisValues[axis.id] + '（原取值）', shot.axisValues[axis.id]));
        }
        select.value = shot.axisValues?.[axis.id] || '';
        select.addEventListener('change', async () => {
          shot.axisValues = { ...(shot.axisValues || {}), [axis.id]: select.value };
          await persistShot(shot);
          updatePreview();
        });
        row.append(select);
        axisBox.append(row);
      }
      body.append(axisBox);
    }

    // Reference slots
    const refBox = el('div', 'series-inspector-refs');
    refBox.append(el('span', 'section-label', '参考图 · 最多 ' + Engine.MAX_REFERENCES + ' 张'));
    const usable = state.assets.filter(asset => asset.role !== 'output');
    if (!usable.length) {
      refBox.append(el('p', 'field-hint', '图库还是空的。到「图库」上传角色或风格参考图。'));
    }
    const slots = el('div', 'series-ref-slots');
    for (let index = 0; index < Engine.MAX_REFERENCES; index++) {
      const entry = shot.references?.[index];
      const asset = entry ? assetFor(entry.assetId) : null;
      const slot = el('div', 'series-ref-slot');
      if (asset?.data) {
        const image = clickableImage(asset.data, asset.name || '参考图');
        // Selecting the dropdown is the slot's primary action, so the image opens separately.
        image.addEventListener('click', event => event.stopPropagation());
        slot.append(image);
      } else {
        slot.append(el('span', 'series-ref-empty', '空'));
      }
      const select = el('select');
      select.setAttribute('aria-label', '第 ' + (index + 1) + ' 张参考图');
      select.append(new Option('不使用', ''));
      for (const item of usable) select.append(new Option((Engine.SLOT_LABELS[item.role] || item.role) + ' · ' + (item.name || '未命名'), item.id));
      select.value = entry?.assetId || '';
      select.addEventListener('change', async () => {
        shot.references = (shot.references || []).slice();
        if (select.value) {
          const role = usable.find(item => item.id === select.value)?.role || 'style';
          shot.references[index] = { assetId: select.value, slot: role === 'output' ? 'previous' : role };
        } else {
          shot.references.splice(index, 1);
        }
        shot.references = shot.references.filter(Boolean).slice(0, Engine.MAX_REFERENCES);
        await persistShot(shot);
        renderInspector();
      });
      slot.append(select);
      slots.append(slot);
    }
    refBox.append(slots);

    // Generated frames are not in the picker above, but the previous frame is the most
    // useful composition anchor and deserves a one-click toggle.
    const previous = previousShotResult(shot);
    if (previous) {
      const toggle = el('label', 'series-ref-toggle');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = (shot.references || []).some(entry => entry.slot === 'previous' && entry.assetId === previous.id);
      checkbox.addEventListener('change', async () => {
        shot.references = (shot.references || []).filter(entry => entry.slot !== 'previous');
        if (checkbox.checked) shot.references.push({ assetId: previous.id, slot: 'previous' });
        await persistShot(shot);
        renderInspector();
      });
      toggle.append(checkbox, document.createTextNode(' 带上上一帧作为构图参考'));
      refBox.append(toggle);
    }
    body.append(refBox);

    // Lore entries are opt-in per frame: only the ones ticked here enter this prompt.
    if (state.lore.length) {
      const loreBox = el('div', 'series-inspector-lore');
      loreBox.append(el('span', 'section-label', '引用设定 · 最多 3 条'));
      for (const item of state.lore) {
        const choice = el('label', 'series-lore-choice');
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.checked = (shot.loreRefs || []).includes(item.id);
        checkbox.disabled = !checkbox.checked && (shot.loreRefs || []).length >= 3;
        checkbox.addEventListener('change', async () => {
          const refs = new Set(shot.loreRefs || []);
          if (checkbox.checked) {
            if (refs.size >= 3) { checkbox.checked = false; return; }
            refs.add(item.id);
          } else {
            refs.delete(item.id);
          }
          shot.loreRefs = [...refs];
          await persistShot(shot);
          updatePreview();
        });
        choice.append(checkbox, document.createTextNode(' ' + (item.title || '未命名条目')));
        loreBox.append(choice);
      }
      body.append(loreBox);
    }

    // Compile preview
    const preview = el('div', 'series-preview');
    preview.append(el('span', 'section-label', '将发送的提示词'));
    const promptBox = el('p', 'series-preview-text');
    const meta = el('p', 'series-preview-meta');
    const warnings = el('ul', 'series-preview-warnings');
    preview.append(promptBox, meta, warnings);
    body.append(preview);

    function updatePreview() {
      const compiled = compileFor(shot);
      promptBox.textContent = compiled.prompt || '（空）';
      meta.textContent = compiled.characters + ' / ' + Engine.PROMPT_LIMIT + ' 字符 · 参考图 ' + compiled.references.length + ' 张';
      meta.dataset.over = String(compiled.overLimit);
      warnings.replaceChildren(...compiled.warnings.map(line => el('li', '', line)));
      warnings.hidden = compiled.warnings.length === 0;
      generate.disabled = state.busy || Boolean(shot.pendingGeneration) || compiled.overLimit || compiled.blocked;
    }

    // Actions must be created before the first updatePreview call: updatePreview writes
    // into the generate button, and a later declaration would be in the temporal dead zone.
    const actions = el('div', 'series-inspector-actions');
    const generate = button('生成这一帧', 'button primary', () => generateShot(shot));
    generate.dataset.action = 'generate-shot';
    generate.textContent = isGeneratingShot(shot) ? (state.generationTask.saving ? '保存中…' : '生成中…') : '生成这一帧';
    generate.title = shot.pendingGeneration ? '请先保存或放弃待保存图片' : state.busy ? '请等待当前任务完成' : '';
    const remove = button('删除这一帧', 'button text-button', async () => {
      if (isGeneratingShot(shot)) return;
      const ok = await confirmAction({
        title: '删除这一帧',
        text: '删除「' + (shot.title || shot.code || '这一帧') + '」？已生成的图片也会一并移除。',
        confirmLabel: '删除'
      });
      if (!ok || isGeneratingShot(shot)) return;
      if (shot.result?.assetId) await store.deleteAsset(shot.result.assetId);
      await store.deleteShot(shot.id);
      state.volatileGenerations.delete(shot.id);
      state.shots = state.shots.filter(item => item.id !== shot.id);
      closeInspector();
      renderShots();
      renderHeader();
    });
    const optimize = button('用模型扩写', 'button secondary', () => expandShot(shot));
    optimize.dataset.action = 'expand-shot';
    optimize.disabled = [...state.modelTasks.values()].some(task => task.type === 'expand' && task.seriesId === shot.seriesId && task.targetId === shot.id);
    if (optimize.disabled) optimize.textContent = '扩写中…';
    remove.dataset.action = 'delete-shot';
    remove.disabled = isGeneratingShot(shot);
    remove.title = remove.disabled ? '这一帧正在生成，完成后可删除' : '';
    if (remove.disabled) remove.textContent = '生成中，暂不可删除';
    actions.append(optimize, generate, remove);
    body.append(actions);
    updatePreview();

    if (shot.pendingGeneration) {
      const pending = shot.pendingGeneration;
      const notice = el('div', 'series-hint');
      notice.dataset.testid = 'pending-generation';
      notice.append(el('p', '', '图片已生成，尚未保存到本地。' + (shot.result?.assetId ? '当前仍采用原有图片。' : '')
        + '重试保存不会重新调用生图模型；远程链接可能过期。'));
      if (pending.error) notice.append(el('p', '', pending.error));
      if (!pending.persisted) notice.append(el('p', '', '待保存信息尚未写入浏览器，请勿刷新或关闭页面。'));
      const retry = button('重试保存图片', 'button secondary', () => retryGenerationSave(shot));
      retry.dataset.action = 'retry-generation-save';
      retry.disabled = state.busy;
      const discard = button('放弃待保存图片', 'button text-button', () => discardPendingGeneration(shot));
      discard.dataset.action = 'discard-pending-generation';
      discard.disabled = isGeneratingShot(shot);
      notice.append(retry, discard);
      body.append(notice);
    }

    if (shot.result?.assetId) {
      const asset = assetFor(shot.result.assetId);
      if (asset?.data) {
        const result = el('figure', 'series-result');
        const image = clickableImage(asset.data, shot.title || shot.subject || '生成结果', 'series-result-image');
        const caption = el('figcaption', 'series-result-caption');
        const drift = typeof shot.result.drift === 'number' ? '偏离分 ' + shot.result.drift.toFixed(2) : '未评估';
        const inGallery = galleryHas(shot);
        const collect = button(inGallery ? '已在画廊' : '加入画廊', 'text-action series-gallery-add', () => addShotToGallery(shot));
        collect.disabled = inGallery || !galleryReady();
        caption.append(
          el('span', '', drift),
          button('查看大图 ↗', 'text-action', () => openPreview(asset.data, shot.title || '系列画面')),
          button('下载 ↗', 'text-action', () => downloadAsset(asset)),
          collect
        );
        if (/^https?:/i.test(asset.data) && !shot.pendingGeneration) {
          const local = button('保存到本地', 'text-action', () => retryGenerationSave(shot));
          local.dataset.action = 'localize-generation';
          local.disabled = state.busy;
          caption.append(local);
        }
        result.append(image, caption);
        body.append(result);
      }
    }
  }

  // The create page's preview dialog is reused so series images open in the same lightbox.
  // openPreview() in app.js is module-scoped, so this drives the same <dialog> directly.
  function openPreview(src, caption) {
    const dialog = $('#previewDialog');
    if (!dialog) return;
    $('#previewImage').src = src;
    $('#previewImage').alt = caption || '系列画面';
    $('#previewPrompt').textContent = caption || '';
    if (!dialog.open) dialog.showModal();
  }

  function clickableImage(src, caption, className) {
    const image = el('img', className);
    image.src = src;
    image.alt = caption || '系列画面';
    image.loading = 'lazy';
    image.tabIndex = 0;
    image.classList.add('is-zoomable');
    const open = () => openPreview(src, caption);
    image.addEventListener('click', open);
    image.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
    return image;
  }

  function downloadAsset(asset) {
    const link = document.createElement('a');
    link.href = asset.data;
    const extension = asset.mime === 'image/jpeg' ? 'jpg' : (asset.mime || 'image/png').split('/')[1] || 'png';
    link.download = (state.series?.title || 'series') + '-' + asset.id + '.' + extension;
    document.body.append(link);
    link.click();
    link.remove();
  }

  // ---------------------------------------------------------------- generation

  function referencesPayload(compiled) {
    return compiled.references.map(entry => {
      const asset = assetFor(entry.assetId);
      if (!asset?.data) return null;
      return {
        mime: asset.mime || 'image/png',
        b64_json: String(asset.data).split(',')[1] || '',
        purpose: entry.purpose,
        customPurpose: entry.customPurpose || '',
        preserve: entry.preserve || '',
        change: entry.change || ''
      };
    }).filter(Boolean);
  }

  async function generateShot(shot) {
    if (state.busy) return;
    if (shot.pendingGeneration) { status('这张图片待保存，请先重试保存或放弃待保存图片。'); return; }
    const series = state.series;
    if (!series || shot.seriesId !== series.id) return;
    const config = imageConfig();
    if (!config.apiKey || !config.model) {
      status('请先在「设置」中填写图片生成 API 的 Key 和模型。', 'error');
      return;
    }
    const render = renderConfig();
    const compiled = compileFor(shot, render);
    if (compiled.blocked) {
      status('提示词存在变量冲突：' + compiled.conflicts.join(' '), 'error');
      return;
    }
    if (compiled.overLimit) {
      status('这一帧的提示词超过上限，请精简后再生成。', 'error');
      return;
    }
    const references = referencesPayload(compiled);
    const total = references.reduce((sum, item) => sum + Math.ceil(item.b64_json.length * 0.75), 0);
    if (total > FRAME_TOTAL_LIMIT) {
      status('参考图合计 ' + bytes(total) + '，超过单帧 ' + bytes(FRAME_TOTAL_LIMIT) + ' 的上限，请减少或压缩图片。', 'error');
      return;
    }

    // Everything used by this request is captured before the first await. Credentials
    // stay in the request body only; the result stores a separate, safe snapshot.
    const task = {
      seriesId: series.id,
      shotId: shot.id,
      code: shot.code,
      canonVersion: series.canon.version || 1,
      startedAt: Date.now(),
      prompt: compiled.prompt,
      parameters: structuredClone({ model: config.model, ...render, n: 1, capabilities: config.capabilities }),
      references: compiled.references.map(entry => {
        const asset = assetFor(entry.assetId);
        return { ...entry, mime: asset?.mime || 'image/png', sha256: asset?.sha256 || '' };
      }),
      previousAssetId: shot.result?.assetId,
      baseline: state.assets.find(item => item.role === 'output' && item.id !== shot.result?.assetId)
    };
    const request = { ...config, ...render, prompt: compiled.requestPrompt, n: 1, references };
    state.generationTask = task;
    state.busy = true;
    shot.status = 'running';
    renderSeriesList();
    renderShots();
    renderInspector();
    status('正在生成 ' + shot.code + '，最多等待 5 分钟。');

    try {
      const data = await post('/api/generate', request);
      const image = data.images?.[0];
      if (!image) throw new Error('接口没有返回图片');
      task.receivedImage = true;
      const asset = {
        id: uid('ast'),
        seriesId: task.seriesId,
        shotId: task.shotId,
        role: 'output',
        name: task.code + ' 出图',
        mime: image.mime || 'image/png',
        data: image.b64_json ? 'data:' + (image.mime || 'image/png') + ';base64,' + image.b64_json : image.url,
        createdAt: Date.now()
      };
      const result = {
        assetId: asset.id,
        drift: 0,
        prompt: task.prompt,
        canonVersion: task.canonVersion,
        parameters: task.parameters,
        references: task.references,
        startedAt: task.startedAt
      };
      if (!image.b64_json) {
        if (!/^https?:\/\//i.test(image.url || '')) throw new Error('接口没有返回有效的图片链接');
        task.pending = { id: uid('pending'), asset, result, persisted: false };
        await saveRemoteGeneration(task, shot);
        return;
      }
      result.drift = await driftScore(asset, task.baseline);
      const saved = await store.saveGeneration({ seriesId: task.seriesId, shotId: task.shotId, asset, result });
      if (!saved) return;
      publishGeneration(task, shot, saved, asset);
      if (isVisibleSeries(task.seriesId)) {
        status(task.code + ' 生成完成。' + (result.drift > 0.35 ? '这张与系列基线差异较大，可考虑加强锚点重生成。' : ''), 'success');
      }
    } catch (error) {
      if (task.pending) {
        await markPendingGeneration(task, shot, error);
        return;
      }
      const failed = await store.updateShot(task.shotId, task.seriesId,
        current => ({ ...current, status: 'failed', updatedAt: Date.now() })).catch(() => null);
      // Even when storage remains unavailable, release the local running state;
      // never expose a result that was rolled back or discard the adopted image.
      syncGeneration(task, shot, { status: 'failed', ...(failed ? { updatedAt: failed.updatedAt } : {}) });
      if (isVisibleSeries(task.seriesId)) {
        status((task.receivedImage ? '图片已返回，但保存失败：' : '生成失败：') + describeError(error)
          + (task.receivedImage && shot.result?.assetId ? ' 原有图片已保留。' : ''), 'error');
      }
    } finally {
      finishGeneration(task);
    }
  }

  function publishGeneration(task, shot, saved, asset) {
    syncGeneration(task, shot, { result: saved.shot.result, status: saved.shot.status,
      canonVersion: saved.shot.canonVersion, updatedAt: saved.shot.updatedAt,
      ...(task.pending ? { pendingGeneration: null } : {}) });
    if (isCurrentSeries(task.seriesId)) {
      state.assets = state.assets.filter(item => item.id !== saved.removedAssetId && item.id !== asset.id);
      state.assets.push(asset);
    }
  }

  function finishGeneration(task) {
    state.busy = false;
    state.generationTask = null;
    renderSeriesList();
    if (isVisibleSeries(task.seriesId)) {
      renderShots();
      renderHeader();
      if (state.view === 'matrix') renderMatrix();
    } else if (state.series && !$('#seriesPage').hidden) {
      // Release controls without replacing another series' unsaved inspector inputs.
      const current = state.shots.find(item => item.id === state.selectedShotId);
      const generate = $('[data-action=generate-shot]');
      if (generate) {
        const compiled = current && compileFor(current);
        generate.disabled = !current || Boolean(current.pendingGeneration) || compiled.overLimit || compiled.blocked;
        generate.title = current?.pendingGeneration ? '请先保存或放弃待保存图片' : '';
      }
      for (const action of ['retry-generation-save', 'localize-generation']) {
        const control = $('[data-action=' + action + ']');
        if (control) control.disabled = false;
      }
    }
  }

  async function saveRemoteGeneration(task, shot) {
    const pending = task.pending;
    // Persist the safe response snapshot before downloading. A refresh can then
    // offer an explicit save retry, without issuing another billable request.
    const staged = await store.updateShot(task.shotId, task.seriesId, current => {
      if (pending.persisted && current.pendingGeneration?.id !== pending.id) return null;
      if (current.pendingGeneration && current.pendingGeneration.id !== pending.id) return null;
      return { ...current, pendingGeneration: { ...pending, persisted: true, error: '' }, status: 'pending-save', updatedAt: Date.now() };
    });
    if (!staged) return;
    task.pending = staged.pendingGeneration;
    task.saving = true;
    syncGeneration(task, shot, { pendingGeneration: task.pending, status: 'pending-save' });
    if (isVisibleSeries(task.seriesId)) {
      status('图片已生成，正在下载并保存到本地。');
      renderShots();
    }
    const blob = await blobFromSource(task.pending.asset.data);
    if (!blob.size || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) {
      throw new Error('下载内容不是支持的图片格式');
    }
    // Decode before adopting so an HTML/error body labelled as an image cannot
    // replace the existing result with an unusable local resource.
    const asset = { ...task.pending.asset, mime: blob.type, data: await blobToDataUrl(blob) };
    const decoded = new Image();
    decoded.src = asset.data;
    try { await decoded.decode(); } catch { throw new Error('下载的图片无法读取，请重试保存'); }
    const result = { ...task.pending.result, drift: await driftScore(asset, task.baseline) };
    const saved = await store.saveGeneration({ seriesId: task.seriesId, shotId: task.shotId,
      asset, result, pendingId: task.pending.id });
    if (!saved) return;
    publishGeneration(task, shot, saved, asset);
    if (isVisibleSeries(task.seriesId)) status(task.code + ' 图片已保存到本地。', 'success');
  }

  async function markPendingGeneration(task, shot, error) {
    const pending = { ...task.pending, error: describeError(error) };
    const saved = await store.updateShot(task.shotId, task.seriesId, current => {
      if (pending.persisted && current.pendingGeneration?.id !== pending.id) return null;
      if (current.pendingGeneration && current.pendingGeneration.id !== pending.id) return null;
      return { ...current, pendingGeneration: { ...pending, persisted: true }, status: 'pending-save', updatedAt: Date.now() };
    }).catch(() => false);
    // null means the owner/target (or this pending response) disappeared.
    if (saved === null) return;
    syncGeneration(task, shot, { pendingGeneration: saved ? saved.pendingGeneration : pending, status: 'pending-save' });
    if (isVisibleSeries(task.seriesId)) status('图片待保存：' + pending.error
      + (shot.result?.assetId ? ' 原有图片已保留。' : '') + ' 可重试保存，不会重新调用生图模型。', 'error');
  }

  async function retryGenerationSave(shot) {
    if (state.busy || !isCurrentSeries(shot.seriesId)) return;
    const existing = shot.result?.assetId && assetFor(shot.result.assetId);
    const pending = shot.pendingGeneration || (existing && /^https?:/i.test(existing.data) ? (() => {
      const asset = { ...existing, id: uid('ast'), shotId: shot.id };
      return { id: uid('pending'), asset, result: { ...shot.result, assetId: asset.id }, persisted: false };
    })() : null);
    if (!pending) return;
    const task = { seriesId: shot.seriesId, shotId: shot.id, code: shot.code, saving: true, pending: structuredClone(pending),
      baseline: state.assets.find(item => item.role === 'output' && item.id !== shot.result?.assetId) };
    state.generationTask = task;
    state.busy = true;
    renderSeriesList();
    renderShots();
    try { await saveRemoteGeneration(task, shot); }
    catch (error) { await markPendingGeneration(task, shot, error); }
    finally { finishGeneration(task); }
  }

  async function discardPendingGeneration(shot) {
    if (isGeneratingShot(shot) || !shot.pendingGeneration) return;
    const pendingId = shot.pendingGeneration.id;
    const ok = await confirmAction({ title: '放弃待保存图片', text: '放弃后无法再保存这次返回的图片。原有图片会保留；重新生成将再次调用模型。', confirmLabel: '放弃' });
    if (!ok || isGeneratingShot(shot) || shot.pendingGeneration?.id !== pendingId) return;
    try {
      const saved = await store.updateShot(shot.id, shot.seriesId, current => {
        if (current.pendingGeneration && current.pendingGeneration.id !== pendingId) return null;
        return { ...current, pendingGeneration: null, status: current.result?.assetId ? 'done' : 'draft', updatedAt: Date.now() };
      });
      if (!saved) return;
      syncGeneration({ seriesId: shot.seriesId, shotId: shot.id }, shot,
        { pendingGeneration: null, status: saved.status, updatedAt: saved.updatedAt });
      if (isVisibleSeries(shot.seriesId)) { renderShots(); status('已放弃待保存图片。'); }
    } catch (error) { if (isVisibleSeries(shot.seriesId)) status('未能放弃待保存图片：' + describeError(error), 'error'); }
  }

  function syncGeneration(task, originalShot, patch) {
    // Publish only committed result fields. Keep the live object (and any edits
    // made while saving) rather than replacing it with a database snapshot.
    const current = isCurrentSeries(task.seriesId) && state.shots.find(item => item.id === task.shotId);
    if ('pendingGeneration' in patch) {
      if (patch.pendingGeneration && !patch.pendingGeneration.persisted) state.volatileGenerations.set(task.shotId, patch.pendingGeneration);
      else state.volatileGenerations.delete(task.shotId);
    }
    if (current) Object.assign(current, patch);
    Object.assign(originalShot, patch);
  }

  // ---------------------------------------------------------------- drift

  const drift = root.createSeriesDrift ? root.createSeriesDrift() : null;

  async function driftScore(asset, baseline) {
    if (!drift || !asset?.data) return 0;
    if (!baseline) return 0;
    try {
      return await drift.compare(asset.data, baseline.data);
    } catch { return 0; }
  }

  // ---------------------------------------------------------------- model actions

  function openExtractDialog() {
    const dialog = $('#seriesExtractDialog');
    if (!dialog.open) dialog.showModal();
  }

  function closeExtractDialog() {
    const dialog = $('#seriesExtractDialog');
    if (dialog.open) dialog.close();
  }

  async function runExtract({ theme, seriesId, onDone }) {
    if (state.extracting) { status('已有提炼正在进行中。'); return; }
    if (!requireOptimizer()) return;
    const config = optimizerConfig();
    const prepared = Llm.splitChunks(theme);
    if (!prepared.total) { status('主题原文为空，无法提炼。', 'error'); return; }
    const task = beginModelTask('extract', seriesId);
    if (!task) return;
    const gallerySignature = isCurrentSeries(seriesId) ? state.assets.map(asset => asset.id).join(',') : '';
    state.extractTask = task;

    state.extracting = true;
    state.extractProgress = { done: 0, total: prepared.total, reused: 0 };
    openExtractDialog();
    $('#seriesExtractDialog').dataset.taskId = task.id;
    $('#seriesExtractEstimate').textContent = '约 ' + prepared.total + ' 次分块调用 + 1 次汇总。暂停后再次提炼会跳过已完成的块，不重复计费。';
    $('#seriesExtractPause').textContent = '暂停';
    $('#seriesExtractPause').hidden = false;
    $('#seriesExtractBar').style.width = '0%';
    $('#seriesExtractDetail').textContent = '准备中…';

    const llm = Llm.createSeriesLlm({
      request: post,
      concurrency: 2,
      store: {
        getExtraction: async key => {
          const cached = await store.getExtraction(seriesId + ':' + key);
          if (cached) return cached;
          const legacy = await store.getExtraction(key);
          return legacy?.seriesId === seriesId ? legacy : null;
        },
        putExtraction: record => store.putExtraction({ ...record, id: seriesId + ':' + record.id })
      },
      onProgress: event => {
        if (task.cancelled || state.extractTask !== task) return;
        if (event.phase === 'cache') {
          $('#seriesExtractBar').style.width = '100%';
          $('#seriesExtractDetail').textContent = '命中缓存，没有产生新的模型调用。';
          return;
        }
        if (event.phase === 'reduce') {
          $('#seriesExtractBar').style.width = '95%';
          $('#seriesExtractDetail').textContent = '正在汇总为风格圣经…' + (event.degraded ? '（' + event.degraded + ' 块降级）' : '');
          return;
        }
        state.extractProgress = { done: event.done, total: event.total, reused: event.reused || 0 };
        const percent = Math.round((event.done / event.total) * 90);
        $('#seriesExtractBar').style.width = percent + '%';
        $('#seriesExtractDetail').textContent = '已提炼 ' + event.done + ' / ' + event.total + ' 块' + (event.reused ? '（其中 ' + event.reused + ' 块来自缓存）' : '');
      }
    });
    state.llm = llm;
    task.llm = llm;

    try {
      const result = await llm.extract({
        text: theme,
        config,
        seriesId,
        model: config.model,
        promptVersion: Prompts ? Prompts.SERIES_PROMPT_VERSION : 1,
        gallerySignature
      });
      if (task.cancelled) return;
      $('#seriesExtractBar').style.width = '100%';
      $('#seriesExtractDetail').textContent = result.cached ? '已从缓存恢复提炼结果。' : '提炼完成。';
      const applied = await onDone(result);
      if (applied === false) { closeExtractDialog(); return; }
      const reused = result.reused ? '，其中 ' + result.reused + ' 块沿用缓存' : '';
      modelStatus(task, result.cached ? '已使用缓存的提炼结果。' : '提炼完成，共 ' + result.coverage.used + ' / ' + result.coverage.total + ' 块有效' + reused + '。', 'success');
      setTimeout(() => { if ($('#seriesExtractDialog').dataset.taskId === task.id) closeExtractDialog(); }, 600);
    } catch (error) {
      if (error?.name === 'AbortError') {
        const progress = state.extractProgress;
        modelStatus(task, '已暂停：' + progress.done + ' / ' + progress.total + ' 块已完成并保存。再次点击「从主题提炼」会从断点继续。');
      } else {
        modelStatus(task, '提炼失败：' + describeError(error), 'error');
      }
      closeExtractDialog();
    } finally {
      state.extracting = false;
      state.llm = null;
      if (state.extractTask === task) state.extractTask = null;
      finishModelTask(task);
      $('#seriesExtractPause').hidden = true;
    }
  }

  async function extractIntoCanon() {
    const series = state.series;
    if (!series) return;
    const theme = series.theme?.statement || '';
    if (!theme.trim()) {
      status('先在「圣经」里填写主题原文，或新建系列时粘贴长文。', 'error');
      return;
    }
    await runExtract({
      theme,
      seriesId: series.id,
      onDone: async result => {
        if (result.canonDraft) return applyCanonDraft(result.canonDraft, result, series.id);
        if (isVisibleSeries(series.id)) status('模型没有返回可用的风格草案，已保留现有圣经。可手动填写。', 'error');
        return false;
      }
    });
  }

  async function applyCanonDraft(draft, meta, seriesId) {
    const saved = await store.updateSeries(seriesId, stored => {
      const series = structuredClone(isCurrentSeries(seriesId) ? state.series : stored);
      const canon = series.canon;
      for (const key of ['medium', 'lighting', 'lens', 'composition', 'grade', 'material', 'characterLook', 'atmosphere']) {
        if (draft[key] && typeof draft[key] === 'object') Object.assign(canon[key] ||= {}, draft[key]);
        else if (draft[key]) canon[key] = draft[key];
      }
      if (draft.palette?.length) canon.palette = draft.palette.map(item => ({ name: item.name, hex: item.hex || '#808080', weight: item.weight }));
      if (draft.terms && Object.keys(draft.terms).length) canon.terms = { ...canon.terms, ...draft.terms };
      if (draft.negative?.length) canon.negative = draft.negative;
      if (draft.themes?.length) series.theme.keywords = draft.themes;
      if (draft.mood?.length) series.theme.mood = draft.mood;
      if (draft.era) series.theme.era = draft.era;
      if (draft.taboos?.length) series.theme.taboos = draft.taboos;
      series.theme.source = meta ? { used: meta.coverage.used, total: meta.coverage.total, degraded: meta.degraded.length } : null;
      // The draft is written to disk immediately below, so this is not a pending edit.
      series.canonDirty = false;
      canon.version = (canon.version || 1) + 1;
      canon.anchorSentence = Engine.renderAnchor(canon);
      series.updatedAt = Date.now();
      return series;
    });
    if (!saved) return false;
    syncSeriesRecord(saved);
    if (isVisibleSeries(seriesId)) {
      renderCanon();
      renderHeader();
      status('已生成圣经 v' + saved.canon.version + '。请逐项检查，模型填充的内容都可以修改。', 'success');
    }
    return true;
  }

  // ---------------------------------------------------------------- split frames

  // The split dialog lets the user pick which lore entries to read and how many frames to
  // cut them into. Only text is produced; nothing is sent to the image model.
  // The remembered selection is scoped to one series: lore ids are unique per series, so a
  // selection carried across a series switch would silently tick nothing.
  let splitSelection = { seriesId: null, ids: new Set() };
  let splitContext = null;

  function cancelSplitTask() {
    const task = state.splitTask;
    if (!task || task.saved || task.cancelled || task.context !== splitContext) return;
    task.cancelled = true;
    task.llm?.cancel();
    modelStatus(task, '已取消本次拆帧，未完成结果不会加入大纲；已发送的请求可能计费。');
  }

  function closeSplitDialog() {
    // Cancellation must take effect before a queued model response or close event.
    cancelSplitTask();
    $('#seriesSplitDialog').close();
  }

  function openSplitDialog() {
    if (!requireOptimizer()) return;
    if (!state.series) return;
    const lore = state.lore || [];
    const container = $('#seriesSplitLore');
    const seriesId = state.series.id;
    splitContext = { series: structuredClone(state.series), lore: structuredClone(lore), assets: structuredClone(state.assets) };
    if (splitSelection.seriesId !== seriesId) splitSelection = { seriesId, ids: new Set(lore.map(item => item.id)) };
    const chosen = splitSelection.ids;
    container.replaceChildren(...lore.map((item, index) => {
      const choice = el('label', 'series-split-choice');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = chosen.has(item.id);
      checkbox.dataset.loreId = item.id;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) chosen.add(item.id);
        else chosen.delete(item.id);
        updateSplitSummary();
      });
      const text = el('span', 'series-split-choice-body');
      text.append(
        el('strong', '', item.title || '条目 ' + (index + 1)),
        el('small', '', (item.text || '').length + ' 字符 · ' + String(item.text || '').slice(0, 46) + '…')
      );
      choice.append(checkbox, text);
      return choice;
    }));
    $('#seriesSplitEmpty').hidden = lore.length > 0;
    $('#seriesSplitCount').value = String(Math.max(1, Math.min(24, lore.length ? 6 : 1)));
    updateSplitSummary();
    const dialog = $('#seriesSplitDialog');
    if (!dialog.open) dialog.showModal();
  }

  function selectedLoreIds() {
    return [...document.querySelectorAll('#seriesSplitLore input:checked')].map(input => input.dataset.loreId);
  }

  function updateSplitSummary() {
    const ids = selectedLoreIds();
    const chars = (splitContext?.lore || []).filter(item => ids.includes(item.id)).reduce((sum, item) => sum + String(item.text || '').length, 0);
    // Plain text input: keep digits only and clamp to the supported range.
    const field = $('#seriesSplitCount');
    const digits = field.value.replace(/\D/g, '').slice(0, 2);
    if (digits !== field.value) field.value = digits;
    const count = Math.max(1, Math.min(24, Number(digits) || 1));
    $('#seriesSplitSelectedCount').textContent = '已选 ' + ids.length + ' 条';
    const summary = $('#seriesSplitSummary');
    summary.textContent = ids.length
      ? '将读取 ' + ids.length + ' 条档案（共 ' + chars + ' 字符），拆成 ' + count + ' 帧。'
      : '至少要选一条档案，才能开始拆分。';
    $('#seriesSplitStart').disabled = !ids.length || Boolean(state.splitTask);
    // Highlight the preset that matches the current count, if any.
    document.querySelectorAll('[data-split-count]').forEach(preset => {
      preset.setAttribute('aria-pressed', String(Number(preset.dataset.splitCount) === count));
    });
  }

  async function runSplit() {
    const context = splitContext;
    const series = context?.series;
    if (!series || state.splitTask) return;
    const ids = selectedLoreIds();
    if (!ids.length) return;
    const count = Math.max(1, Math.min(24, Number(String($('#seriesSplitCount').value).replace(/\D/g, '')) || 6));
    const lore = context.lore.filter(item => ids.includes(item.id));
    const config = optimizerConfig();
    const canonText = Engine.renderAnchor(series.canon);
    const task = beginModelTask('split', series.id);
    if (!task) return;
    state.splitTask = task;
    task.context = context;

    // Only the selected entries are read, and each is tagged with how many frames it should
    // contribute so a long entry does not get one frame while a short one gets five.
    const totalChars = lore.reduce((sum, item) => sum + String(item.text || '').length, 0) || 1;
    const block = lore.map((item, index) => {
      const share = Math.max(1, Math.round((String(item.text || '').length / totalChars) * count));
      return '【' + (item.title || '条目 ' + (index + 1)) + '｜建议 ' + share + ' 帧】\n' + String(item.text || '').slice(0, 4000);
    }).join('\n\n');
    const input = [
      '系列标题：' + (series.title || '未命名'),
      '风格圣经：' + (canonText || '未填写'),
      '',
      '请把下面的档案原文拆成 ' + count + ' 帧。',
      block
    ].join('\n');

    $('#seriesSplitStart').disabled = true;
    $('#seriesSplitSummary').textContent = '正在拆帧。关闭对话框会取消本次拆帧，未完成结果不会加入大纲。已发送的模型请求可能计费。';
    modelStatus(task, '正在把档案拆成 ' + count + ' 帧…');
    try {
      const llm = Llm.createSeriesLlm({ request: post, concurrency: 1 });
      task.llm = llm;
      const result = await llm.outline({
        input,
        config,
        count,
        axes: series.axes || [],
        hasLore: true,
        loreTitles: lore.map(item => item.title || '')
      });
      if (task.cancelled) return;
      if (!result.ok) throw new Error(result.errors[0] || '模型没有返回可用的帧清单');
      const byTitle = new Map(lore.map(item => [String(item.title || '').trim(), item.id]).filter(([title]) => title));
      const created = result.data.shots.map((item, index) => ({
        ...newShot(index, series, context.assets),
        code: item.code,
        title: item.title,
        beat: item.beat,
        subject: item.subject,
        action: item.action,
        scene: item.scene,
        detail: item.detail,
        loreRefs: byTitle.has(String(item.loreTitle || '').trim()) ? [byTitle.get(String(item.loreTitle || '').trim())] : [],
        axisValues: item.axisValues,
        origin: 'split'
      }));
      const saved = await store.appendShots(series.id, created, result.data.axes || [], () => !task.cancelled);
      if (!saved.length) {
        task.saved = true;
        if (state.splitTask === task && splitContext === context) $('#seriesSplitDialog').close();
        modelStatus(task, '拆帧目标已删除或任务已取消，结果已忽略。');
        return;
      }
      task.saved = true;
      if (state.splitTask === task && splitContext === context) $('#seriesSplitDialog').close();
      if (!isCurrentSeries(series.id)) return;
      const fresh = await store.getSeries(series.id);
      if (!isCurrentSeries(series.id) || !fresh) return;
      if (!state.series.axes?.length && fresh.axes?.length) state.series.axes = fresh.axes;
      for (const shot of saved) if (!state.shots.some(item => item.id === shot.id)) state.shots.push(shot);
      state.shots.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (!isVisibleSeries(series.id)) return;
      renderShots();
      setView('outline');
      renderHeader();
      const linked = created.filter(shot => shot.loreRefs.length).length;
      status('已从 ' + lore.length + ' 条档案拆出 ' + created.length + ' 帧' + (linked ? '，其中 ' + linked + ' 帧已关联原文' : '') + '。', 'success');
      // Splitting is usually followed by generating the whole batch, so offer it right away.
      if (created.length) {
        const proceed = await confirmAction({
          title: '批量生成这些帧',
          text: '刚拆出 ' + created.length + ' 帧。要现在按当前圣经与图库依次生成图片吗？每张都会实际计费。',
          confirmLabel: '开始生成',
          danger: false
        });
        if (proceed && isVisibleSeries(series.id)) await startBatch({ shots: saved, ask: false });
      }
    } catch (error) {
      if (!task.cancelled) modelStatus(task, '拆分失败：' + describeError(error), 'error');
    } finally {
      finishModelTask(task);
      if (state.splitTask === task) {
        state.splitTask = null;
        updateSplitSummary();
      }
    }
  }

  async function expandShot(shot) {
    if (!requireOptimizer()) return;
    const brief = [shot.subject, shot.action, shot.scene, shot.detail].filter(Boolean).join('，');
    if (!brief.trim()) {
      status('先写一句话描述这一帧，再让模型扩写。', 'error');
      return;
    }
    const config = optimizerConfig();
    const seriesId = shot.seriesId;
    if (!isCurrentSeries(seriesId)) return;
    const input = '系列风格：' + (Engine.renderAnchor(state.series.canon) || '未填写') + '\n这一帧：' + brief;
    const task = beginModelTask('expand', seriesId, shot.id);
    if (!task) return;
    modelStatus(task, '正在扩写 ' + shot.code + '。关闭详情后任务仍会继续。');
    renderInspector();
    try {
      const llm = Llm.createSeriesLlm({ request: post, concurrency: 1 });
      const result = await llm.shot({ input, config, axisValues: shot.axisValues || {} });
      if (!result.ok) throw new Error(result.errors[0] || '模型没有返回可用内容');
      const saved = await store.updateShot(shot.id, seriesId, stored => {
        const current = isCurrentSeries(seriesId) && state.shots.find(item => item.id === shot.id);
        const updated = structuredClone(current || stored);
        for (const key of ['subject', 'action', 'scene', 'detail']) if (result.data[key]) updated[key] = result.data[key];
        updated.updatedAt = Date.now();
        return updated;
      });
      if (!saved) { modelStatus(task, '扩写目标已删除，结果已忽略。'); return; }
      if (isCurrentSeries(seriesId)) {
        const index = state.shots.findIndex(item => item.id === shot.id);
        if (index >= 0) state.shots[index] = saved;
      }
      if (isVisibleSeries(seriesId)) renderShots({ updateInspector: false });
      modelStatus(task, '已扩写 ' + shot.code + '，可继续修改。', 'success');
    } catch (error) {
      modelStatus(task, '扩写失败：' + describeError(error), 'error');
    } finally {
      finishModelTask(task);
      if (isVisibleSeries(seriesId) && state.selectedShotId === shot.id) renderInspector();
    }
  }

  // ---------------------------------------------------------------- gallery

  function renderGallery() {
    const grid = $('#seriesGalleryGrid');
    const usable = state.assets.filter(asset => asset.role !== 'output');
    grid.replaceChildren(...usable.map(asset => {
      const card = el('article', 'series-gallery-card');
      const image = clickableImage(asset.data, asset.name || '参考图');
      const body = el('div', 'series-gallery-body');
      const role = el('select');
      role.setAttribute('aria-label', '参考图角色');
      for (const [value, label] of [['character', '角色'], ['style', '风格'], ['scene', '场景'], ['prop', '道具'], ['other', '其他']]) {
        role.append(new Option(label, value));
      }
      role.value = asset.role === 'output' ? 'style' : asset.role;
      role.addEventListener('change', async () => {
        asset.role = role.value;
        await store.putAsset(asset);
        renderGallery();
        renderHeader();
      });
      const name = el('input');
      name.type = 'text';
      name.value = asset.name || '';
      name.placeholder = '名称';
      name.setAttribute('aria-label', '参考图名称');
      name.addEventListener('change', async () => { asset.name = name.value; await store.putAsset(asset); });
      const note = el('textarea');
      note.rows = 2;
      note.value = asset.note || asset.analysis?.appearance || '';
      note.placeholder = '说明：这张图要保留什么';
      note.setAttribute('aria-label', '参考图说明');
      note.addEventListener('change', async () => { asset.note = note.value; await store.putAsset(asset); });
      const meta = el('p', 'series-gallery-meta');
      const analysisState = asset.analysis?.status === 'done' ? '已分析' : asset.analysis?.status === 'failed' ? '分析失败' : '未分析';
      meta.textContent = (asset.width || '?') + '×' + (asset.height || '?') + ' · ' + bytes(asset.bytes) + (asset.original && asset.original.bytes > asset.bytes ? '（原 ' + bytes(asset.original.bytes) + '）' : '') + ' · ' + analysisState;
      const actions = el('div', 'series-gallery-actions-row');
      const analyze = button('分析', 'text-action', () => analyzeAsset(asset));
      analyze.dataset.action = 'analyze-asset';
      const analyzing = [...state.modelTasks.values()].some(task => task.type === 'describe' && task.targetId === asset.id);
      analyze.disabled = !hasOptimizer() || analyzing;
      if (analyzing) analyze.textContent = '分析中…';
      card.dataset.assetId = asset.id;
      const useDefault = button('设为默认', 'text-action', async () => {
        const slot = asset.role === 'output' ? 'style' : asset.role;
        if (isCurrentSeries(asset.seriesId)) {
          state.series.gallery ||= { defaults: {} };
          state.series.gallery.defaults ||= {};
          state.series.gallery.defaults[slot] = asset.id;
        }
        const saved = await store.updateSeries(asset.seriesId, stored => {
          const series = structuredClone(isCurrentSeries(asset.seriesId) ? state.series : stored);
          series.gallery ||= { defaults: {} };
          series.gallery.defaults ||= {};
          series.gallery.defaults[slot] = asset.id;
          return series;
        });
        syncSeriesRecord(saved);
        if (isVisibleSeries(asset.seriesId)) status('已设为默认' + (Engine.SLOT_LABELS[asset.role] || '') + '。新帧会自动带上这张图。', 'success');
      });
      const remove = button('移除', 'text-action', async () => {
        const ok = await confirmAction({
          title: '移出图库',
          text: '从图库移除「' + (asset.name || '这张参考图') + '」？已生成的帧不受影响。',
          confirmLabel: '移除'
        });
        if (!ok) return;
        await store.deleteAsset(asset.id);
        if (!isCurrentSeries(asset.seriesId)) return;
        state.assets = state.assets.filter(item => item.id !== asset.id);
        state.shots.forEach(shot => {
          if ((shot.references || []).some(entry => entry.assetId === asset.id)) {
            shot.references = shot.references.filter(entry => entry.assetId !== asset.id);
            store.putShot(shot).catch(() => {});
          }
        });
        renderGallery();
        renderHeader();
      });
      actions.append(analyze, useDefault, remove);
      body.append(role, name, note, meta, actions);
      card.append(image, body);
      return card;
    }));
    $('#seriesGalleryEmpty').hidden = usable.length > 0;
    const pending = usable.filter(asset => asset.analysis?.status !== 'done').length;
    $('#seriesGalleryAnalyze').disabled = !pending || state.analyzing || !hasOptimizer();
    $('#seriesGalleryAnalyze').textContent = pending ? '分析未处理的图（' + pending + '）' : '全部已分析';
  }

  async function addGalleryFiles(files) {
    if (!state.series) return;
    const seriesId = state.series.id;
    const incoming = [...files].filter(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
    if (!incoming.length) { status('只支持 PNG、JPEG、WebP 图片。', 'error'); return; }
    status('正在压缩并保存 ' + incoming.length + ' 张图片…');
    const task = { seriesId, total: incoming.length };
    const taskId = uid('upload');
    state.uploads.set(taskId, task);
    let added = 0;
    let skipped = 0;
    const errors = [];
    for (const file of incoming) {
      try {
        const compressed = await compressImage(file);
        const asset = {
          id: uid('ast'),
          seriesId,
          role: 'style',
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 40),
          note: '',
          mime: compressed.mime,
          data: compressed.data,
          width: compressed.width,
          height: compressed.height,
          bytes: compressed.bytes,
          original: compressed.original,
          sha256: compressed.sha256,
          analysis: { status: 'pending' },
          createdAt: Date.now()
        };
        const saved = await store.addAssetToSeries(asset);
        if (!saved.added) {
          if (saved.reason === 'missing') break;
          skipped++;
          continue;
        }
        if (isCurrentSeries(seriesId) && !state.assets.some(item => item.id === asset.id)) state.assets.push(asset);
        added++;
      } catch (error) {
        errors.push('「' + file.name + '」处理失败：' + (error.message || '无法读取图片'));
      }
    }
    state.uploads.delete(taskId);
    if (isVisibleSeries(seriesId)) {
      renderGallery();
      renderHeader();
      const message = ['已添加 ' + added + ' 张参考图。', skipped ? skipped + ' 张重复图片已跳过。' : '', ...errors].filter(Boolean).join(' ');
      status(message, errors.length ? 'error' : 'success');
      if (added && hasOptimizer()) analyzePending();
    }
  }

  async function analyzeAsset(asset, context = null) {
    if (!requireOptimizer()) return;
    if (!asset?.data) return;
    const config = optimizerConfig();
    const seriesId = asset.seriesId;
    const task = beginModelTask('describe', seriesId, asset.id);
    if (!task) return;
    const request = { image: asset.data, role: asset.role === 'output' ? 'style' : asset.role, config };
    if (isVisibleSeries(seriesId) && state.view === 'gallery') renderGallery();
    try {
      const owner = isCurrentSeries(seriesId) ? state.series : await store.getSeries(seriesId);
      if (!owner) return;
      request.context = context ?? Engine.renderAnchor(owner.canon).slice(0, 800);
      const llm = Llm.createSeriesLlm({ request: post, concurrency: 1 });
      const result = await llm.describe(request);
      if (!result.ok) throw new Error(result.errors[0] || '分析结果为空');
      const saved = await store.updateAsset(asset.id, seriesId, current => ({ ...current,
        analysis: { status: 'done', model: config.model, ...result.data },
        note: current.note || result.data.appearance || result.data.summary || '' }));
      syncAssetRecord(saved);
      modelStatus(task, saved ? '已分析「' + (saved.name || '参考图') + '」。可把描述写进圣经，让文本锚点也带上这些特征。' : '参考图已删除，分析结果已忽略。', 'success');
    } catch (error) {
      const saved = await store.updateAsset(asset.id, seriesId, current => ({ ...current, analysis: { status: 'failed', error: describeError(error) } })).catch(() => null);
      syncAssetRecord(saved);
      modelStatus(task, '分析失败：' + describeError(error), 'error');
    } finally {
      finishModelTask(task);
      const editing = $('#seriesGalleryGrid').contains(document.activeElement) && document.activeElement.matches('input,textarea,select');
      if (isVisibleSeries(seriesId) && state.view === 'gallery' && !editing) renderGallery();
    }
  }

  async function analyzePending() {
    if (state.analyzing) return;
    if (!state.series) return;
    const seriesId = state.series.id;
    const context = Engine.renderAnchor(state.series.canon).slice(0, 800);
    state.analyzing = true;
    const pending = state.assets.filter(asset => asset.role !== 'output' && asset.analysis?.status !== 'done' && asset.analysis?.status !== 'running');
    for (const asset of pending) {
      if (state.analyzing === false) break;
      await analyzeAsset(asset, context);
    }
    state.analyzing = false;
    if (isVisibleSeries(seriesId) && state.view === 'gallery') renderGallery();
  }

  // ---------------------------------------------------------------- matrix

  // The matrix is the "same recipe, different variables" view: every axis combination is a
  // cell that can become a frame, so a set of shots can be produced without writing each one.
  function renderMatrix() {
    const container = $('#seriesMatrix');
    const series = state.series;
    if (!series) return;
    const { combinations, total, truncated, axes, errors } = Engine.expandMatrix(series.axes || []);
    $('#seriesMatrixEmpty').hidden = combinations.length > 0;
    const summary = $('#seriesMatrixSummary');
    if (summary) {
      if (errors.length) {
        summary.textContent = errors.join(' ');
      } else if (!combinations.length) {
        summary.textContent = '';
      } else {
        const built = new Set(state.shots.filter(shot => {
          const entries = Object.entries(shot.axisValues || {}).filter(([, value]) => String(value || '').trim());
          return entries.length === axes.length && axes.every(axis => axis.values.includes(String(shot.axisValues?.[axis.id] || '').trim()));
        }).map(shot => Engine.matrixKey(shot.axisValues))).size;
        summary.textContent = '共 ' + total + ' 种组合，已建 ' + built + ' 组。'
          + (truncated ? '当前显示前 ' + combinations.length + ' 组。' : '') + '建帧只创建草稿，不会调用生图模型。';
      }
    }
    $('#seriesMatrixBuild').textContent = truncated ? '建立当前前 ' + Engine.AXIS_LIMIT + ' 组帧' : '按轴展开全部帧';
    $('#seriesMatrixBuild').disabled = Boolean(errors.length || !combinations.length);
    if (!combinations.length) { container.replaceChildren(); return; }

    const existing = new Map();
    for (const shot of state.shots) {
      const key = Engine.matrixKey(shot.axisValues);
      if (!existing.has(key)) existing.set(key, shot);
    }

    const header = el('div', 'series-matrix-row is-head');
    header.append(el('span', 'series-matrix-cell', '轴取值组合'), el('span', 'series-matrix-cell', '状态'), el('span', 'series-matrix-cell', '操作'));
    const rows = combinations.map(combo => {
      const key = Engine.matrixKey(combo);
      const shot = existing.get(key);
      const row = el('div', 'series-matrix-row');
      row.dataset.matrixKey = key;
      if (shot?.result?.assetId) row.classList.add('is-done');
      const label = el('span', 'series-matrix-cell');
      label.textContent = Object.entries(combo).map(([axisId, value]) => {
        const axis = (series.axes || []).find(item => item.id === axisId);
        return (axis?.label || axisId) + '：' + value;
      }).join(' · ');
      const stateCell = el('span', 'series-matrix-cell');
      stateCell.textContent = shot ? (shot.pendingGeneration ? '待保存' : shot.result?.assetId ? '已出图' : '已建帧') : '未建帧';
      const action = el('span', 'series-matrix-cell');
      if (shot) {
        action.append(button('查看', 'text-action', () => { setView('outline'); selectShot(shot.id); }));
      } else {
        const build = button('建帧', 'text-action', () => createMatrixFrames([combo], series));
        build.dataset.action = 'build-matrix-frame';
        action.append(build);
      }
      row.append(label, stateCell, action);
      return row;
    });
    container.replaceChildren(header, ...rows);
    if (truncated) {
      container.append(el('p', 'series-hint', '共 ' + total + ' 种完整组合，仅显示并可批量建立前 ' + Engine.AXIS_LIMIT + ' 组；可减少取值后再建立其他组合。'));
    }
  }

  async function buildMatrixFrames() {
    const series = state.series;
    if (!series) return;
    const { combinations, errors } = Engine.expandMatrix(series.axes || []);
    if (errors.length) { status(errors.join(' '), 'error'); return; }
    if (!combinations.length) { status('还没有可变轴。先到「圣经」里定义轴与取值。', 'error'); return; }
    await createMatrixFrames(combinations, series);
  }

  async function createMatrixFrames(combinations, series) {
    const assets = isCurrentSeries(series.id) ? state.assets : [];
    const candidates = combinations.map((combo, index) => ({ ...newShot(index, series, assets), axisValues: combo, origin: 'matrix' }));
    try {
      // The store checks ownership and deduplicates inside one transaction, even
      // for rapid clicks or two store instances building the same combination.
      const created = await store.appendMatrixShots(series.id, candidates);
      if (!isCurrentSeries(series.id)) return;
      for (const shot of created) if (!state.shots.some(item => item.id === shot.id)) state.shots.push(shot);
      state.shots.sort((a, b) => (a.order ?? a.index ?? 0) - (b.order ?? b.index ?? 0));
      if (isVisibleSeries(series.id)) {
        renderMatrix();
        renderShots({ updateInspector: false });
        renderHeader();
        status(created.length ? '已按轴建立 ' + created.length + ' 帧草稿，未调用生图模型。' : '当前组合都已经建过帧，未重复添加。', 'success');
      }
    } catch (error) {
      if (isVisibleSeries(series.id)) status('矩阵建帧失败：' + describeError(error), 'error');
    }
  }

  // ---------------------------------------------------------------- batch

  function batchTargets() {
    return state.shots.filter(shot => !shot.result?.assetId && !shot.pendingGeneration);
  }

  // `shots` overrides the default "everything without a result" selection, so a hand-picked
  // set can be generated (or regenerated) without touching other frames. `ask` skips the
  // confirmation when the caller already asked (the split flow does).
  async function startBatch({ shots = null, ask = true } = {}) {
    if (state.batch) { status('已有批次在运行。'); return; }
    const explicit = Array.isArray(shots) && shots.length > 0;
    const targets = explicit ? shots.filter(shot => !shot.pendingGeneration) : batchTargets();
    if (!targets.length) {
      status(state.shots.some(shot => shot.pendingGeneration) ? '有图片待保存，请在帧详情中重试保存，不会重新调用生图模型。' : '没有待生成的帧。');
      return;
    }
    const config = imageConfig();
    if (!config.apiKey || !config.model) { status('请先在「设置」中填写图片生成 API。', 'error'); return; }
    const price = Number($('#seriesBatchPrice').value);
    const estimate = Number.isFinite(price) && price > 0 ? '预估 $' + (price * targets.length).toFixed(2) : '未填单价，无法预估费用';
    if (ask) {
      // Billable action: spell out the count and the cost before anything is sent.
      const proceed = await confirmAction({
        title: '开始批量生成',
        text: '将依次生成 ' + targets.length + ' 帧，每帧 1 张。' + estimate + '。每张都会实际计费。',
        confirmLabel: '开始生成',
        danger: false
      });
      if (!proceed) return;
    }

    const batch = { targets, done: 0, failed: 0, pending: 0, cancelled: false, paused: false, controller: new AbortController() };
    state.batch = batch;
    $('#seriesBatchBar').hidden = false;
    $('#seriesBatchTitle').textContent = '批量生成';
    $('#seriesBatchProgress').textContent = '0 / ' + targets.length;
    $('#seriesBatchCost').textContent = estimate;
    $('#seriesBatchPause').hidden = false;
    $('#seriesBatchCancel').disabled = false;
    renderBatchBar();

    for (const shot of targets) {
      if (batch.cancelled) break;
      // Honour the pause button between frames; the in-flight frame still finishes.
      while (batch.paused && !batch.cancelled) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (batch.cancelled) break;
      await generateShot(shot);
      batch.done++;
      if (shot.status === 'failed') batch.failed++;
      if (shot.pendingGeneration) batch.pending++;
      $('#seriesBatchProgress').textContent = batch.done + ' / ' + targets.length;
      renderBatchBar();
    }
    state.batch = null;
    $('#seriesBatchBar').hidden = false;
    $('#seriesBatchTitle').textContent = batch.cancelled ? '批量已取消' : batch.pending ? '批量结束，有图片待保存' : '批量完成';
    $('#seriesBatchProgress').textContent = batch.done + ' / ' + batch.targets.length;
    $('#seriesBatchPause').hidden = true;
    $('#seriesBatchCancel').disabled = true;
    renderSelectionBar();
    updateGalleryButtons();
    status((batch.cancelled ? '已取消，已处理 ' + batch.done + ' 帧。' : '批量结束：已处理 ' + batch.done + ' 帧，失败 ' + batch.failed + ' 帧。')
      + (batch.pending ? ' 其中 ' + batch.pending + ' 帧图片待保存，请在帧详情重试保存。' : ''), batch.failed ? 'error' : batch.pending ? 'info' : 'success');
    // Only auto-hide if no new batch started in the meantime.
    setTimeout(() => {
      if (state.batch) return;
      $('#seriesBatchBar').hidden = true;
      $('#seriesBatchCancel').disabled = false;
      $('#seriesBatchCost').textContent = '';
    }, 5000);
  }

  function renderBatchBar() {
    const batch = state.batch;
    if (!batch) return;
    $('#seriesBatchPause').textContent = batch.paused ? '继续' : '暂停';
    $('#seriesBatchPause').hidden = false;
  }

  // ---------------------------------------------------------------- lore

  function renderLore() {
    const list = $('#seriesLoreList');
    const query = ($('#seriesLoreSearch')?.value || '').trim().toLowerCase();
    const items = state.lore.filter(item => !query || (item.title + ' ' + item.text).toLowerCase().includes(query));
    list.replaceChildren(...items.map(item => {
      const card = el('article', 'series-lore-card');
      const head = el('div', 'series-lore-head');
      const title = el('input');
      title.type = 'text';
      title.value = item.title || '';
      title.placeholder = '条目标题';
      title.setAttribute('aria-label', '档案条目标题');
      title.addEventListener('change', async () => { item.title = title.value; await store.putLore([item]); });
      const meta = el('span', 'series-lore-meta', (item.text || '').length + ' 字符');
      head.append(title, meta);
      const body = el('p', 'series-lore-text', (item.text || '').slice(0, 400) + ((item.text || '').length > 400 ? '…' : ''));
      const actions = el('div', 'series-lore-actions-row');
      actions.append(button('删除', 'text-action', async () => {
        const ok = await confirmAction({
          title: '删除档案条目',
          text: '删除「' + (item.title || '未命名条目') + '」？引用它的帧会失去这段设定。',
          confirmLabel: '删除'
        });
        if (!ok) return;
        await store.deleteLore(item.id);
        state.lore = state.lore.filter(entry => entry.id !== item.id);
        renderLore();
      }));
      card.append(head, body, actions);
      return card;
    }));
    $('#seriesLoreEmpty').hidden = state.lore.length > 0;
  }

  function openLoreDialog() {
    if (!state.series) return;
    $('#seriesLoreTitleInput').value = '';
    $('#seriesLoreText').value = '';
    const dialog = $('#seriesLoreDialog');
    if (!dialog.open) dialog.showModal();
    $('#seriesLoreText').focus();
  }

  async function saveLoreEntry() {
    const text = $('#seriesLoreText').value.trim();
    if (!text) { $('#seriesLoreText').focus(); return; }
    const title = ($('#seriesLoreTitleInput').value.trim() || ('档案 ' + (state.lore.length + 1))).slice(0, 60);
    const item = { id: uid('lore'), seriesId: state.series.id, title, text, createdAt: Date.now() };
    try {
      await store.putLore([item]);
    } catch (error) {
      status('档案保存失败：' + (error.message || '浏览器存储不可用'), 'error');
      return;
    }
    state.lore.push(item);
    $('#seriesLoreDialog').close();
    renderLore();
    status('已添加档案条目「' + title + '」。在帧详情的「引用设定」里勾选后，它才会进入该帧的提示词。', 'success');
  }

  // ---------------------------------------------------------------- new series

  function openNewDialog() {
    $('#seriesNewName').value = '';
    $('#seriesNewTheme').value = '';
    const select = $('#seriesNewTemplate');
    const templates = root.SeriesTemplates?.TEMPLATES || [];
    if (select.options.length <= 1 && templates.length) {
      for (const template of templates) select.append(new Option(template.title, template.id));
    }
    select.value = '';
    const dialog = $('#seriesNewDialog');
    if (!dialog.open) dialog.showModal();
    $('#seriesNewName').focus();
  }

  function applyTemplate(series, template) {
    // Deep copy so editing the series can never mutate the shared template object.
    const copy = JSON.parse(JSON.stringify(template));
    Object.assign(series.canon, copy.canon);
    series.canon.version = 1;
    series.canon.anchorSentence = Engine.renderAnchor(series.canon);
    series.axes = copy.axes || [];
    series.theme.statement = series.theme.statement || copy.theme;
    return copy;
  }

  async function createSeries(name, theme, templateId) {
    const template = templateId ? root.SeriesTemplates?.byId.get(templateId) : null;
    const series = blankSeries(name, theme || template?.theme || '');
    let copied = null;
    if (template) {
      copied = applyTemplate(series, template);
      series.theme.statement = theme.trim() || copied.theme;
    }
    await store.putSeries(series);
    await loadSeriesList();
    await openSeries(series.id);

    if (copied) {
      const shots = copied.shots.map((item, index) => ({
          ...newShot(index, series, []),
          code: item.code || 'S' + String(index + 1).padStart(2, '0'),
          title: item.title || '',
          beat: item.beat || '',
          subject: item.subject || '',
          action: item.action || '',
          scene: item.scene || '',
          detail: item.detail || '',
          axisValues: item.axisValues || {},
          origin: 'template'
        }));
      const saved = await store.appendShots(series.id, shots);
      if (!isVisibleSeries(series.id)) return;
      state.shots.push(...saved.filter(shot => !state.shots.some(item => item.id === shot.id)));
      renderShots();
      setView('canon');
      status('已用「' + template.title + '」模板创建系列：' + copied.shots.length + ' 帧已建好。请先替换主题与角色设定。', 'success');
      return;
    }

    if (!isVisibleSeries(series.id)) return;
    setView(theme.trim() ? 'canon' : 'outline');
    if (theme.trim()) {
      if (hasOptimizer()) {
        await runExtract({
          theme,
          seriesId: series.id,
          onDone: result => {
            if (result.canonDraft) return applyCanonDraft(result.canonDraft, result, series.id).then(applied => {
              if (applied && isVisibleSeries(series.id)) setView('canon');
              return applied;
            });
            return false;
          }
        });
      } else {
        status('已创建系列。要自动提炼圣经，请先在设置中填写「图片生成 API」（系列复用同一套模型配置）；也可以手动填写。', 'info');
      }
    }
  }

  // ---------------------------------------------------------------- import/export

  async function exportCurrent() {
    if (!state.series) return;
    const payload = Engine.exportSeries({
      series: state.series,
      shots: state.shots,
      assets: state.assets,
      lore: state.lore
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (state.series.title || 'series') + '-series.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status('已导出系列包（含图片与提炼缓存）。', 'success');
  }

  async function importPackage(file) {
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch { status('无法解析文件，请确认是本应用导出的 JSON 系列包。', 'error'); return; }
    const check = Engine.validateImport(payload);
    if (!check.ok) { status('导入失败：' + check.errors.join(' '), 'error'); return; }
    const newId = uid('srs');
    const restored = Engine.normalizeImportedSeries(payload, { newId });
    restored.series.updatedAt = Date.now();
    await store.replaceSeriesBundle(restored);
    await loadSeriesList();
    await openSeries(newId);
    status('已导入系列「' + restored.series.title + '」，含 ' + restored.shots.length + ' 帧与 ' + restored.assets.length + ' 张图片。', 'success');
  }

  // ---------------------------------------------------------------- promote existing work

  // The page CSP restricts connect-src to 'self', so a data: URL cannot be fetched.
  // Decode it directly instead.
  function dataUrlToBlob(value) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(value);
    if (!match) throw new Error('图片数据格式无效');
    const mime = match[1] || 'image/png';
    if (match[2]) {
      const binary = atob(match[3]);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(match[3])], { type: mime });
  }

  // Reads an already-generated image (data URL or remote URL) into a Blob so it can go
  // through the same compression path as a fresh upload.
  async function blobFromSource(src) {
    const value = String(src || '');
    if (!value) throw new Error('图片来源为空');
    if (value.startsWith('data:')) return dataUrlToBlob(value);
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: value })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error?.message || error?.error || '图片下载失败，链接可能已过期');
    }
    return response.blob();
  }

  // Turns selected gallery works (or a single finished image) into a series where each
  // image becomes a frame that already has a result.
  async function composeFromGallery(items, { title } = {}) {
    if (!Array.isArray(items) || !items.length) return;
    if (state.busy) { status('当前有任务在进行，请稍后再试。'); return; }
    if (!initialized) await activate();

    const name = String(title || '来自画廊的系列').slice(0, 60);
    const previousId = state.series?.id || null;
    const series = blankSeries(name, '');
    await store.putSeries(series);
    await loadSeriesList();
    await openSeries(series.id);

    let added = 0;
    let firstAssetId = null;
    const failures = [];
    for (const [index, item] of items.entries()) {
      try {
        const blob = await blobFromSource(item.src);
        const compressed = await compressImage(blob);
        const asset = {
          id: uid('ast'),
          seriesId: series.id,
          role: 'other',
          name: ('作品 ' + (index + 1)).slice(0, 40),
          note: String(item.prompt || '').slice(0, 400),
          mime: compressed.mime,
          data: compressed.data,
          width: compressed.width,
          height: compressed.height,
          bytes: compressed.bytes,
          original: compressed.original,
          sha256: compressed.sha256,
          createdAt: Date.now()
        };
        const inserted = await store.addAssetToSeries(asset, { deduplicate: false });
        if (!inserted.added) break;
        syncAssetRecord(asset);
        if (!firstAssetId) firstAssetId = asset.id;
        const shot = {
          ...newShot(index, series, []),
          title: String(item.prompt || '未命名帧').slice(0, 24),
          origin: 'gallery',
          status: 'done',
          result: { assetId: asset.id, drift: 0 }
        };
        const saved = await store.appendShots(series.id, [shot]);
        if (!saved.length) break;
        if (isCurrentSeries(series.id)) state.shots.push(...saved.filter(item => !state.shots.some(current => current.id === item.id)));
        added++;
      } catch (error) {
        failures.push((index + 1) + ': ' + (error.message || '无法读取'));
      }
    }

    if (!added) {
      // Do not leave an empty series behind when every image failed to import.
      await store.deleteSeries(series.id).catch(() => {});
      await loadSeriesList();
      if (isCurrentSeries(series.id)) {
        if (previousId) await openSeries(previousId).catch(() => {});
        else closeSeries();
        status('没有可导入的图片。' + (failures.length ? '首个错误：' + failures[0] : ''), 'error');
      }
      return;
    }
    // The first imported work becomes the default style anchor for new frames.
    // openSeries() replaced state.series with a fresh copy, so patch that object.
    if (firstAssetId) {
      const saved = await store.updateSeries(series.id, current => ({ ...current,
        gallery: { ...current.gallery, defaults: { ...(current.gallery?.defaults || {}), style: firstAssetId } }
      }));
      syncSeriesRecord(saved);
    }
    if (!isCurrentSeries(series.id)) return;
    renderShots();
    setView('outline');
    status('已用 ' + added + ' 张作品创建系列「' + name + '」，第一张已设为默认风格锚点。', 'success');
    if (window.location.hash !== '#series') window.location.hash = 'series';
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    $('#seriesNew').addEventListener('click', openNewDialog);
    $('#seriesNewClose').addEventListener('click', () => $('#seriesNewDialog').close());
    $('#seriesNewCancel').addEventListener('click', () => $('#seriesNewDialog').close());
    $('#seriesNewForm').addEventListener('submit', async event => {
      event.preventDefault();
      const name = $('#seriesNewName').value.trim();
      if (!name) return;
      const theme = $('#seriesNewTheme').value;
      const templateId = $('#seriesNewTemplate').value;
      $('#seriesNewDialog').close();
      await createSeries(name, theme, templateId);
    });
    // Selecting a template suggests a sensible default name and theme.
    $('#seriesNewTemplate').addEventListener('change', event => {
      const template = event.target.value ? root.SeriesTemplates?.byId.get(event.target.value) : null;
      if (!template) return;
      if (!$('#seriesNewName').value.trim()) $('#seriesNewName').value = template.title;
      if (!$('#seriesNewTheme').value.trim()) $('#seriesNewTheme').value = template.theme;
      $('#seriesNewTemplateHint').textContent = template.summary;
    });

    $('#seriesName').addEventListener('change', async () => {
      if (!state.series) return;
      await saveSeries({ title: $('#seriesName').value.trim() || '未命名系列' });
    });

    document.querySelectorAll('.series-tabs [data-series-view]').forEach(tab => {
      tab.addEventListener('click', () => setView(tab.dataset.seriesView));
    });

    $('#seriesInspectorClose').addEventListener('click', closeInspector);
    $('#seriesAddShot').addEventListener('click', addNewShot);
    $('#seriesAddAllGallery').addEventListener('click', addAllToGallery);
    // The gallery loads asynchronously; refresh the collect button when its list settles.
    document.addEventListener('artgallery:change', () => {
      if (!state.series) return;
      updateGalleryButtons();
      if (state.selectedShotId) renderInspector();
    });
    $('#seriesSuggestFrames').addEventListener('click', openSplitDialog);
    // Guide buttons mirror the toolbar actions so a new series has an obvious next step.
    $('#seriesGuideCanon').addEventListener('click', () => setView('canon'));
    $('#seriesGuideGallery').addEventListener('click', () => setView('gallery'));
    $('#seriesGuideAddShot').addEventListener('click', addNewShot);
    $('#seriesGuideSuggest').addEventListener('click', openSplitDialog);
    // Split dialog.
    $('#seriesSplitClose').addEventListener('click', closeSplitDialog);
    $('#seriesSplitCancel').addEventListener('click', closeSplitDialog);
    $('#seriesSplitStart').addEventListener('click', runSplit);
    $('#seriesSplitCount').addEventListener('input', updateSplitSummary);
    $('#seriesSplitSelectAll').addEventListener('click', () => {
      const boxes = [...document.querySelectorAll('#seriesSplitLore input')];
      const allOn = boxes.every(box => box.checked);
      for (const box of boxes) { box.checked = !allOn; box.dispatchEvent(new Event('change')); }
    });
    // Count presets are a shortcut for typing a number.
    document.querySelectorAll('[data-split-count]').forEach(preset => {
      preset.addEventListener('click', () => {
        $('#seriesSplitCount').value = preset.dataset.splitCount;
        updateSplitSummary();
      });
    });
    // Frame selection drives batch generation.
    $('#seriesSelectAllShots').addEventListener('change', event => {
      const all = event.target.checked;
      state.selectedShotIds.clear();
      if (all) for (const shot of state.shots) state.selectedShotIds.add(shot.id);
      renderShots();
    });
    $('#seriesBatchSelected').addEventListener('click', () => {
      const chosen = state.shots.filter(shot => state.selectedShotIds.has(shot.id));
      if (!chosen.length) { status('先勾选要生成的帧。'); return; }
      startBatch({ shots: chosen });
    });
    $('#seriesGuideExtract').addEventListener('click', () => {
      if (hasOptimizer()) { extractIntoCanon(); return; }
      // No model configured: open the optimizer settings tab, which powers these calls.
      $('#settingsButton')?.click();
      $('#optimizerSettingsTab')?.click();
      status('在这里填写提示词优化 API 的 URL、Key 与文本模型；系列提炼、看图与拆分帧都复用这套配置。', 'info');
    });
    $('#seriesCanonExtract').addEventListener('click', extractIntoCanon);
    $('#seriesCanonSave').addEventListener('click', saveCanonVersion);
    $('#seriesMatrixBuild').addEventListener('click', buildMatrixFrames);
    $('#seriesBatchStart').addEventListener('click', () => startBatch());
    $('#seriesBatchCancel').addEventListener('click', () => {
      if (state.batch) { state.batch.cancelled = true; status('将在当前帧完成后停止。'); }
    });
    $('#seriesBatchPause').addEventListener('click', () => {
      if (!state.batch) return;
      state.batch.paused = !state.batch.paused;
      renderBatchBar();
    });

    $('#seriesGalleryAdd').addEventListener('click', () => $('#seriesGalleryInput').click());
    $('#seriesGalleryInput').addEventListener('change', event => {
      addGalleryFiles(event.target.files);
      event.target.value = '';
    });
    $('#seriesGalleryAnalyze').addEventListener('click', analyzePending);

    $('#seriesLoreAdd').addEventListener('click', openLoreDialog);
    $('#seriesLoreSearch').addEventListener('input', renderLore);
    $('#seriesLoreClose').addEventListener('click', () => $('#seriesLoreDialog').close());
    $('#seriesLoreCancel').addEventListener('click', () => $('#seriesLoreDialog').close());
    $('#seriesLoreForm').addEventListener('submit', async event => {
      event.preventDefault();
      await saveLoreEntry();
    });

    $('#seriesExport').addEventListener('click', exportCurrent);
    $('#seriesImport').addEventListener('click', () => $('#seriesImportInput').click());
    $('#seriesImportInput').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file) importPackage(file);
      event.target.value = '';
    });

    // Pause stops the current run; completed chunks are already cached, so clicking
    // "从主题提炼" again resumes from the breakpoint instead of re-paying for them.
    $('#seriesExtractPause').addEventListener('click', () => {
      closeExtractDialog();
    });
    $('#seriesExtractClose').addEventListener('click', () => {
      closeExtractDialog();
    });
    $('#seriesExtractDialog').addEventListener('close', () => {
      const task = state.extractTask;
      if (!task) return;
      task.cancelled = true;
      task.llm?.cancel();
      modelStatus(task, '已暂停提炼，已完成的分块保留。再次提炼可继续；已发送的请求可能计费。');
    });
    $('#seriesSplitDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeSplitDialog();
    });
    $('#seriesSplitDialog').addEventListener('close', () => {
      // A close event from an earlier opening must not cancel a newly opened task.
      if (!$('#seriesSplitDialog').open) cancelSplitTask();
    });

    // Esc closes the confirm dialog; the close event resolves the pending promise either way.
    $('#seriesConfirmDialog').addEventListener('cancel', event => {
      event.preventDefault();
      $('#seriesConfirmDialog').close('cancel');
    });
    $('#seriesConfirmDialog').addEventListener('close', event => {
      settleConfirm(event.target.returnValue);
    });

    // Drag and drop straight onto the gallery view.
    const galleryView = $('#seriesViewGallery');
    ['dragenter', 'dragover'].forEach(type => galleryView.addEventListener(type, event => {
      event.preventDefault();
      galleryView.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(type => galleryView.addEventListener(type, event => {
      event.preventDefault();
      galleryView.classList.remove('drag-over');
    }));
    galleryView.addEventListener('drop', event => addGalleryFiles(event.dataTransfer.files));
  }

  let initialized = false;

  async function activate() {
    if (!initialized) {
      initialized = true;
      bind();
      await loadSeriesList();
      if (!state.series && !state.openRequest && state.list.length) await openSeries(state.list[0].id);
    } else {
      await loadSeriesList();
      if (state.series) {
        const seriesId = state.series.id;
        const fresh = await store.getSeries(seriesId);
        if (isCurrentSeries(seriesId)) {
          if (!fresh) closeSeries();
          else renderAll();
        }
      }
    }
  }

  root.SeriesPage = { activate, state, composeFromGallery };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (location.hash === '#series') activate(); });
  else if (location.hash === '#series') activate();
})(typeof globalThis !== 'undefined' ? globalThis : this);
