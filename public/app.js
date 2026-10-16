'use strict';
const $ = selector => document.querySelector(selector);
const settings = { apiUrl: $('#apiUrl'), apiKey: $('#apiKey'), model: $('#model') };
const optimizerSettings = { apiUrl: $('#optimizerUrl'), apiKey: $('#optimizerKey'), model: $('#optimizerModel') };
const optimizationStrength = $('#optimizationStrength');
const optimizationStrengthLabels = { light: '轻度润色', standard: '标准优化', rich: '丰富细节' };
const promptInput = $('#prompt');
const resultArea = $('#resultArea');
const generateButton = $('#generateButton');
const historyGrid = $('#historyGrid');
const memoryHistory = [];
let displayedHistory = [];
let historyDeleting = false;
const referenceImages = [];
let loadingReferences = false;
let generating = false;
let optimizing = false;
let activeTask = null;
let promptBeforeOptimization = null;
let pendingOptimization = null;
let customCapabilitiesInitialized = false;
let historyQueue = Promise.resolve();
const safeStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Private browsing may restrict storage. */ } }
};
// sessionStorage survives reloads in the same tab, but is cleared when that tab closes.
const safeSessionStorage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ } }
};
const sessionStorageKeys = { imageApiKey: 'prompt-studio-image-api-key', optimizerApiKey: 'prompt-studio-optimizer-api-key' };
const presetStorageKeys = { image: 'prompt-studio-image-presets', optimizer: 'prompt-studio-optimizer-presets' };
const activePresets = { image: '', optimizer: '' };
function readPresets(kind) {
  try {
    const value = JSON.parse(safeStorage.get(presetStorageKeys[kind]) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const presets = Object.create(null);
    for (const [name, preset] of Object.entries(value)) {
      if (presetName(name) !== name || !preset || typeof preset !== 'object' || Array.isArray(preset)) continue;
      try {
        const url = new URL(preset.apiUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || typeof preset.model !== 'string' || !preset.model.trim() || preset.model.length > 200) continue;
        presets[name] = { apiUrl: url.href, model: preset.model };
        if (kind === 'image') {
          const resolved = ModelCapabilities.resolve(preset.model, preset.capabilities);
          presets[name].capabilities = preset.capabilities?.mode === 'custom' ? { mode: 'custom', ...resolved } : { mode: 'auto' };
          for (const key of ['size', 'quality', 'count', 'responseFormat']) if (typeof preset[key] === 'string') presets[name][key] = preset[key];
        }
      } catch { delete presets[name]; }
    }
    return presets;
  } catch { return {}; }
}
function writePresets(kind, presets) {
  try { localStorage.setItem(presetStorageKeys[kind], JSON.stringify(presets)); return true; }
  catch { return false; }
}
function presetName(value) {
  const name = String(value || '').trim();
  return name && name.length <= 40 && !/[\r\n]/.test(name) ? name : null;
}
function presetSelect(kind) { return $(kind === 'image' ? '#imagePreset' : '#optimizerPreset'); }
function presetNameInput(kind) { return $(kind === 'image' ? '#imagePresetName' : '#optimizerPresetName'); }
function refreshPresetList(kind) {
  const select = presetSelect(kind);
  const names = Object.keys(readPresets(kind)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  select.replaceChildren(new Option('不使用预设', ''), ...names.map(name => new Option(name, name)));
  select.value = activePresets[kind] && names.includes(activePresets[kind]) ? activePresets[kind] : '';
  $(kind === 'image' ? '#deleteImagePreset' : '#deleteOptimizerPreset').disabled = !select.value || generating || optimizing || loadingReferences;
}
function imagePresetConfig() {
  return { apiUrl: settings.apiUrl.value.trim(), model: settings.model.value.trim(), capabilities: readCapabilityConfig(), size: $('#size').value, quality: $('#quality').value, count: $('#count').value, responseFormat: $('#responseFormat').value };
}
function optimizerPresetConfig() { return { apiUrl: optimizerSettings.apiUrl.value.trim(), model: optimizerSettings.model.value.trim() }; }
function setSelectIfAvailable(selector, value, fallback = 'default') {
  const select = $(selector);
  select.value = [...select.options].some(option => option.value === String(value)) ? String(value) : fallback;
}
function applyImagePreset(name) {
  if (generating || optimizing || loadingReferences) return;
  const preset = readPresets('image')[name];
  if (!preset) return;
  settings.apiUrl.value = String(preset.apiUrl || '');
  settings.model.value = String(preset.model || '');
  const capabilities = preset.capabilities && typeof preset.capabilities === 'object' ? preset.capabilities : { mode: 'auto' };
  $('#capabilityMode').value = capabilities.mode === 'custom' ? 'custom' : 'auto';
  customCapabilitiesInitialized = false;
  try {
    const resolved = ModelCapabilities.resolve(settings.model.value, capabilities);
    if (capabilities.mode === 'custom') { fillCapabilityEditor(resolved); customCapabilitiesInitialized = true; }
  } catch { $('#capabilityMode').value = 'auto'; }
  refreshModelOptions();
  setSelectIfAvailable('#size', preset.size);
  setSelectIfAvailable('#quality', preset.quality);
  setSelectIfAvailable('#count', preset.count, '1');
  setSelectIfAvailable('#responseFormat', preset.responseFormat, 'auto');
  settings.apiKey.value = '';
  settings.apiKey.type = 'password';
  $('#revealKey').setAttribute('aria-label', '显示 API Key');
  presetNameInput('image').value = name;
  activePresets.image = name;
  saveSettings();
  refreshPresetList('image');
  setStatus('已切换图片生成预设“' + name + '”，请重新填写 API Key。');
}
function applyOptimizerPreset(name) {
  if (generating || optimizing || loadingReferences) return;
  const preset = readPresets('optimizer')[name];
  if (!preset) return;
  optimizerSettings.apiUrl.value = String(preset.apiUrl || '');
  optimizerSettings.model.value = String(preset.model || '');
  optimizerSettings.apiKey.value = '';
  optimizerSettings.apiKey.type = 'password';
  $('#revealOptimizerKey').setAttribute('aria-label', '显示优化 API Key');
  presetNameInput('optimizer').value = name;
  activePresets.optimizer = name;
  saveOptimizerSettings();
  refreshPresetList('optimizer');
  setOptimizerStatus('已切换优化 API 预设“' + name + '”，请重新填写优化 API Key。');
}
function savePreset(kind) {
  if (generating || optimizing || loadingReferences) return;
  const name = presetName(presetNameInput(kind).value);
  if (!name) {
    const message = '请输入 1–40 个字符的预设名称。';
    kind === 'image' ? setStatus(message, 'error') : setOptimizerStatus(message, 'error');
    presetNameInput(kind).focus();
    return;
  }
  const presets = readPresets(kind);
  const config = kind === 'image' ? imagePresetConfig() : optimizerPresetConfig();
  const fields = kind === 'image' ? settings : optimizerSettings;
  if (!fields.apiUrl.value.trim() || !fields.apiUrl.checkValidity() || !config.model || config.model.length > 200) {
    const message = '保存预设前请填写有效的 API URL 和模型；无需填写 API Key。';
    kind === 'image' ? setStatus(message, 'error') : setOptimizerStatus(message, 'error');
    return;
  }
  try {
    const url = new URL(config.apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API URL 必须为不包含用户名和密码的 HTTP / HTTPS 地址。');
    if (kind === 'image') ModelCapabilities.resolve(config.model, config.capabilities);
  } catch (error) {
    kind === 'image' ? setStatus(error.message, 'error') : setOptimizerStatus(error.message, 'error');
    return;
  }
  Object.defineProperty(presets, name, { value: config, enumerable: true, configurable: true, writable: true });
  if (!writePresets(kind, presets)) {
    kind === 'image' ? setStatus('浏览器无法保存预设，请检查存储权限。', 'error') : setOptimizerStatus('浏览器无法保存预设，请检查存储权限。', 'error');
    return;
  }
  activePresets[kind] = name;
  kind === 'image' ? saveSettings() : saveOptimizerSettings();
  presetNameInput(kind).value = name;
  refreshPresetList(kind);
  kind === 'image' ? setStatus('图片生成预设“' + name + '”已保存，不包含 API Key。', 'success') : setOptimizerStatus('优化 API 预设“' + name + '”已保存，不包含 API Key。', 'success');
}
function deletePreset(kind) {
  if (generating || optimizing || loadingReferences) return;
  const name = presetSelect(kind).value;
  if (!name) return;
  const presets = readPresets(kind);
  delete presets[name];
  if (!writePresets(kind, presets)) {
    kind === 'image' ? setStatus('浏览器无法删除预设，请检查存储权限。', 'error') : setOptimizerStatus('浏览器无法删除预设，请检查存储权限。', 'error');
    return;
  }
  activePresets[kind] = '';
  presetNameInput(kind).value = '';
  kind === 'image' ? saveSettings() : saveOptimizerSettings();
  refreshPresetList(kind);
  kind === 'image' ? setStatus('已删除图片生成预设“' + name + '”。') : setOptimizerStatus('已删除优化 API 预设“' + name + '”。');
}
function setStatus(message, type = 'info') {
  $('#statusText').textContent = message;
  $('#statusBox').dataset.type = type;
  $('#workspaceStatus').textContent = message;
  $('#workspaceStatus').dataset.type = type;
}
function setOptimizerStatus(message, type = 'info') {
  $('#optimizerStatusText').textContent = message;
  $('#optimizerStatusBox').dataset.type = type;
  $('#workspaceStatus').textContent = message;
  $('#workspaceStatus').dataset.type = type;
}
function updateActionState() {
  const busy = generating || optimizing || loadingReferences;
  generateButton.disabled = busy;
  $('#optimizeButton').disabled = busy;
  const capabilities = currentCapabilities();
  $('#addReference').disabled = busy || referenceImages.length >= capabilities.maxReferences;
  $('#undoOptimize').disabled = busy;
  optimizationStrength.disabled = optimizing;
  promptInput.readOnly = optimizing;
  for (const kind of ['image', 'optimizer']) {
    const suffix = kind === 'image' ? 'Image' : 'Optimizer';
    presetSelect(kind).disabled = busy;
    presetNameInput(kind).disabled = busy;
    $('#save' + suffix + 'Preset').disabled = busy;
    $('#delete' + suffix + 'Preset').disabled = busy || !presetSelect(kind).value;
  }
}
function beginTask(kind) {
  const task = { kind, controller: new AbortController(), started: performance.now() };
  activeTask = task;
  generating = kind === 'generate';
  optimizing = kind === 'optimize';
  $('#cancelButton').hidden = false;
  $('#cancelButton').setAttribute('aria-label', generating ? '取消图片生成' : '取消提示词优化');
  $('#taskProgress').hidden = false;
  const updateElapsed = () => {
    $('#taskElapsed').textContent = '已等待 ' + Math.floor((performance.now() - task.started) / 1000) + ' 秒';
  };
  updateElapsed();
  task.timer = setInterval(updateElapsed, 1000);
  updateActionState();
  updateReferences();
  $('#generateLabel').textContent = generating ? '正在生成…' : '生成图片';
  $('#optimizeLabel').textContent = optimizing ? '正在优化…' : '优化提示词';
  resultArea.setAttribute('aria-busy', String(generating));
  return task;
}
function taskIsCurrent(task) {
  return activeTask === task && !task.controller.signal.aborted;
}
function formatRequestError(error, fallback = '请求失败，请检查服务是否运行。') {
  if (error?.diagnostic) {
    const diagnostic = error.diagnostic;
    const meta = [diagnostic.status ? 'HTTP ' + diagnostic.status : '', diagnostic.code ? '错误码 ' + diagnostic.code : ''].filter(Boolean).join('，');
    const parts = [diagnostic.label + (meta ? '（' + meta + '）' : ''), diagnostic.suggestion];
    if (diagnostic.detail && diagnostic.detail !== error.message) parts.push('原始信息：' + diagnostic.detail);
    return parts.filter(Boolean).join(' ');
  }
  return error?.message || fallback;
}
function finishTask(task) {
  if (activeTask !== task) return;
  clearInterval(task.timer);
  activeTask = null;
  generating = optimizing = false;
  $('#cancelButton').hidden = true;
  $('#taskProgress').hidden = true;
  $('#generateLabel').textContent = '生成图片';
  $('#optimizeLabel').textContent = '优化提示词';
  resultArea.setAttribute('aria-busy', 'false');
  updateActionState();
  updateReferences();
}
function reportTaskError(task, error) {
  if (!taskIsCurrent(task)) return;
  const report = task.kind === 'generate' ? setStatus : setOptimizerStatus;
  report(error.status === 504 || error.name === 'TimeoutError'
    ? '请求超时，请检查服务状态后重试。'
    : formatRequestError(error), 'error');
}
$('#cancelButton').addEventListener('click', () => {
  const task = activeTask;
  if (!task) return;
  task.controller.abort();
  const report = task.kind === 'generate' ? setStatus : setOptimizerStatus;
  finishTask(task);
  report(task.kind === 'generate'
    ? '已取消本次生成，已有图片已保留。服务商仍可能继续处理或计费。'
    : '已取消提示词优化，原提示词已保留。服务商仍可能继续处理或计费。');
});
function saveOptimizerSettings() {
  safeStorage.set('prompt-studio-optimizer-url', optimizerSettings.apiUrl.value.trim());
  safeStorage.set('prompt-studio-optimizer-model', optimizerSettings.model.value.trim());
  safeStorage.set('prompt-studio-active-optimizer-preset', activePresets.optimizer);
  safeSessionStorage.set(sessionStorageKeys.optimizerApiKey, optimizerSettings.apiKey.value.trim());
}
function formatFileSize(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('参考图片读取失败，请重试'));
    reader.readAsDataURL(file);
  });
}
function updateReferences() {
  const limit = currentCapabilities().maxReferences;
  $('#addReference').title = limit ? '添加、拖入或粘贴参考图片（最多 ' + limit + ' 张）' : '当前模型能力不支持参考图';
  const list = $('#referenceList');
  list.replaceChildren();
  list.hidden = referenceImages.length === 0;
  $('#referenceHint').hidden = referenceImages.length === 0 && limit > 0;
  $('#referenceHint').textContent = !limit ? '当前模型能力不支持参考图。请调整设置或移除已上传图片。' : '支持 PNG / JPEG / WebP，当前最多 ' + limit + ' 张，单张 10 MB、总计 20 MB。可指定每张图用途及需要保留或修改的内容。';
  $('#generationMode').textContent = referenceImages.length ? '图生图' : '文生图';
  referenceImages.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'reference-item';
    const image = document.createElement('img');
    image.className = 'reference-thumb';
    image.src = item.preview;
    image.alt = '参考图 ' + (index + 1);
    image.addEventListener('click', () => openPreview(item.preview, item.name));
    const meta = document.createElement('div');
    meta.className = 'reference-meta';
    const heading = document.createElement('div');
    heading.className = 'reference-heading';
    const title = document.createElement('strong');
    title.textContent = '参考图 ' + (index + 1);
    const name = document.createElement('span');
    name.textContent = item.name + ' · ' + formatFileSize(item.size);
    heading.append(title, name);
    const purposeLabel = document.createElement('label');
    purposeLabel.textContent = '用途';
    const purpose = document.createElement('select');
    purpose.setAttribute('aria-label', '参考图 ' + (index + 1) + ' 用途');
    for (const [value, label] of [['', '未指定'], ['person', '人物'], ['composition', '构图'], ['style', '风格'], ['product', '产品外观'], ['custom', '自定义']]) purpose.add(new Option(label, value));
    purpose.value = item.purpose || '';
    purpose.disabled = generating || optimizing || loadingReferences;
    purposeLabel.appendChild(purpose);
    const customPurpose = document.createElement('input');
    customPurpose.type = 'text';
    customPurpose.maxLength = 80;
    customPurpose.placeholder = '自定义用途';
    customPurpose.setAttribute('aria-label', '参考图 ' + (index + 1) + ' 自定义用途');
    customPurpose.value = item.customPurpose || '';
    customPurpose.hidden = purpose.value !== 'custom';
    customPurpose.disabled = generating || optimizing || loadingReferences;
    customPurpose.addEventListener('input', () => { item.customPurpose = customPurpose.value; });
    purpose.addEventListener('change', () => {
      item.purpose = purpose.value;
      customPurpose.hidden = purpose.value !== 'custom';
      updateReferences();
      if (purpose.value === 'custom') list.querySelectorAll('input[aria-label$="自定义用途"]')[index]?.focus();
    });
    const details = document.createElement('div');
    details.className = 'reference-details';
    for (const [field, labelText, placeholder] of [['preserve', '需要保留', '例如：人物发型、衣服颜色'], ['change', '需要修改', '例如：背景改为海边日落']]) {
      const label = document.createElement('label');
      label.textContent = labelText;
      const input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = 500;
      input.placeholder = placeholder;
      input.setAttribute('aria-label', '参考图 ' + (index + 1) + ' ' + labelText + '内容');
      input.value = item[field] || '';
      input.disabled = generating || optimizing || loadingReferences;
      input.addEventListener('input', () => { item[field] = input.value; });
      label.appendChild(input);
      details.appendChild(label);
    }
    meta.append(heading, purposeLabel, customPurpose, details);
    const remove = document.createElement('button');
    remove.className = 'remove-reference';
    remove.type = 'button';
    remove.setAttribute('aria-label', '移除参考图 ' + (index + 1));
    remove.textContent = '×';
    remove.disabled = generating || optimizing || loadingReferences;
    remove.addEventListener('click', () => {
      if (generating || optimizing || loadingReferences) return;
      URL.revokeObjectURL(item.preview);
      referenceImages.splice(index, 1);
      updateReferences();
      updateActionState();
    });
    card.append(image, meta, remove);
    list.appendChild(card);
  });
}
async function addReferenceFiles(files) {
  if (generating || optimizing) return setStatus('正在处理，请等待本次完成后再修改参考图。');
  if (loadingReferences) return setStatus('正在读取参考图片，请稍候再添加。');
  const incoming = [...files];
  if (!incoming.length) return;
  const limit = currentCapabilities().maxReferences;
  if (!limit) return setStatus('当前模型能力不支持参考图，请在设置中确认服务支持后再开启。', 'error');
  if (referenceImages.length + incoming.length > limit) return setStatus('当前模型能力最多添加 ' + limit + ' 张参考图片。', 'error');
  if (incoming.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return setStatus('参考图仅支持 PNG、JPEG、WebP 格式。', 'error');
  if (incoming.some(file => file.size > 10 * 1024 * 1024)) return setStatus('单张参考图片不能超过 10 MB。', 'error');
  if (referenceImages.reduce((total, item) => total + item.size, 0) + incoming.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) return setStatus('参考图片总大小不能超过 20 MB。', 'error');
  loadingReferences = true;
  updateActionState();
  updateReferences();
  try {
    const batch = [];
    for (const file of incoming) {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      batch.push({ name: file.name || '参考图片', size: file.size, mime: file.type, b64_json: await fileToBase64(file), purpose: '', customPurpose: '', preserve: '', change: '' });
    }
    for (let index = 0; index < batch.length; index++) referenceImages.push({ ...batch[index], preview: URL.createObjectURL(incoming[index]) });
    updateReferences();
    setStatus('已添加 ' + referenceImages.length + ' 张参考图，可在卡片中填写用途和调整要求。');
  } catch { setStatus('图片读取失败，请确认上传的是可打开的 PNG、JPEG 或 WebP 图片。', 'error'); }
  finally {
    loadingReferences = false;
    updateActionState();
    updateReferences();
  }
}
function saveSettings() {
  safeStorage.set('prompt-studio-url', settings.apiUrl.value.trim());
  safeStorage.set('prompt-studio-model', settings.model.value.trim());
  safeStorage.set('prompt-studio-capabilities', JSON.stringify(readCapabilityConfig()));
  safeStorage.set('prompt-studio-image-defaults', JSON.stringify({ size: $('#size').value, quality: $('#quality').value, count: $('#count').value, responseFormat: $('#responseFormat').value }));
  safeStorage.set('prompt-studio-active-image-preset', activePresets.image);
  safeSessionStorage.set(sessionStorageKeys.imageApiKey, settings.apiKey.value.trim());
}
function safeImageSource(src) {
  if (typeof src !== 'string') return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/\r\n]*={0,2}$/.test(src)) return src;
  try {
    const url = new URL(src);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function imageSource(image) {
  return safeImageSource(image.b64_json ? 'data:' + (image.mime || 'image/png') + ';base64,' + image.b64_json : image.url);
}
async function apiRequest(route, body, signal) {
  const response = await fetch(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
  });
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('本地服务未返回有效数据，请确认服务仍在运行');
  }
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status, diagnostic: data.diagnostic });
  return data;
}
function getConfig() {
  if (!$('#settingsForm').checkValidity()) {
    openSettings();
    $('#settingsForm').reportValidity();
    return null;
  }
  const capabilities = readCapabilityConfig();
  try { ModelCapabilities.resolve(settings.model.value, capabilities); }
  catch (error) { openSettings(); setStatus(error.message, 'error'); return null; }
  return { apiUrl: settings.apiUrl.value.trim(), apiKey: settings.apiKey.value.trim(), model: settings.model.value.trim(), capabilities };
}
function selectSettingsTab(optimizer = false) {
  $('#settingsForm').hidden = optimizer;
  $('#optimizerSettingsForm').hidden = !optimizer;
  for (const [id, selected] of [['imageSettingsTab', !optimizer], ['optimizerSettingsTab', optimizer]]) {
    $('#' + id).setAttribute('aria-selected', String(selected));
    $('#' + id).tabIndex = selected ? 0 : -1;
  }
}
function openSettings(optimizer = false) {
  selectSettingsTab(optimizer);
  const dialog = $('#settingsDialog');
  if (!dialog.open) dialog.showModal();
}
$('#settingsButton').addEventListener('click', () => openSettings());
$('#imageSettingsTab').addEventListener('click', () => selectSettingsTab(false));
$('#optimizerSettingsTab').addEventListener('click', () => selectSettingsTab(true));
document.querySelector('.settings-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const optimizer = event.key === 'End' || (event.key !== 'Home' && $('#optimizerSettingsTab').getAttribute('aria-selected') !== 'true');
  selectSettingsTab(optimizer);
  $(optimizer ? '#optimizerSettingsTab' : '#imageSettingsTab').focus();
});
$('#closeSettings').addEventListener('click', () => $('#settingsDialog').close());
$('#settingsDialog').addEventListener('click', event => {
  if (event.target !== $('#settingsDialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
function openPreview(src, prompt) {
  $('#previewImage').src = src;
  $('#previewPrompt').textContent = prompt || '';
  $('#previewDialog').showModal();
}
function closeOptimizationReview(decision = 'keep') {
  const dialog = $('#optimizationDialog');
  const pending = pendingOptimization;
  pendingOptimization = null;
  if (dialog.open) dialog.close();
  if (!pending) return;
  if (decision === 'accept') {
    if (promptInput.value !== pending.original) {
      setOptimizerStatus('主提示词在确认期间已修改，未采用这次优化结果。', 'error');
      return;
    }
    promptBeforeOptimization = pending.original;
    promptInput.value = pending.optimized;
    updateCounter();
    $('#undoOptimize').hidden = false;
    setOptimizerStatus('已采用优化结果，可继续编辑、撤销，或点击“生成图片”。', 'success');
    return;
  }
  setOptimizerStatus('已保留原提示词。');
}
function openOptimizationReview(original, optimized, strength) {
  pendingOptimization = { original, optimized };
  $('#originalPromptPreview').value = original;
  $('#optimizedPromptPreview').value = optimized;
  $('#optimizationStrengthSummary').textContent = '本次优化强度：' + optimizationStrengthLabels[strength];
  $('#optimizationReviewStatus').textContent = '确认采用后仍可撤销。';
  $('#optimizationReviewStatus').dataset.type = 'info';
  $('#optimizationDialog').showModal();
  $('#optimizedPromptPreview').focus();
}
$('#closeOptimization').addEventListener('click', () => closeOptimizationReview('keep'));
$('#keepOriginalPrompt').addEventListener('click', () => closeOptimizationReview('keep'));
$('#acceptOptimizedPrompt').addEventListener('click', () => {
  if (!pendingOptimization) return;
  const optimized = $('#optimizedPromptPreview').value.trim();
  if (!optimized || $('#optimizedPromptPreview').value.length > 10000) {
    $('#optimizationReviewStatus').textContent = '优化结果不能为空且最多 10000 个字符。';
    $('#optimizationReviewStatus').dataset.type = 'error';
    $('#optimizedPromptPreview').focus();
    return;
  }
  pendingOptimization.optimized = optimized;
  closeOptimizationReview('accept');
});
$('#optimizationDialog').addEventListener('cancel', event => {
  event.preventDefault();
  closeOptimizationReview('keep');
});
$('#optimizationDialog').addEventListener('close', () => {
  // Also clear a pending review if the native dialog is closed directly.
  if (!$('#optimizationDialog').open && pendingOptimization) closeOptimizationReview('keep');
});
async function downloadImage(src, button) {
  button.disabled = true;
  try {
    let blob;
    if (src.startsWith('data:')) {
      const [meta, encoded] = src.split(',');
      const binary = atob(encoded.replace(/[\r\n]/g, ''));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      blob = new Blob([bytes], { type: meta.match(/data:([^;]+)/)[1] });
    } else {
      const response = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: src })
      });
      if (!response.ok) {
        let message = '下载失败';
        try { message = (await response.json()).error || message; } catch { /* Generic error is sufficient. */ }
        throw new Error(message);
      }
      blob = await response.blob();
    }
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1] || 'png';
    link.href = objectUrl;
    link.download = 'prompt-studio-' + Date.now() + '.' + extension;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  } catch (error) {
    setStatus(error.message || '下载失败，请尝试打开大图后保存', 'error');
  } finally { button.disabled = false; }
}
function createImage(src, description) {
  const image = document.createElement('img');
  image.src = src;
  image.alt = description || '生成的图片';
  image.loading = 'lazy';
  image.tabIndex = 0;
  image.referrerPolicy = 'no-referrer';
  const preview = () => openPreview(src, description);
  image.addEventListener('click', preview);
  image.addEventListener('keydown', event => { if (event.key === 'Enter') preview(); });
  image.addEventListener('error', () => {
    image.classList.add('image-load-error');
    image.alt = '图片加载失败，链接可能已过期。可尝试下载。';
  });
  return image;
}
function createDownload(src) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'download-link';
  button.textContent = '下载 ↗';
  button.addEventListener('click', () => downloadImage(src, button));
  return button;
}
function renderResults(images, prompt) {
  const grid = document.createElement('div');
  grid.className = 'result-grid';
  images.forEach((image, index) => {
    const src = imageSource(image);
    if (!src) return;
    const card = document.createElement('article');
    card.className = 'result-card';
    const imageEl = createImage(src, image.revised_prompt || prompt);
    imageEl.className = 'result-image';
    const actions = document.createElement('div');
    actions.className = 'result-actions';
    const label = document.createElement('span');
    label.textContent = 'IMAGE ' + String(index + 1).padStart(2, '0');
    actions.append(label, createDownload(src));
    card.append(imageEl, actions);
    if (image.revised_prompt) {
      const revised = document.createElement('p');
      revised.className = 'revised-prompt';
      revised.textContent = '优化后的提示词：' + image.revised_prompt;
      card.appendChild(revised);
    }
    grid.appendChild(card);
  });
  resultArea.replaceChildren(grid);
}
// IndexedDB stores large image files without the small localStorage quota.
let databasePromise;
function openDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('prompt-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('历史存储被其他页面占用'));
  });
  return databasePromise;
}
async function historyStore(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    let result;
    try { result = operation(tx.objectStore('images')); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('存储操作已取消'));
  });
}
async function readHistory() {
  try {
    const saved = await historyStore('readonly', store => store.getAll());
    return [...saved.map(item => ({ ...item, persisted: true })), ...memoryHistory].sort((a, b) => b.created - a.created).slice(0, 8);
  } catch { return memoryHistory.slice(0, 8); }
}
function updateHistoryDeletion() {
  historyGrid.querySelectorAll('.history-delete').forEach(button => {
    button.disabled = historyDeleting;
  });
}
function setHistoryStatus(message, type = '') {
  const status = $('#historyStatus');
  status.textContent = message;
  status.dataset.type = type;
  status.hidden = !message;
}
async function deleteHistoryItems(ids) {
  const persistedIds = ids.filter(id => displayedHistory.some(item => item.id === id && item.persisted));
  if (persistedIds.length) {
    await historyStore('readwrite', store => persistedIds.forEach(id => store.delete(id)));
  }
  for (let index = memoryHistory.length - 1; index >= 0; index--) {
    if (ids.includes(memoryHistory[index].id)) memoryHistory.splice(index, 1);
  }
}
async function renderHistory() {
  const items = (await readHistory()).filter(item => safeImageSource(item.src));
  displayedHistory = items;
  historyGrid.replaceChildren();
  $('#historySection').hidden = !items.length;
  items.forEach(item => {
    const src = safeImageSource(item.src);
    if (!src) return;
    const card = document.createElement('article');
    card.className = 'history-card';
    const caption = document.createElement('small');
    caption.textContent = item.prompt;
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const reuse = document.createElement('button');
    reuse.type = 'button';
    reuse.textContent = '复用提示词';
    reuse.addEventListener('click', () => {
      if (optimizing) return;
      promptInput.value = String(item.prompt || '').slice(0, 10000);
      promptBeforeOptimization = null;
      $('#undoOptimize').hidden = true;
      updateCounter();
      promptInput.focus();
      promptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'download-link history-delete';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除图片：${item.prompt || '生成图片'}`);
    remove.addEventListener('click', () => confirmHistoryDeletion(item.id));
    const imageActions = document.createElement('div');
    imageActions.className = 'history-image-actions';
    imageActions.append(remove, createDownload(src));
    actions.append(reuse, imageActions);
    card.append(createImage(src, item.prompt), caption, actions);
    historyGrid.appendChild(card);
  });
  updateHistoryDeletion();
}
async function addToHistory(images, prompt) {
  const items = images.map((image, index) => ({
    id: crypto.randomUUID(), src: imageSource(image), prompt, created: Date.now() + index
  })).filter(item => item.src);
  try {
    await historyStore('readwrite', store => items.forEach(item => store.put(item)));
    const all = await historyStore('readonly', store => store.getAll());
    const old = all.sort((a, b) => b.created - a.created).slice(8);
    if (old.length) await historyStore('readwrite', store => old.forEach(item => store.delete(item.id)));
  } catch {
    memoryHistory.unshift(...items);
    memoryHistory.splice(8);
    const notice = document.createElement('p');
    notice.className = 'storage-notice';
    notice.textContent = '浏览器无法持久保存历史，当前图片仅保留在本次会话，请及时下载。';
    resultArea.appendChild(notice);
  }
  await renderHistory();
}
function updateCounter() { $('#promptCounter').textContent = promptInput.value.length + ' / 10000'; }
function fillOptions(select, entries) {
  const previous = select.value;
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  if (entries.some(([value]) => value === previous)) select.value = previous;
}
function readCapabilityConfig() {
  if ($('#capabilityMode').value === 'auto') return { mode: 'auto' };
  const selected = id => [...$(id).querySelectorAll('input:checked')].map(input => input.value);
  return { mode: $('#capabilityMode').value, sizes: selected('#capabilitySizes'), qualities: selected('#capabilityQualities'), responseFormats: selected('#capabilityFormats'), maxCount: Number($('#capabilityMaxCount').value), maxReferences: Number($('#capabilityMaxReferences').value), imageField: $('#capabilityImageField').value };
}
function currentCapabilities() { return ModelCapabilities.resolve(settings.model.value, readCapabilityConfig()); }
function fillCapabilityEditor(capabilities) {
  for (const [id, key, allowed] of [['#capabilitySizes', 'sizes', ModelCapabilities.SIZES], ['#capabilityQualities', 'qualities', ModelCapabilities.QUALITIES], ['#capabilityFormats', 'responseFormats', ModelCapabilities.FORMATS]]) {
    $(id).replaceChildren(...allowed.map(value => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = value; input.checked = capabilities[key].includes(value);
      label.append(input, document.createTextNode(value));
      return label;
    }));
  }
  $('#capabilityMaxCount').value = String(capabilities.maxCount);
  $('#capabilityMaxReferences').value = String(capabilities.maxReferences);
  $('#capabilityImageField').value = capabilities.imageField;
}
function refreshModelOptions() {
  const capabilities = currentCapabilities();
  const custom = $('#capabilityMode').value === 'custom';
  $('#customCapabilities').hidden = !custom;
  $('#customCapabilities').disabled = !custom;
  const sizeLabels = { auto: '自动', '1024x1024': '1 : 1 · 1024×1024', '1536x1024': '横版 · 1536×1024', '1024x1536': '竖版 · 1024×1536', '1792x1024': '横版 · 1792×1024', '1024x1792': '竖版 · 1024×1792' };
  const qualityLabels = { auto: '自动', low: '低', medium: '中', high: '高', standard: '标准', hd: '高清 HD' };
  fillOptions($('#size'), [['default', '由接口决定'], ...capabilities.sizes.map(value => [value, sizeLabels[value] || value])]);
  fillOptions($('#quality'), [['default', '由接口决定'], ...capabilities.qualities.map(value => [value, qualityLabels[value]])]);
  fillOptions($('#count'), Array.from({ length: capabilities.maxCount }, (_, index) => [String(index + 1), (index + 1) + ' 张']));
  fillOptions($('#responseFormat'), [['auto', '自动 · 使用接口默认值'], ...capabilities.responseFormats.map(value => [value, value === 'url' ? '图片链接 · url' : 'Base64 · b64_json'])]);
  $('#size').disabled = !capabilities.sizes.length;
  $('#quality').disabled = !capabilities.qualities.length;
  $('#count').disabled = capabilities.maxCount === 1;
  $('#responseFormat').disabled = !capabilities.responseFormats.length;
  $('#capabilityImageField').disabled = capabilities.maxReferences === 0;
  $('#capabilitySummary').textContent = '当前：最多生成 ' + capabilities.maxCount + ' 张；' + (capabilities.maxReferences ? '参考图最多 ' + capabilities.maxReferences + ' 张' : '不支持参考图') + '。尺寸、画质及返回格式均可使用接口默认值。';
  updateActionState();
  updateReferences();
}
promptInput.addEventListener('input', () => {
  updateCounter();
  promptBeforeOptimization = null;
  $('#undoOptimize').hidden = true;
});
promptInput.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!generating) $('#generateForm').requestSubmit();
  }
});
$('#addReference').addEventListener('click', () => $('#referenceInput').click());
$('#referenceInput').addEventListener('change', event => { addReferenceFiles(event.target.files); event.target.value = ''; });
const composer = document.querySelector('.composer-panel');
['dragenter', 'dragover'].forEach(type => composer.addEventListener(type, event => { event.preventDefault(); composer.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach(type => composer.addEventListener(type, event => { event.preventDefault(); composer.classList.remove('drag-over'); }));
composer.addEventListener('drop', event => addReferenceFiles(event.dataTransfer.files));
promptInput.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
  if (files.length) { event.preventDefault(); addReferenceFiles(files); }
});
$('#revealKey').addEventListener('click', () => {
  const reveal = settings.apiKey.type === 'password';
  settings.apiKey.type = reveal ? 'text' : 'password';
  $('#revealKey').setAttribute('aria-label', reveal ? '隐藏 API Key' : '显示 API Key');
});
$('#imagePreset').addEventListener('change', event => {
  if (event.target.value) applyImagePreset(event.target.value);
  else { activePresets.image = ''; settings.apiKey.value = ''; presetNameInput('image').value = ''; saveSettings(); refreshPresetList('image'); setStatus('已取消预设选择，当前配置保留，请重新填写 API Key。'); }
});
$('#saveImagePreset').addEventListener('click', () => savePreset('image'));
$('#deleteImagePreset').addEventListener('click', () => deletePreset('image'));
$('#optimizerPreset').addEventListener('change', event => {
  if (event.target.value) applyOptimizerPreset(event.target.value);
  else { activePresets.optimizer = ''; optimizerSettings.apiKey.value = ''; presetNameInput('optimizer').value = ''; saveOptimizerSettings(); refreshPresetList('optimizer'); setOptimizerStatus('已取消预设选择，当前配置保留，请重新填写优化 API Key。'); }
});
$('#saveOptimizerPreset').addEventListener('click', () => savePreset('optimizer'));
$('#deleteOptimizerPreset').addEventListener('click', () => deletePreset('optimizer'));
for (const kind of ['image', 'optimizer']) presetNameInput(kind).addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); savePreset(kind); }
});
for (const kind of ['image', 'optimizer']) presetNameInput(kind).setAttribute('aria-label', kind === 'image' ? '图片生成预设名称' : '提示词优化预设名称');
document.querySelectorAll('[data-model]').forEach(button => button.addEventListener('click', () => {
  settings.model.value = button.dataset.model;
  refreshModelOptions();
  saveSettings();
}));
settings.apiUrl.addEventListener('change', saveSettings);
settings.apiKey.addEventListener('input', saveSettings);
settings.model.addEventListener('change', saveSettings);
settings.model.addEventListener('input', refreshModelOptions);
for (const selector of ['#size', '#quality', '#count', '#responseFormat']) $(selector).addEventListener('change', saveSettings);
$('#settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  saveSettings();
  $('#settingsDialog').close();
  setStatus('设置已就绪，输入提示词即可开始生成。API Key 仅保留在当前页面。');
  promptInput.focus();
});
$('#clearButton').addEventListener('click', () => {
  settings.apiKey.value = '';
  safeSessionStorage.remove(sessionStorageKeys.imageApiKey);
  setStatus('已清除本次填写的 API Key。');
});
$('#testButton').addEventListener('click', async () => {
  const config = getConfig();
  if (!config) return;
  const button = $('#testButton');
  button.disabled = true;
  setStatus('正在请求模型列表验证鉴权，不会生成图片。');
  try {
    const data = await apiRequest('/api/test', config);
    setStatus(data.message, data.found ? 'success' : 'info');
  } catch (error) {
    setStatus(formatRequestError(error) + ' 若服务不支持模型列表，可直接生成验证。', 'error');
  } finally { button.disabled = false; }
});
function getOptimizerConfig() {
  const form = $('#optimizerSettingsForm');
  const fields = Object.values(optimizerSettings);
  if (!fields.every(field => field.value.trim()) || !form.checkValidity()) {
    openSettings(true);
    setOptimizerStatus('请单独填写提示词优化 API 的 URL、Key 和文本模型。', 'error');
    const invalid = fields.find(field => !field.value.trim() || !field.checkValidity());
    invalid?.focus();
    form.reportValidity();
    return null;
  }
  return Object.fromEntries(Object.entries(optimizerSettings).map(([key, field]) => [key, field.value.trim()]));
}
optimizerSettings.apiUrl.addEventListener('change', saveOptimizerSettings);
optimizerSettings.apiKey.addEventListener('input', saveOptimizerSettings);
optimizerSettings.model.addEventListener('change', saveOptimizerSettings);
$('#optimizerSettingsForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!getOptimizerConfig()) return;
  saveOptimizerSettings();
  $('#settingsDialog').close();
  setOptimizerStatus('优化接口设置已就绪。点击“优化提示词”才会调用它。');
  promptInput.focus();
});
$('#revealOptimizerKey').addEventListener('click', () => {
  const reveal = optimizerSettings.apiKey.type === 'password';
  optimizerSettings.apiKey.type = reveal ? 'text' : 'password';
  $('#revealOptimizerKey').setAttribute('aria-label', reveal ? '隐藏优化 API Key' : '显示优化 API Key');
});
$('#clearOptimizerKey').addEventListener('click', () => {
  optimizerSettings.apiKey.value = '';
  safeSessionStorage.remove(sessionStorageKeys.optimizerApiKey);
  setOptimizerStatus('已清除优化服务的 API Key。');
});
$('#testOptimizer').addEventListener('click', async () => {
  const config = getOptimizerConfig();
  if (!config) return;
  const button = $('#testOptimizer');
  button.disabled = true;
  setOptimizerStatus('正在验证优化服务鉴权，不会改写提示词。');
  try {
    const data = await apiRequest('/api/optimizer/test', config);
    setOptimizerStatus(data.message, data.found ? 'success' : 'info');
  } catch (error) { setOptimizerStatus(formatRequestError(error), 'error'); }
  finally { button.disabled = false; }
});
$('#optimizeButton').addEventListener('click', async () => {
  if (generating || optimizing || loadingReferences) return;
  const original = promptInput.value;
  if (!original.trim()) {
    setOptimizerStatus('请先输入需要优化的提示词。', 'error');
    promptInput.focus();
    return;
  }
  const config = getOptimizerConfig();
  if (!config) return;
  const strength = optimizationStrength.value;
  if (!Object.hasOwn(optimizationStrengthLabels, strength)) {
    setOptimizerStatus('请选择有效的提示词优化强度。', 'error');
    optimizationStrength.focus();
    return;
  }
  safeStorage.set('prompt-studio-optimization-strength', strength);
  saveOptimizerSettings();
  const task = beginTask('optimize');
  setOptimizerStatus('正在使用独立的文本模型优化提示词，最多等待 5 分钟。');
  try {
    const data = await apiRequest('/api/optimize', {
      ...config, prompt: original, strength, referenceCount: referenceImages.length,
      referenceGuidance: referenceImages.map(({ purpose, customPurpose, preserve, change }) => ({ purpose, customPurpose, preserve, change })),
      canvasSize: $('#size').value, imageCount: Number($('#count').value)
    }, task.controller.signal);
    if (!taskIsCurrent(task)) return;
    if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 10000) throw new Error('优化结果无效，原提示词已保留。');
    // Protect edits made by another UI action while a request is pending.
    if (promptInput.value !== original) throw new Error('提示词在请求期间已修改，请重新点击优化。当前内容已保留。');
    openOptimizationReview(original, data.prompt, strength);
    setOptimizerStatus('优化完成，请在弹窗中比较并确认是否采用。', 'success');
  } catch (error) { reportTaskError(task, error); }
  finally { finishTask(task); }
});
$('#undoOptimize').addEventListener('click', () => {
  if (generating || optimizing || loadingReferences || promptBeforeOptimization === null) return;
  promptInput.value = promptBeforeOptimization;
  promptBeforeOptimization = null;
  $('#undoOptimize').hidden = true;
  updateCounter();
  setOptimizerStatus('已恢复优化前的提示词。');
});
$('#generateForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (generating || optimizing || loadingReferences) return;
  const config = getConfig();
  if (!config) return;
  const prompt = promptInput.value.trim();
  if (!prompt) { promptInput.focus(); return; }
  const capabilities = ModelCapabilities.resolve(config.model, config.capabilities);
  if (referenceImages.length > capabilities.maxReferences) {
    setStatus(capabilities.maxReferences ? '已上传参考图超过当前配置的 ' + capabilities.maxReferences + ' 张上限，请移除多余图片。' : '当前模型能力不支持参考图。请调整配置，或移除参考图继续文生图。', 'error');
    return;
  }
  saveSettings();
  const task = beginTask('generate');
  setStatus('正在调用生图服务，请保持页面开启。最多等待 5 分钟。');
  $('#galleryScroll').scrollTop = 0;
  try {
    const data = await apiRequest('/api/generate', {
      ...config, prompt, size: $('#size').value, quality: $('#quality').value,
      responseFormat: $('#responseFormat').value, n: Number($('#count').value),
      references: referenceImages.map(({ mime, b64_json, purpose, customPurpose, preserve, change }) => ({ mime, b64_json, purpose, customPurpose, preserve, change }))
    }, task.controller.signal);
    if (!taskIsCurrent(task)) return;
    if (!data.images?.length || !data.images.every(image => imageSource(image))) throw new Error('接口没有返回有效的图片');
    renderResults(data.images, prompt);
    setStatus('生成完成，共 ' + data.images.length + ' 张图片。', 'success');
    historyQueue = historyQueue.then(() => addToHistory(data.images, prompt)).catch(() => {});
  } catch (error) { reportTaskError(task, error); }
  finally { finishTask(task); }
});
let pendingHistoryDeletion = null;
function confirmHistoryDeletion(id) {
  const dialog = $('#deleteHistoryDialog');
  if (historyDeleting || dialog.open) return;
  pendingHistoryDeletion = id;
  dialog.returnValue = 'cancel';
  dialog.showModal();
}
$('#deleteHistoryDialog').addEventListener('close', event => {
  const id = pendingHistoryDeletion;
  pendingHistoryDeletion = null;
  if (event.target.returnValue === 'delete' && id !== null) queueHistoryDeletion(id);
});
function queueHistoryDeletion(id) {
  if (historyDeleting) return;
  historyDeleting = true;
  setHistoryStatus('正在删除…');
  updateHistoryDeletion();
  historyQueue = historyQueue.then(async () => {
    await deleteHistoryItems([id]);
    await renderHistory();
    setHistoryStatus('已删除图片。');
  }).catch(() => {
    setHistoryStatus('删除失败，请检查浏览器存储权限后重试。', 'error');
  }).finally(() => {
    historyDeleting = false;
    updateHistoryDeletion();
  });
}
$('#closePreview').addEventListener('click', () => $('#previewDialog').close());
$('#previewDialog').addEventListener('click', event => {
  if (event.target === $('#previewDialog')) event.target.close();
});
const templateCategories = [{ id: 'all', label: '全部风格' }, ...[...new Map(StyleTemplates.map(template => [template.category, template.categoryLabel])).entries()].map(([id, label]) => ({ id, label }))];
let activeTemplateCategory = 'all';
let activeTemplate = null;
const routeTitles = {
  create: '单图创作 · Prompt Studio',
  series: '系列策划 · Prompt Studio',
  styles: '风格库 · Prompt Studio',
  gallery: '展馆 · Prompt Studio'
};
function currentRoute() {
  const route = window.location.hash.slice(1);
  return Object.hasOwn(routeTitles, route) ? route : 'create';
}
function renderRoute() {
  const route = currentRoute();
  document.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== route; });
  document.querySelectorAll('.site-nav-link').forEach(link => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = routeTitles[route];
  if (route === 'styles') { renderTemplateFilters(); renderTemplates(); }
  window.scrollTo(0, 0);
}
function navigateTo(route) {
  if (!Object.hasOwn(routeTitles, route)) return;
  if (currentRoute() === route) renderRoute();
  else window.location.hash = route;
}
window.addEventListener('hashchange', renderRoute);
function renderTemplateFilters() {
  const filters = $('#templateFilters');
  filters.replaceChildren(...templateCategories.map(category => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'template-filter';
    button.textContent = category.label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(activeTemplateCategory === category.id));
    button.addEventListener('click', () => { activeTemplateCategory = category.id; renderTemplateFilters(); renderTemplates(); });
    return button;
  }));
}
function templateMatches(template, search, category) {
  if (category !== 'all' && template.category !== category) return false;
  if (!search) return true;
  return [template.title, template.categoryLabel, template.description, template.prompt].join(' ').toLowerCase().includes(search.toLowerCase());
}
function templateImage(template) {
  const image = document.createElement('img');
  image.src = template.image;
  image.alt = template.title + '风格参考图';
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => image.classList.add('image-load-error'));
  return image;
}
function renderTemplates() {
  const search = $('#templateSearch').value.trim();
  const templates = StyleTemplates.filter(template => templateMatches(template, search, activeTemplateCategory));
  $('#templatesCount').textContent = '共 ' + templates.length + ' 个模板';
  $('#templateEmpty').hidden = templates.length > 0;
  const grid = $('#templateGrid');
  grid.replaceChildren(...templates.map(template => {
    const card = document.createElement('article');
    card.className = 'template-card';
    const imageWrap = document.createElement('button');
    imageWrap.type = 'button';
    imageWrap.className = 'template-image-wrap';
    imageWrap.setAttribute('aria-label', '查看“' + template.title + '”模板详情');
    const accents = { cinematic: '#382c52', editorial: '#d9bac2', illustration: '#b3c7a3', '3d': '#d5b7a7', architecture: '#a9b8bd', nature: '#a4bc98', product: '#e2cbb7', graphic: '#d49764', portrait: '#d5b7a8' };
    imageWrap.style.setProperty('--template-accent', accents[template.category] || '#c0b4dd');
    imageWrap.append(templateImage(template));
    const category = document.createElement('span');
    category.className = 'template-card-category';
    category.textContent = template.categoryLabel;
    imageWrap.append(category);
    imageWrap.addEventListener('click', () => openTemplateDialog(template));
    const body = document.createElement('div');
    body.className = 'template-card-body';
    const title = document.createElement('h2');
    title.textContent = template.title;
    const description = document.createElement('p');
    description.textContent = template.description;
    const actions = document.createElement('div');
    actions.className = 'template-card-actions';
    const details = document.createElement('button');
    details.type = 'button';
    details.textContent = '查看提示词';
    details.addEventListener('click', () => openTemplateDialog(template));
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'template-use';
    use.textContent = '使用模板';
    use.addEventListener('click', () => useTemplate(template));
    actions.append(details, use);
    body.append(title, description, actions);
    card.append(imageWrap, body);
    return card;
  }));
}
function openTemplateDialog(template) {
  activeTemplate = template;
  $('#templatePromptImage').src = template.image;
  $('#templatePromptImage').alt = template.title + '风格参考图';
  $('#templatePromptCategory').textContent = template.categoryLabel;
  $('#templatePromptTitle').textContent = template.title;
  $('#templatePromptDescription').textContent = template.description;
  $('#templatePromptText').textContent = template.prompt;
  $('#templatePromptDialog').showModal();
}
function useTemplate(template) {
  $('#templatePromptDialog').open && $('#templatePromptDialog').close();
  promptInput.value = template.prompt;
  promptBeforeOptimization = null;
  $('#undoOptimize').hidden = true;
  updateCounter();
  setStatus('已载入“' + template.title + '”提示词模板，可继续修改后生成。', 'success');
  navigateTo('create');
  requestAnimationFrame(() => promptInput.focus());
}
$('#templateSearch').addEventListener('input', renderTemplates);
$('#closeTemplatePrompt').addEventListener('click', () => $('#templatePromptDialog').close());
$('#templatePromptDialog').addEventListener('click', event => { if (event.target === $('#templatePromptDialog')) event.target.close(); });
$('#useTemplateFromDialog').addEventListener('click', () => { if (activeTemplate) useTemplate(activeTemplate); });
function applyTheme(dark) {
  document.body.classList.toggle('dark-theme', dark);
  $('#themeButton').setAttribute('aria-pressed', String(dark));
  $('#themeButton').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
}
$('#themeButton').addEventListener('click', () => {
  const dark = !document.body.classList.contains('dark-theme');
  applyTheme(dark);
  safeStorage.set('prompt-studio-theme', dark ? 'dark' : 'light');
});
settings.apiUrl.value = safeStorage.get('prompt-studio-url') || 'https://api.openai.com/v1';
settings.apiKey.value = safeSessionStorage.get(sessionStorageKeys.imageApiKey) || '';
settings.model.value = safeStorage.get('prompt-studio-model') || 'gpt-image-1';
optimizerSettings.apiUrl.value = safeStorage.get('prompt-studio-optimizer-url') || '';
optimizerSettings.apiKey.value = safeSessionStorage.get(sessionStorageKeys.optimizerApiKey) || '';
optimizerSettings.model.value = safeStorage.get('prompt-studio-optimizer-model') || '';
activePresets.image = safeStorage.get('prompt-studio-active-image-preset') || '';
activePresets.optimizer = safeStorage.get('prompt-studio-active-optimizer-preset') || '';
const savedOptimizationStrength = safeStorage.get('prompt-studio-optimization-strength');
optimizationStrength.value = Object.hasOwn(optimizationStrengthLabels, savedOptimizationStrength) ? savedOptimizationStrength : 'standard';
optimizationStrength.addEventListener('change', () => {
  if (Object.hasOwn(optimizationStrengthLabels, optimizationStrength.value)) safeStorage.set('prompt-studio-optimization-strength', optimizationStrength.value);
});
fillCapabilityEditor(ModelCapabilities.resolve(settings.model.value));
try {
  const stored = safeStorage.get('prompt-studio-capabilities');
  if (stored) {
    const config = JSON.parse(stored);
    const capabilities = ModelCapabilities.resolve(settings.model.value, config);
    $('#capabilityMode').value = config.mode || 'auto';
    if (config.mode === 'custom') { fillCapabilityEditor(capabilities); customCapabilitiesInitialized = true; }
  }
} catch { setStatus('保存的模型能力无效，已恢复自动识别，请检查设置。'); }
$('#capabilityMode').addEventListener('change', () => {
  if ($('#capabilityMode').value === 'custom' && !customCapabilitiesInitialized) {
    fillCapabilityEditor(ModelCapabilities.resolve(settings.model.value));
    customCapabilitiesInitialized = true;
  }
  refreshModelOptions(); saveSettings();
});
$('#customCapabilities').addEventListener('change', () => { refreshModelOptions(); saveSettings(); });
refreshModelOptions();
refreshPresetList('image');
refreshPresetList('optimizer');
try {
  const defaults = JSON.parse(safeStorage.get('prompt-studio-image-defaults') || '{}');
  setSelectIfAvailable('#size', defaults.size);
  setSelectIfAvailable('#quality', defaults.quality);
  setSelectIfAvailable('#count', defaults.count, '1');
  setSelectIfAvailable('#responseFormat', defaults.responseFormat, 'auto');
} catch { /* Invalid stored defaults fall back to the available options. */ }
for (const kind of ['image', 'optimizer']) {
  activePresets[kind] = presetSelect(kind).value;
  presetNameInput(kind).value = activePresets[kind];
}
updateActionState();
applyTheme(safeStorage.get('prompt-studio-theme') === 'dark');
renderRoute();
renderHistory();
fetch('/api/health').then(response => {
  if (!response.ok) throw new Error('服务未就绪');
  $('#connectionText').textContent = '本地服务已连接';
}).catch(() => {
  $('#connectionText').textContent = '本地服务未连接';
  setStatus('请先运行 npm start，再通过 http://localhost:3000 访问页面。', 'error');
});
