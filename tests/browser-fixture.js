const http = require('node:http');
const zlib = require('node:zlib');
const { createServer } = require('../server');
let nextGenerationControl = {};
let releaseGeneration = null;
let nextDownloadControl = {};
let releaseDownload = null;
const nextTextControls = new Map();
const textReleases = new Map();

function textPhase(system, user) {
  if (Array.isArray(user)) return 'describe';
  if (system.includes('帧清单')) return 'outline';
  if (system.includes('补全摄影或绘画层面的专业参数')) return 'reduce';
  if (system.includes('扩写成可以作画的分帧描述')) return 'shot';
  if (system.includes('从下面这一段素材中提取')) return 'extract';
  return 'other';
}

async function controlledText(res, system, user) {
  const phase = textPhase(system, user);
  stats.textRequests ||= [];
  stats.textRequests.push({ phase, input: JSON.stringify(user).slice(0, 1500) });
  const control = nextTextControls.get(phase) || {};
  nextTextControls.delete(phase);
  if (control.hold) {
    stats.heldText ||= {};
    stats.heldText[phase] = true;
    await new Promise(resolve => textReleases.set(phase, resolve));
    textReleases.delete(phase);
    stats.heldText[phase] = false;
  }
  if (res.destroyed) return false;
  if (!control.fail) return true;
  res.statusCode = 502;
  res.end(JSON.stringify({ error: { message: 'controlled mock text failure' } }));
  return false;
}

async function controlledGeneration(res) {
  const control = nextGenerationControl;
  res.mockRemote = Boolean(control.remote);
  nextGenerationControl = {};
  if (control.hold) {
    stats.heldGeneration = true;
    await new Promise(resolve => { releaseGeneration = resolve; });
    releaseGeneration = null;
    stats.heldGeneration = false;
  }
  if (!control.fail) return true;
  res.statusCode = 502;
  res.end(JSON.stringify({ error: { message: 'controlled mock generation failed' } }));
  return false;
}

// Builds a real PNG of a solid colour so the drift analyser has something to measure.
function solidPng(red, green, blue, size = 64) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const offset = row + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

const stats = {
  optimizations: 0,
  generations: 0,
  lastPrompt: null,
  optimizationInstructions: null,
  abortedOptimizations: 0,
  abortedGenerations: 0,
  seriesExtracts: 0,
  seriesReduces: 0,
  seriesDescribes: 0,
  seriesOutlines: 0,
  seriesShots: 0,
  seriesInstructions: [],
  lastOutlineInput: '',
  chatCalls: 0,
  lastChatPath: null,
  editCalls: []
};

const EXTRACTION = {
  themes: ['记忆可被投递改写'],
  visualClues: ['钠灯在湿地面的长条反光', '铜制信匣的绿锈'],
  characters: [{ role: 'hero', name: '林野', traits: ['二十出头', '旧呢大衣', '左手有旧伤'] }],
  places: [{ name: '潮汐市', traits: ['沿海旧城', '永夜', '多雨'] }],
  props: [{ name: '铜制信匣', traits: ['绿锈', '刻有编号'] }],
  mood: ['克制的忧郁'],
  era: '近未来',
  paletteHints: ['湿沥青黑', '钠灯橙', '雨雾青'],
  taboos: ['血腥', '卡通化'],
  notableLines: ['每次投递都会抹去一个人的一段记忆']
};

const CANON = {
  medium: '35mm 胶片摄影',
  lighting: { key: '单侧钠灯硬光', ratio: '1:8', direction: '左后侧', colorTemp: '2700K 主光 + 5600K 环境' },
  lens: { focal: '35mm', aperture: 'f/2.0', distance: '中景', angle: '平视略低' },
  composition: { frame: '3:2 横构图', placement: '主体偏左三分', negativeSpace: '上方留出雨幕', horizon: '低地平线' },
  grade: { contrast: '高对比', saturation: '低饱和', shadows: '青黑压暗', highlights: '橙黄溢出' },
  material: { render: '真实摄影', texture: '胶片颗粒', finish: '轻微眩光' },
  palette: [
    { name: '湿沥青', hex: '#1b1f24', weight: 0.4 },
    { name: '钠灯橙', hex: '#c9762f', weight: 0.35 },
    { name: '雨雾青', hex: '#5c7a80', weight: 0.25 }
  ],
  terms: { hero: '林野', city: '潮汐市', device: '铜制信匣' },
  characterLook: '短黑发微湿，眉骨明显，左眉尾有浅疤，深灰呢大衣，领口立起',
  atmosphere: '克制忧郁的近未来沿海旧城',
  negative: ['水印', '文字', '多余人物'],
  themes: ['记忆可被投递改写'],
  mood: ['克制的忧郁'],
  era: '近未来',
  taboos: ['血腥', '卡通化']
};

