(function (root) {
  'use strict';
  // Shared by the preview and server so the visible requirements match the request.
  function generationRequirements({ size, quality, n } = {}) {
    const lines = [];
    if (typeof size === 'string' && /^\d+x\d+$/.test(size)) {
      const [width, height] = size.split('x').map(Number);
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      if (width > 0 && height > 0) {
        const divisor = gcd(width, height);
        const orientation = width === height ? '正方形画布' : width > height ? '横向画布' : '竖向画布';
        lines.push(`图像尺寸：宽 ${width} 像素 × 高 ${height} 像素；宽高比 ${width / divisor}:${height / divisor}，${orientation}。请按此比例安排整体构图。`);
      }
    } else if (size === 'auto') lines.push('图像尺寸：根据画面内容自动选择合适的尺寸与比例。');
    const qualityLabels = { auto: '自动选择画质', low: '基础画质（low）', medium: '中等画质（medium）', high: '高画质（high）', standard: '标准画质（standard）', hd: '高清画质（HD）' };
    if (Object.hasOwn(qualityLabels, quality)) lines.push('画质要求：' + qualityLabels[quality] + '。');
    const count = Number(n);
    if (Number.isInteger(count) && count > 1 && count <= 4) lines.push(`生成数量：${count} 张独立图片，请分别输出，不要拼成一张图。张数不代表画面中的主体数量，主体数量保持原提示词要求。`);
    return lines.length ? '\n\n【本次生成要求】\n' + lines.join('\n') + '\n画布尺寸和画质以以上设置为准，保留原提示词的主体、内容和风格。' : '';
  }
  if (typeof module === 'object' && module.exports) module.exports = generationRequirements;
  else root.generationRequirements = generationRequirements;
})(typeof globalThis !== 'undefined' ? globalThis : this);
