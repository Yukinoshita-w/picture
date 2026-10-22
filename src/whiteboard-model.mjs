export const FORMAT = 'prompt-studio-whiteboard';
export const VERSION = 1;
export const LIMITS = { nodes: 1000, edges: 3000, imageBytes: 20 * 1024 * 1024, packageBytes: 160 * 1024 * 1024 };
export const uid = prefix => prefix + '_' + crypto.randomUUID();
const number = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
export const color = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#786954';

export function createBoard(title = '未命名白板') {
  return { id: uid('board'), version: VERSION, title, createdAt: Date.now(), updatedAt: Date.now(), nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

// Store our own small schema, never arbitrary SVG/HTML or an editor's runtime image URLs.
export function validateBoard(input) {
  if (!input || typeof input !== 'object' || input.version !== VERSION) throw new Error('白板版本不支持，请更新应用或检查文件。');
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges) || input.nodes.length > LIMITS.nodes || input.edges.length > LIMITS.edges) throw new Error('白板数据无效或节点、连线过多。');
  const ids = new Set();
  const id = value => {
    if (typeof value !== 'string' || !value || value.length > 180 || ids.has(value)) throw new Error('白板元素标识缺失或重复。');
    ids.add(value); return value;
  };
  const nodes = input.nodes.map(item => ({
    id: id(item.id), x: number(item.x, 0, -1000000, 1000000), y: number(item.y, 0, -1000000, 1000000),
    width: number(item.width, 260, 120, 4000), height: number(item.height, 210, 100, 4000),
    title: text(item.title, 120), assetId: text(item.assetId, 180), zIndex: number(item.zIndex, 1, -10000, 10000),
    // Legacy title contained the generation prompt. Only an explicitly authored
    // caption is displayed, so old boards also reopen as clean images.
    caption: text(item.caption, 120), framed: item.framed === true,
    pins: (Array.isArray(item.pins) ? item.pins : []).slice(0, 64).map(pin => ({ id: text(pin.id, 100), x: number(pin.x, 0.5, 0, 1), y: number(pin.y, 0.5, 0, 1) }))
  }));
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const pins = new Set();
    for (const pin of node.pins) {
      if (!pin.id || pins.has(pin.id)) throw new Error('图片连接点标识无效。');
      pins.add(pin.id);
    }
  }
  const terminal = value => {
    if (value?.cell) {
      const node = nodeMap.get(value.cell);
      if (!node) throw new Error('连线引用了不存在的图片节点。');
      if (value.port && !node.pins.some(pin => pin.id === value.port)) throw new Error('连线引用了不存在的连接点。');
      return { cell: value.cell, ...(value.port ? { port: value.port } : {}) };
    }
    if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error('连线端点无效。');
    return { x: number(value.x, 0, -1000000, 1000000), y: number(value.y, 0, -1000000, 1000000) };
  };
  const edges = input.edges.map(item => ({
    id: id(item.id), source: terminal(item.source), target: terminal(item.target),
    vertices: [],
    color: color(item.color), width: number(item.width, 2, 1, 8), dashed: Boolean(item.dashed), arrow: Boolean(item.arrow),
    line: 'straight', label: text(item.label, 200)
  }));
  return {
    id: text(input.id, 180) || uid('board'), version: VERSION, title: text(input.title, 80).trim() || '未命名白板',
    createdAt: number(input.createdAt, Date.now(), 0, 1e15), updatedAt: number(input.updatedAt, Date.now(), 0, 1e15), nodes, edges,
    viewport: { x: number(input.viewport?.x, 0, -1e7, 1e7), y: number(input.viewport?.y, 0, -1e7, 1e7), zoom: number(input.viewport?.zoom, 1, 0.15, 3) }
  };
}

export function assetIds(board) {
  return [...new Set(board.nodes.map(node => node.assetId).filter(Boolean))];
}

export function validatePackage(input) {
  if (input?.format !== FORMAT || input.version !== VERSION || !Array.isArray(input.assets)) throw new Error('不是支持的 Prompt Studio 白板文件。');
  const board = validateBoard(input.board);
  const images = new Map();
  for (const asset of input.assets) {
    if (!asset || typeof asset.id !== 'string' || asset.id.length > 180 || images.has(asset.id) || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.data || '') || asset.data.length > LIMITS.imageBytes * 1.4) throw new Error('白板文件包含无效、重复或过大的图片。');
    images.set(asset.id, { id: asset.id, data: asset.data, name: text(asset.name, 120) });
  }
  if (assetIds(board).some(id => !images.has(id))) throw new Error('白板文件缺少引用的图片。');
  return { board, assets: [...images.values()] };
}
