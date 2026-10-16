'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildOptimizationInstructions } = require('./prompt-optimizer');
const generationRequirements = require('./public/generation-requirements');
const { resolve: resolveCapabilities, supportsSize, isCustomSize } = require('./public/model-capabilities');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_RESPONSE = 80 * 1024 * 1024;
const MAX_REFERENCE_SIZE = 10 * 1024 * 1024;
const MAX_REFERENCE_TOTAL = 20 * 1024 * 1024;
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
class ApiError extends Error {
  constructor(message, status = 400, diagnostic = null) { super(message); this.status = status; this.diagnostic = diagnostic; }
}
function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, maxSize = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxSize) {
        oversized = true;
        chunks = [];
        reject(new ApiError('请求内容过大，请减少参考图片数量或压缩图片', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new ApiError('请求 JSON 格式无效')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new ApiError('上传请求已中断')));
  });
}
function parseHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new ApiError('请输入有效 URL（包含 https:// 或 http://）'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError('URL 只支持 http / https，且不能包含账号或密码');
  url.hash = '';
  return url;
}
function generationEndpoint(value) {
  const url = parseHttpUrl(value);
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/images\/(generations|edits)$/.test(pathname) ? pathname.replace(/\/edits$/, '/generations') : pathname + '/images/generations';
  return url;
}
function chatEndpoint(value) {
  const url = parseHttpUrl(value);
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/chat/completions') ? pathname : pathname + '/chat/completions';
  return url;
}
function getConfig(body, endpointParser = generationEndpoint) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('请求必须是 JSON 对象');
  const endpoint = endpointParser(body.apiUrl);
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || '').trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new ApiError('请填写有效的 API Key');
  if (!model || model.length > 200) throw new ApiError('请填写有效的模型名称（model）');
  return { endpoint, apiKey, model };
}
async function limitedBuffer(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new ApiError('接口返回的数据超过 80 MB，请减少生成数量', 502);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE) throw new ApiError('接口返回的数据超过 80 MB，请减少生成数量', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sanitizeUpstreamDetail(value, apiKey) {
  if (typeof value !== 'string') return '';
  return value.replaceAll(apiKey, '[已隐藏密钥]').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}
function upstreamDiagnostic(status, data, detail, endpoint, apiKey) {
  const errorObject = data?.error && typeof data.error === 'object' ? data.error : {};
  const code = typeof errorObject.code === 'string' ? errorObject.code : typeof data?.code === 'string' ? data.code : '';
  const type = typeof errorObject.type === 'string' ? errorObject.type : '';
  const raw = sanitizeUpstreamDetail(detail || errorObject.message || data?.message || '', apiKey);
  const haystack = (code + ' ' + type + ' ' + raw).toLowerCase();
  let category = 'provider';
  let label = '服务商错误';
  let suggestion = '检查供应商状态、接口地址和模型文档后再手动重试。';
  if (status === 401 || /invalid[_ -]?api[_ -]?key|authentication|unauthorized/.test(haystack)) {
    category = 'auth'; label = '鉴权失败'; suggestion = '重新填写 API Key，并确认该 Key 属于当前 API 地址。';
  } else if (status === 403 || /permission|forbidden|access denied|not allowed/.test(haystack)) {
    category = 'permission'; label = '权限不足'; suggestion = '确认账号有权使用该模型和图片接口，必要时联系供应商开通权限。';
  } else if (status === 404 || /model[_ -]?not[_ -]?found|unknown[_ -]?model|not found/.test(haystack)) {
    category = endpoint.pathname.endsWith('/images/edits') ? 'reference' : 'model';
    label = category === 'reference' ? '参考图接口不可用' : '模型或接口不存在';
    suggestion = category === 'reference' ? '确认服务支持 /images/edits 和当前模型；不支持时移除参考图或改用兼容服务。' : '检查模型名称和 API URL，确认服务提供对应端点。';
  } else if (status === 408 || status === 504 || /timeout|timed out/.test(haystack)) {
    category = 'timeout'; label = '服务响应超时'; suggestion = '检查网络和供应商状态，稍后手动重试；不要连续重复提交生图请求。';
  } else if (status === 429 || /rate[_ -]?limit|too many requests|quota|credit|billing|insufficient/.test(haystack)) {
    category = /quota|credit|billing|insufficient/.test(haystack) ? 'quota' : 'rate_limit';
    label = category === 'quota' ? '额度或计费受限' : '请求过于频繁';
    suggestion = category === 'quota' ? '检查余额、项目额度和计费状态；429 不一定表示余额不足。' : '降低请求频率，等待限流窗口结束后再手动重试。';
  } else if (status === 400 || status === 422) {
    const referenceRequest = endpoint.pathname.endsWith('/images/edits') || /image|reference|file|multipart|edit/.test(haystack);
    category = referenceRequest ? 'reference' : 'parameter';
    label = referenceRequest ? '参考图参数错误' : '请求参数错误';
    suggestion = referenceRequest ? '确认图片格式、数量、上传字段和模型的参考图能力。' : '检查模型、尺寸、画质、返回格式和提示词参数是否符合供应商文档。';
  } else if (status >= 500) {
    category = 'provider'; label = '服务商暂时不可用'; suggestion = '检查供应商状态，稍后手动重试；生图请求不会自动重试。';
  }
  return { category, label, suggestion, detail: raw || '供应商未提供可读的错误信息。', status, code: code || undefined };
}
async function upstreamJson(url, apiKey, body, signal) {
  const multipart = body instanceof FormData;
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + apiKey, ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: signal || AbortSignal.timeout(300000)
    });
  } catch (error) {
    if (signal?.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    const detail = sanitizeUpstreamDetail(error.message, apiKey);
    throw new ApiError('无法连接上游 API', 502, { category: 'network', label: '网络连接失败', suggestion: '检查 API URL、网络、代理和 HTTPS 证书后再手动重试。', detail: detail || '请求未能建立。', status: 502 });
  }
  const raw = (await limitedBuffer(response)).toString();
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!response.ok) {
    const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
    const diagnostic = upstreamDiagnostic(response.status, data, detail, new URL(url), apiKey);
    throw new ApiError(diagnostic.detail, response.status >= 400 && response.status < 600 ? response.status : 502, diagnostic);
  }
  if (!data) throw new ApiError('接口返回的不是 JSON，请检查 API 地址是否正确', 502, { category: 'provider', label: '接口格式错误', suggestion: '确认 API URL 指向 OpenAI 兼容接口，而不是网页地址。', detail: '响应不是有效 JSON。', status: 502 });
  return data;
}
function referenceImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new ApiError('最多添加 4 张参考图片');
  let total = 0;
  return value.map((item, index) => {
    if (!item || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mime)) throw new ApiError('参考图仅支持 PNG、JPEG、WebP');
    const encoded = item.b64_json;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_REFERENCE_SIZE / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ApiError('参考图片编码无效或单张超过 10 MB');
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > MAX_REFERENCE_SIZE) throw new ApiError('单张参考图片最多 10 MB');
    total += buffer.length;
    if (total > MAX_REFERENCE_TOTAL) throw new ApiError('参考图片总大小最多 20 MB');
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!(item.mime === 'image/png' && png || item.mime === 'image/jpeg' && jpeg || item.mime === 'image/webp' && webp)) throw new ApiError('参考图片内容与文件格式不符，请上传真实图片');
    const extension = item.mime === 'image/jpeg' ? 'jpg' : item.mime.split('/')[1];
    const guidance = referenceGuidance(item, index);
    return { buffer, mime: item.mime, name: 'reference-' + (index + 1) + '.' + extension, guidance };
  });
}
const REFERENCE_PURPOSES = { person: '人物', composition: '构图', style: '风格', product: '产品外观', custom: '自定义' };
function referenceGuidance(item, index) {
  const purpose = item.purpose === undefined ? '' : String(item.purpose);
  if (purpose && !Object.hasOwn(REFERENCE_PURPOSES, purpose)) throw new ApiError('参考图 ' + (index + 1) + ' 的用途无效');
  const customPurpose = String(item.customPurpose || '').trim();
  if (customPurpose.length > 80 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(customPurpose)) throw new ApiError('参考图 ' + (index + 1) + ' 的自定义用途无效');
  if (purpose === 'custom' && !customPurpose) throw new ApiError('请填写参考图 ' + (index + 1) + ' 的自定义用途');
  const preserve = String(item.preserve || '').trim();
  const change = String(item.change || '').trim();
  if (preserve.length > 500 || change.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(preserve + change)) throw new ApiError('参考图 ' + (index + 1) + ' 的说明过长或包含无效字符');
  if (!purpose && !customPurpose && !preserve && !change) return null;
  return { purpose: purpose === 'custom' ? '' : (REFERENCE_PURPOSES[purpose] || ''), customPurpose, preserve, change };
}
function formatReferenceGuidance(guidance) {
  if (!Array.isArray(guidance)) return '';
  const lines = guidance.map((item, index) => {
    if (!item) return '';
    const purpose = item.purpose || item.customPurpose || '未指定';
    const parts = ['参考图' + (index + 1) + '（用途：' + purpose + '）'];
    if (item.preserve) parts.push('需要保留：' + item.preserve);
    if (item.change) parts.push('需要修改：' + item.change);
    return parts.join('，');
  }).filter(Boolean);
  return lines.length ? '\n\n参考图使用说明（按编号对应上传图片）：\n' + lines.join('\n') : '';
}
function normalizeReferenceGuidance(value, count) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length !== count) throw new ApiError('参考图说明数量必须与参考图一致');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError('参考图 ' + (index + 1) + ' 的说明无效');
    const normalized = referenceGuidance(item, index);
    return normalized;
  });
}
async function generateImage(body, signal) {
  const { endpoint, apiKey, model } = getConfig(body);
  let capabilities;
  try { capabilities = resolveCapabilities(model, body.capabilities); }
  catch (error) { throw new ApiError(error.message); }
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 10000) throw new ApiError('提示词不能为空，且最多 10000 个字符');
  const n = Number(body.n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new ApiError('图片数量必须为 1–4');
  const references = referenceImages(body.references);
  if (references.length > capabilities.maxReferences) throw new ApiError(capabilities.maxReferences ? '当前能力配置最多支持 ' + capabilities.maxReferences + ' 张参考图' : '当前能力配置不支持参考图，请更换配置或移除参考图');
  if (n > capabilities.maxCount) throw new ApiError('当前能力配置每次最多生成 ' + capabilities.maxCount + ' 张图片');
  const requestBody = { model, n };
  if (body.size && body.size !== 'default') {
    if (!supportsSize(capabilities, body.size)) throw new ApiError('当前能力配置不支持所选图片尺寸，请使用由接口决定');
    requestBody.size = body.size;
  }
  if (body.quality && body.quality !== 'default') {
    if (!capabilities.qualities.includes(body.quality)) throw new ApiError('当前能力配置不支持所选画质，请使用由接口决定');
    requestBody.quality = body.quality;
  }
  const format = body.responseFormat || 'auto';
  if (!['auto', 'b64_json', 'url'].includes(format)) throw new ApiError('返回格式无效');
  if (format !== 'auto' && !capabilities.responseFormats.includes(format)) throw new ApiError('当前能力配置不支持所选返回格式，请使用自动');
  // GPT Image returns base64 and does not accept response_format.
  if (format !== 'auto') requestBody.response_format = format;
  requestBody.prompt = prompt + formatReferenceGuidance(references.map(reference => reference.guidance)) + generationRequirements({ size: body.size, quality: body.quality, n });
  if (requestBody.prompt.length > 10000) throw new ApiError('提示词、参考图说明和生成要求合计最多 10000 个字符，请缩短提示词');
  let data;
  if (references.length) {
    const editEndpoint = new URL(endpoint);
    editEndpoint.pathname = endpoint.pathname.replace(/\/images\/generations$/, '/images/edits');
    const form = new FormData();
    for (const [key, value] of Object.entries(requestBody)) form.append(key, String(value));
    const imageField = capabilities.imageField === 'auto' ? (references.length === 1 ? 'image' : 'image[]') : capabilities.imageField;
    for (const reference of references) form.append(imageField, new Blob([reference.buffer], { type: reference.mime }), reference.name);
    try { data = await upstreamJson(editEndpoint, apiKey, form, signal); }
    catch (error) {
      if ([404, 405].includes(error.status)) throw new ApiError('该服务未提供 /images/edits 图片编辑接口，请使用支持参考图的服务或移除参考图', error.status, error.diagnostic);
      throw error;
    }
  } else {
    data = await upstreamJson(endpoint, apiKey, requestBody, signal);
  }
  if (!Array.isArray(data.data)) throw new ApiError('未找到 data 图片数组，请确认接口兼容 OpenAI Images API', 502);
  const images = data.data.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    if (typeof item.b64_json === 'string' && item.b64_json.length) {
      if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(item.b64_json)) throw new ApiError('接口返回的图片编码无效', 502);
      const buffer = Buffer.from(item.b64_json, 'base64');
      const mime = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'image/jpeg' : buffer.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png';
      return [{ b64_json: item.b64_json, mime, revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null }];
    }
    if (typeof item.url === 'string') return [{ url: parseHttpUrl(item.url).toString(), revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null }];
    return [];
  });
  if (!images.length) throw new ApiError('接口返回成功，但没有可用的 url 或 b64_json 图片', 502);
  return { created: data.created, images };
}
async function optimizePrompt(body, signal) {
  const { endpoint, apiKey, model } = getConfig(body, chatEndpoint);
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 10000) throw new ApiError('请先输入提示词，最多 10000 个字符');
  const strength = body.strength === undefined ? 'standard' : body.strength;
  if (!['light', 'standard', 'rich'].includes(strength)) throw new ApiError('优化强度必须为轻度润色、标准优化或丰富细节');
  const referenceCount = body.referenceCount ?? 0;
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > 4) throw new ApiError('参考图数量必须为 0–4');
  const canvasSize = body.canvasSize || 'default';
  if (!['default', 'auto'].includes(canvasSize) && !isCustomSize(canvasSize)) throw new ApiError('画布尺寸无效');
  const imageCount = body.imageCount ?? 1;
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 4) throw new ApiError('生成张数必须为 1–4');
  const referenceGuidance = normalizeReferenceGuidance(body.referenceGuidance, referenceCount);
  const data = await upstreamJson(endpoint, apiKey, {
    model,
    stream: false,
    messages: [
      { role: 'system', content: buildOptimizationInstructions({ referenceCount, referenceGuidance, canvasSize, imageCount, strength }) },
      { role: 'user', content: prompt }
    ]
  }, signal);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new ApiError('优化结果被模型截断，请重试或缩短原提示词', 502);
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new ApiError('优化模型未提供可用提示词，原内容已保留', 502);
  const content = choice?.message?.content;
  const optimized = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '').trim();
  if (!optimized) throw new ApiError('优化接口未返回有效文本，请确认服务兼容 Chat Completions 格式', 502);
  if (optimized.length > 10000) throw new ApiError('优化结果超过 10000 字符，原提示词已保留，请缩短描述后重试', 502);
  return { prompt: optimized };
}
async function testConnection(body, optimizer = false) {
  const { endpoint, apiKey, model } = getConfig(body, optimizer ? chatEndpoint : generationEndpoint);
  const modelsUrl = new URL(endpoint);
  modelsUrl.pathname = endpoint.pathname.replace(optimizer ? /\/chat\/completions$/ : /\/images\/generations$/, '/models');
  const data = await upstreamJson(modelsUrl, apiKey);
  if (!Array.isArray(data.data)) throw new ApiError('模型列表格式不兼容；可直接生成图片验证生图端点', 502);
  const found = data.data.some(item => item?.id === model);
  return { message: found ? '鉴权成功，模型列表包含 ' + model + (optimizer ? '。优化能力需点击“优化提示词”验证。' : '。生图能力需通过实际生成验证。') : '鉴权成功，但模型列表中没有找到所填模型，请确认服务支持该模型。', found };
}
async function downloadImage(body, res) {
  const url = parseHttpUrl(body?.url);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new ApiError('图片下载失败，HTTP ' + response.status, 502);
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) throw new ApiError('下载地址未返回支持的图片格式', 502);
  const buffer = await limitedBuffer(response);
  const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': 'attachment; filename="prompt-studio.' + extension + '"', 'Cache-Control': 'no-store' });
  res.end(buffer);
}
async function serveStatic(url, res) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError('地址编码无效'); }
  const file = path.resolve(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new ApiError('禁止访问', 403);
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new ApiError('页面不存在', 404);
    throw error;
  }
}
function createServer({ requestTimeoutMs = 300000 } = {}) {
  return http.createServer(async (req, res) => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    const onClose = () => { if (!res.writableEnded) abortRequest(); };
    req.on('aborted', abortRequest);
    res.on('close', onClose);
    let timeout;
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new ApiError('仅支持本机访问', 403);
      const url = new URL(req.url, 'http://' + host);
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw new ApiError('不允许跨站请求', 403);
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError('请使用 application/json', 415);
        const body = await readBody(req, url.pathname === '/api/generate' ? 30 * 1024 * 1024 : 64 * 1024);
        timeout = setTimeout(() => requestController.abort(new DOMException('接口响应超时', 'TimeoutError')), requestTimeoutMs);
        requestController.signal.throwIfAborted();
        if (url.pathname === '/api/generate') return sendJson(res, 200, await generateImage(body, requestController.signal));
        if (url.pathname === '/api/optimize') return sendJson(res, 200, await optimizePrompt(body, requestController.signal));
        if (url.pathname === '/api/optimizer/test') return sendJson(res, 200, await testConnection(body, true));
        if (url.pathname === '/api/test') return sendJson(res, 200, await testConnection(body));
        if (url.pathname === '/api/download') return await downloadImage(body, res);
        throw new ApiError('接口不存在', 404);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url, res);
      throw new ApiError('不支持的请求方法', 405);
    } catch (error) {
      const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
      const payload = { error: timedOut ? '接口响应超时，请稍后重试' : error.status ? error.message : '无法连接 API 服务，请检查 URL、网络或本机代理配置' };
      if (error.diagnostic && !timedOut) payload.diagnostic = error.diagnostic;
      sendJson(res, error.status || (timedOut ? 504 : 502), payload);
    } finally {
      clearTimeout(timeout);
      req.removeListener('aborted', abortRequest);
      res.removeListener('close', onClose);
    }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口 ' + port + ' 已占用，请设置 PORT 后重试。' : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log('Prompt Studio 已启动：http://localhost:' + port + '\n按 Ctrl+C 停止服务'));
}
module.exports = { createServer, generationEndpoint };
