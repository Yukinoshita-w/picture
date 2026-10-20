(function (root) {
  'use strict';
  // Shared by the server and the browser so the prompt preview matches the request
  // byte for byte. The reference numbering must have exactly one source.
  const REFERENCE_PURPOSES = { person: '人物', composition: '构图', style: '风格', product: '产品外观', custom: '自定义' };

  // Accepts either the API enum ("person") or an already-mapped label ("人物"), so the
  // browser preview and the server always render the same text.
  function purposeLabel(item) {
    if (!item) return '未指定';
    const raw = String(item.purpose || '').trim();
    const mapped = Object.hasOwn(REFERENCE_PURPOSES, raw) ? REFERENCE_PURPOSES[raw] : raw;
    return mapped || String(item.customPurpose || '').trim() || '未指定';
  }

  function guidanceLines(guidance) {
    if (!Array.isArray(guidance)) return [];
    return guidance.map((item, index) => {
      if (!item) return '';
      const parts = ['参考图' + (index + 1) + '（用途：' + purposeLabel(item) + '）'];
      if (item.preserve) parts.push('需要保留：' + item.preserve);
      if (item.change) parts.push('需要修改：' + item.change);
      return parts.join('，');
    }).filter(Boolean);
  }

  function formatReferenceGuidance(guidance) {
    const lines = guidanceLines(guidance);
    return lines.length ? '\n\n参考图使用说明（按编号对应上传图片）：\n' + lines.join('\n') : '';
  }

  // Highest "参考图N" mentioned in free text, so the compiler can assert that the
  // prompt never points at an image that is not actually uploaded.
  function referencedIndexes(text) {
    const found = new Set();
    const pattern = /参考图\s*(\d{1,2})/g;
    let match;
    const value = String(text || '');
    while ((match = pattern.exec(value)) !== null) found.add(Number(match[1]));
    return [...found].sort((a, b) => a - b);
  }

  const api = { REFERENCE_PURPOSES, formatReferenceGuidance, guidanceLines, referencedIndexes, purposeLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReferenceGuidance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