const DESCRIPTION = {
  summary: '短黑发年轻男性，穿深灰呢大衣',
  appearance: '二十出头男性，短黑发微湿，眉骨明显，左眉尾有浅疤，深灰呢大衣，领口立起',
  palette: ['深灰', '黑', '冷白'],
  props: ['铜制信匣'],
  suggestedTerms: { hero: '林野' },
  notes: ['领口始终保持立起']
};

const OUTLINE = {
  title: '雨夜邮差',
  beats: ['第一幕：第一次投递', '第二幕：记忆改写'],
  axes: [
    { id: 'scene', label: '场景', values: ['旧城邮局', '霓虹天桥', '海边栈道'] },
    { id: 'time', label: '时间', values: ['雨夜', '凌晨'] }
  ],
  shots: [
    { code: 'S01', title: '邮局', beat: '第一幕', subject: '林野', action: '整理信件', scene: '旧城邮局', detail: '钠灯把雨影投在墙上', loreTitle: '信匣', axisValues: { scene: '旧城邮局', time: '雨夜' } },
    { code: 'S02', title: '天桥', beat: '第一幕', subject: '林野', action: '把信匣塞进锈蚀的信箱', scene: '霓虹天桥', detail: '雨幕被霓虹切成条纹', loreTitle: '', axisValues: { scene: '霓虹天桥', time: '雨夜' } },
    { code: 'S03', title: '栈道', beat: '第二幕', subject: '林野', action: '站在海边栈道回望城市', scene: '海边栈道', detail: '远处货轮的灯在雾里散开', loreTitle: '', axisValues: { scene: '海边栈道', time: '凌晨' } }
  ]
};

function seriesReply(system, user) {
  if (system.includes('JSON 修复器')) return null;
  if (system.includes('帧清单')) {
    stats.seriesOutlines++;
    // Record what the browser actually sent, so the test can prove lore reached the model.
    stats.lastOutlineInput = Array.isArray(user) ? '' : String(user || '');
    return OUTLINE;
  }
  if (system.includes('参考图') && system.includes('重点描述')) { stats.seriesDescribes++; return DESCRIPTION; }
  if (system.includes('补全摄影或绘画层面的专业参数')) { stats.seriesReduces++; return CANON; }
  if (system.includes('扩写成可以作画的分帧描述')) { stats.seriesShots++; return { subject: '林野', action: '把信匣塞进锈蚀的信箱', scene: '霓虹天桥', detail: '雨幕被霓虹切成条纹' }; }
  if (system.includes('从下面这一段素材中提取')) { stats.seriesExtracts++; return EXTRACTION; }
  return null;
}

const optimizerMock = http.createServer(async (req, res) => {
  let responded = false;
  req.socket.on('close', () => { if (!responded) stats.abortedOptimizations++; });
  res.setHeader('Content-Type', 'application/json');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/stats') { responded = true; return res.end(JSON.stringify(stats)); }
  if (req.url === '/generation-control' && req.method === 'POST') {
    const control = JSON.parse(Buffer.concat(chunks).toString());
    if (control.release) releaseGeneration?.();
    else nextGenerationControl = control;
    responded = true;
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.url === '/download-control' && req.method === 'POST') {
    const control = JSON.parse(Buffer.concat(chunks).toString());
    if (control.release) releaseDownload?.();
    else nextDownloadControl = control;
    responded = true;
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.url === '/text-control' && req.method === 'POST') {
    const control = JSON.parse(Buffer.concat(chunks).toString());
    if (control.release) textReleases.get(control.phase)?.();
    else nextTextControls.set(control.phase, control);
    responded = true;
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.url.endsWith('/models')) { responded = true; return res.end(JSON.stringify({ data: [{ id: 'text-model' }] })); }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (req.headers.authorization !== 'Bearer optimizer-secret' || !req.url.endsWith('/chat/completions')) {
    res.statusCode = 401;
    responded = true;
    return res.end(JSON.stringify({ error: { message: 'wrong optimizer API credentials or path' } }));
  }
  const system = body.messages?.[0]?.content || '';
  const user = body.messages?.[1]?.content;
  if (!await controlledText(res, system, user)) { responded = true; return; }
  const series = seriesReply(system, user);
  if (series) {
    stats.seriesInstructions.push(system.slice(0, 120));
    await new Promise(resolve => setTimeout(resolve, 40));
    if (res.destroyed) return;
    responded = true;
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(series) } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }));
  }
  // Vision requests carry the image as a content part array.
  if (Array.isArray(user) && user.some(part => part?.type === 'image_url')) {
    stats.seriesDescribes++;
    responded = true;
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(DESCRIPTION) } }] }));
  }
  stats.optimizations++;
  stats.optimizationInstructions = system;
  await new Promise(resolve => setTimeout(resolve, body.model === 'slow-text-model' ? 1800 : 150));
  if (res.destroyed) return;
  if (body.model === 'fail') {
    res.statusCode = 502;
    responded = true;
    return res.end(JSON.stringify({ error: { message: 'mock optimization failed' } }));
  }
  responded = true;
  res.end(JSON.stringify({ choices: [{ message: { content: '优化后的提示词：' + body.messages[1].content } }] }));
});

