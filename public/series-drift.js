(function (root) {
  'use strict';

  // Series drift is measured on a 32x32 thumbnail: a small, deterministic signature that
  // is cheap to compute for every generated image and stable enough to compare frames.
  const SIZE = 32;
  const COLOR_BUCKETS = 8;

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片无法解码'));
      image.src = source;
    });
  }

  function toDataUrl(source) {
    return String(source || '').startsWith('data:') ? source : null;
  }

  // Drawing a remote URL into a canvas would taint it, so URL-based results are fetched
  // through the local proxy first.
  async function resolveSource(source, fetchProxy) {
    const direct = toDataUrl(source);
    if (direct) return direct;
    if (typeof fetchProxy !== 'function') throw new Error('需要代理下载才能分析远程图片');
    const response = await fetchProxy(source);
    return response;
  }

  function bucket(component) {
    return Math.min(COLOR_BUCKETS - 1, Math.floor((component / 256) * COLOR_BUCKETS));
  }

  function signature(pixels) {
    const buckets = new Map();
    let luminance = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const key = bucket(red) + ':' + bucket(green) + ':' + bucket(blue);
      buckets.set(key, (buckets.get(key) || 0) + 1);
      luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }
    const total = pixels.length / 4;
    const palette = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => ({ key, weight: count / total }));
    return { palette, luminance: luminance / total / 255, total };
  }

  function averageHash(pixels) {
    const values = [];
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
      values.push(value);
      sum += value;
    }
    const mean = sum / values.length;
    return values.map(value => (value >= mean ? '1' : '0')).join('');
  }

  function hamming(a, b) {
    const length = Math.min(a.length, b.length);
    let distance = 0;
    for (let index = 0; index < length; index++) if (a[index] !== b[index]) distance++;
    return length ? distance / length : 0;
  }

  // Palette distance compares the dominant colour buckets as sets: two frames that share
  // most of their dominant colours are close even if their composition differs.
  function paletteDistance(a, b) {
    const keys = new Set([...a.palette.map(item => item.key), ...b.palette.map(item => item.key)]);
    if (!keys.size) return 0;
    let shared = 0;
    for (const key of keys) {
      const left = a.palette.find(item => item.key === key)?.weight || 0;
      const right = b.palette.find(item => item.key === key)?.weight || 0;
      shared += Math.min(left, right);
    }
    return Math.max(0, Math.min(1, 1 - shared));
  }

  function createSeriesDrift({ fetchProxy } = {}) {
    async function analyze(source) {
      const resolved = await resolveSource(source, fetchProxy);
      const image = await loadImage(resolved);
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, SIZE, SIZE);
      const { data } = context.getImageData(0, 0, SIZE, SIZE);
      const sig = signature(data);
      return { ...sig, hash: averageHash(data) };
    }

    async function compare(source, baseline) {
      const [left, right] = await Promise.all([analyze(source), analyze(baseline)]);
      const color = paletteDistance(left, right);
      const brightness = Math.abs(left.luminance - right.luminance);
      const structure = hamming(left.hash, right.hash);
      return Math.max(0, Math.min(1, 0.5 * color + 0.3 * brightness + 0.2 * structure));
    }

    return { analyze, compare };
  }

  const api = { createSeriesDrift, paletteDistance, hamming, SIZE, COLOR_BUCKETS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.createSeriesDrift = createSeriesDrift;
})(typeof globalThis !== 'undefined' ? globalThis : this);
