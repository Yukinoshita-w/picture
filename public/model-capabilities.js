(function (root) {
  'use strict';
  const SIZES = ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
  const QUALITIES = ['auto', 'low', 'medium', 'high', 'standard', 'hd'];
  const FORMATS = ['b64_json', 'url'];
  function resolve(model, config) {
    if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) throw new Error('模型能力配置格式无效');
    const mode = config?.mode ?? 'auto';
    if (!['auto', 'custom'].includes(mode)) throw new Error('模型能力模式无效');
    if (mode === 'custom') {
      function choices(key, allowed) {
        const values = config[key];
        if (!Array.isArray(values) || values.length > allowed.length || values.some(value => !allowed.includes(value)) || new Set(values).size !== values.length) throw new Error('模型能力中的 ' + key + ' 选项无效');
        return values.slice();
      }
      if (!Number.isInteger(config.maxCount) || config.maxCount < 1 || config.maxCount > 4) throw new Error('最大生成张数必须为 1–4');
      if (!Number.isInteger(config.maxReferences) || config.maxReferences < 0 || config.maxReferences > 4) throw new Error('最大参考图数量必须为 0–4');
      if (!['auto', 'image', 'image[]'].includes(config.imageField)) throw new Error('参考图上传字段无效');
      return { sizes: choices('sizes', SIZES), qualities: choices('qualities', QUALITIES), responseFormats: choices('responseFormats', FORMATS), maxCount: config.maxCount, maxReferences: config.maxReferences, imageField: config.imageField };
    }
    const name = String(model || '').trim().toLowerCase();
    const gpt = name.includes('gpt-image'), dalle3 = name === 'dall-e-3', dalle2 = name === 'dall-e-2';
    return {
      sizes: dalle3 ? ['1024x1024', '1792x1024', '1024x1792'] : dalle2 ? ['1024x1024', '512x512', '256x256'] : ['1024x1024', '1536x1024', '1024x1536'],
      qualities: gpt ? ['auto', 'low', 'medium', 'high'] : dalle3 ? ['standard', 'hd'] : dalle2 ? [] : ['low', 'medium', 'high', 'standard', 'hd'],
      responseFormats: gpt ? [] : FORMATS.slice(), maxCount: dalle3 ? 1 : 4,
      maxReferences: dalle2 || dalle3 ? 0 : 4, imageField: 'auto'
    };
  }
  const api = { resolve, SIZES, QUALITIES, FORMATS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