const mock = http.createServer(async (req, res) => {
  let responded = false;
  req.socket.on('close', () => { if (!responded) stats.abortedGenerations++; });
  res.setHeader('Content-Type', 'application/json');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/remote-image') {
    const control = nextDownloadControl;
    nextDownloadControl = {};
    stats.downloads = (stats.downloads || 0) + 1;
    stats.downloadAuth = req.headers.authorization || null;
    if (control.hold) {
      stats.heldDownload = true;
      await new Promise(resolve => { releaseDownload = resolve; });
      releaseDownload = null;
      stats.heldDownload = false;
    }
    responded = true;
    if (control.fail) { res.statusCode = 403; return res.end('expired mock image link'); }
    res.setHeader('Content-Type', control.unsupported ? 'text/html' : 'image/png');
    return res.end(control.corrupt || control.unsupported ? 'not an image' : solidPng(60,92,120));
  }
  if (req.url.endsWith('/models')) { responded = true; return res.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }] })); }
  // The series feature reuses the create page's base URL, so this mock must answer chat
  // completions too. That also proves the chat path is derived correctly.
  if (req.url.endsWith('/chat/completions')) {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    stats.chatCalls++;
    stats.lastChatPath = req.url;
    const system = body.messages?.[0]?.content || '';
    const user = body.messages?.[1]?.content;
    if (!await controlledText(res, system, user)) { responded = true; return; }
    if (Array.isArray(user) && user.some(part => part?.type === 'image_url')) {
      stats.seriesDescribes++;
      responded = true;
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(DESCRIPTION) } }] }));
    }
    const series = seriesReply(system, user);
    if (series) {
      stats.seriesInstructions.push(system.slice(0, 120));
      responded = true;
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(series) } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }));
    }
    responded = true;
    return res.end(JSON.stringify({ choices: [{ message: { content: '优化后的提示词：' + (Array.isArray(user) ? '' : user) } }] }));
  }
  stats.generations++;
  if (req.url.endsWith('/generations')) {
    stats.lastBody = JSON.parse(Buffer.concat(chunks).toString());
    stats.lastPrompt = stats.lastBody.prompt;
    if (stats.lastBody.model === 'fail' || stats.lastBody.model === 'timeout') {
      res.statusCode = stats.lastBody.model === 'timeout' ? 504 : 502;
      return res.end(JSON.stringify({ error: { message: 'mock generation failed' } }));
    }
  }
  if (req.url.endsWith('/edits')) {
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
    const files = [...form.getAll('image'), ...form.getAll('image[]')];
    stats.lastEdit = { fields: [...form.keys()], images: form.getAll('image').length, imageArray: form.getAll('image[]').length, prompt: form.get('prompt'), model: form.get('model'), size: form.get('size'), quality: form.get('quality') };
    stats.editCalls.push({ images: files.length, prompt: form.get('prompt'), size: form.get('size'), quality: form.get('quality') });
    if (!files.length || !form.get('prompt') || files.some(file => file.size === 0)) {
      res.statusCode = 400;
      responded = true;
      return res.end(JSON.stringify({ error: { message: 'No reference files or prompt received' } }));
    }
    // Alternate two distinct palettes so drift scores are not all zero.
    const alternate = stats.editCalls.length % 2 === 0;
    const png = alternate ? solidPng(20, 24, 28) : solidPng(200, 120, 60);
    if (!await controlledGeneration(res)) { responded = true; return; }
    responded = true;
    return res.end(JSON.stringify({ data: [{ ...(res.mockRemote ? {url:'http://127.0.0.1:' + mock.address().port + '/remote-image'} : {b64_json:png.toString('base64')}), revised_prompt: 'Mock image edit with ' + files.length + ' references' }] }));
  }
  if (stats.lastBody?.model === 'slow-image-model') await new Promise(resolve => setTimeout(resolve, 1800));
  if (!await controlledGeneration(res)) { responded = true; return; }
  if (res.destroyed) return;
  responded = true;
  res.end(JSON.stringify({ data: [{ ...(res.mockRemote ? {url:'http://127.0.0.1:' + mock.address().port + '/remote-image'} : {b64_json:solidPng(60,92,120).toString('base64')}), revised_prompt: 'A sample from the local mock API' }] }));
});
mock.listen(0, '127.0.0.1', () => {
  optimizerMock.listen(0, '127.0.0.1', () => {
    const app = createServer();
    app.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ app: 'http://127.0.0.1:' + app.address().port, api: 'http://127.0.0.1:' + mock.address().port + '/v1', optimizerApi: 'http://127.0.0.1:' + optimizerMock.address().port + '/v1', stats: 'http://127.0.0.1:' + optimizerMock.address().port + '/stats' }));
    });
  });
});
