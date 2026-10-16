(function (root) {
  'use strict';
  const SIZES = ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
  const QUALITIES = ['auto', 'low', 'medium', 'high', 'standard', 'hd'];
  const FORMATS = ['b64_json', 'url'];
  function isCustomSize(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{1,3}x[1-9]\d{1,3}$/.test(value)) return false;
    return value.split('x').map(Number).every(side => side >= 64 && side <= 8192 && side % 8 === 0);
  }
  function supportsSize(capabilities, value) {
    return value === 'default' || capabilities.sizes.includes(value) || (capabilities.customSizes === true && isCustomSize(value));
  }
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
      if (config.customSizes !== undefined && typeof config.customSizes !== 'boolean') throw new Error('自定义尺寸能力无效');
      return { sizes: choices('sizes', SIZES), customSizes: config.customSizes === true, qualities: choices('qualities', QUALITIES), responseFormats: choices('responseFormats', FORMATS), maxCount: config.maxCount, maxReferences: config.maxReferences, imageField: config.imageField };
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
  const api = { resolve, SIZES, QUALITIES, FORMATS, isCustomSize, supportsSize };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
