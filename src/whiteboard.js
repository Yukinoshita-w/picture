import { Graph, Config, Selection, Transform, History, Snapline, Clipboard, Export } from '@antv/x6';
import { FORMAT, VERSION, LIMITS, uid, createBoard, validateBoard, validatePackage, assetIds } from './whiteboard-model.mjs';
import { createWhiteboardStore, imageAsset, cloneImported } from './whiteboard-store.mjs';

Config.autoInsertCSS = false;
Graph.registerNode('whiteboard-image', {
  inherit: 'rect', width: 260, height: 210,
  markup: [
    { tagName: 'rect', selector: 'body' },
    { tagName: 'rect', selector: 'imageBackground' },
    { tagName: 'image', selector: 'image' },
    { tagName: 'text', selector: 'placeholder' },
    { tagName: 'text', selector: 'label' }
  ],
  attrs: {
    body: { fill: '#fffdf8', stroke: '#cfc7b8', strokeWidth: 1, rx: 5, ry: 5, refWidth: '100%', refHeight: '100%', magnet: true },
    imageBackground: { fill: '#f0ece3', stroke: 'none', pointerEvents: 'none', rx: 2 },
    image: { preserveAspectRatio: 'xMidYMid meet', pointerEvents: 'none' },
    placeholder: { text: '＋ 选择图片', fill: '#8b8272', fontSize: 14, textAnchor: 'middle', dominantBaseline: 'middle', pointerEvents: 'none' },
    label: { refX: 0, refY: 0, fill: '#3e382d', fontSize: 12, fontFamily: 'Microsoft YaHei, sans-serif', textAnchor: 'start', textVerticalAnchor: 'middle', pointerEvents: 'none' }
  },
  ports: { groups: { pin: {
    // Editing handles sit above their image, but remain invisible in the stored
    // SVG attributes. Only the pin/connect editor modes reveal them via CSS.
    position: 'absolute', zIndex: 'auto',
    attrs: { circle: { r: 7, magnet: true, stroke: '#b23a22', fill: 'transparent', strokeWidth: 2, vectorEffect: 'non-scaling-stroke', opacity: 0 } }
  } } }
}, true);

export async function createWhiteboard({ gallery }) {
  const $ = selector => document.querySelector(selector);
  const root = $('#galleryBoard'), canvas = $('#wbCanvas');
  const store = createWhiteboardStore();
  const assets = new Map(), urls = new Map(), pendingAssets = new Map();
  let board, graph, history, selection, transform;
  let visible = false, loading = true, switching = false, working = false, presenting = false, initializing;
  let mode = 'select', dirty = false, revision = 0, saveTimer, saving;
  let artworks = [], pickerTarget, libraryRequest = 0, activeDialog;
  let boards = [], selectedCell;
  const edgeLayer = -10001; // Below every image, including older negative node layers.
  const defaults = { color: '#786954', width: 2, line: 'straight', arrow: false, dashed: false, label: '' };

  function status(message = '', error = false) {
    $('#wbStatus').textContent = message; $('#wbStatus').hidden = !message; $('#wbStatus').dataset.error = String(error);
  }
  function saveState(message, error = false) {
    $('#wbSaveState').textContent = message; $('#wbSaveState').dataset.error = String(error); $('#wbRetrySave').hidden = !error;
  }
  function attempt(action) {
    return async (...args) => {
      try { await action(...args); }
      catch (error) { status(error.name === 'QuotaExceededError' ? '浏览器存储空间不足，请导出备份后清理不需要的白板。' : error.message || '操作失败，请重试。', true); }
    };
  }
  function listen(id, action, event = 'click') { $('#' + id).addEventListener(event, attempt(action)); }
  function editable() { return !loading && !switching && !working && !presenting; }
  function controls() {
    const blocked = loading || switching || working;
    for (const id of ['wbNew', 'wbDeleteBoard', 'wbBoardList', 'wbImport', 'wbExport', 'wbExportType', 'wbPresent']) $('#' + id).disabled = blocked;
    for (const id of ['wbAddNode', 'wbUpload', 'wbTitle']) $('#' + id).disabled = blocked || presenting;
    $('#wbUndo').disabled = !editable() || !history?.canUndo();
    $('#wbRedo').disabled = !editable() || !history?.canRedo();
    for (const button of root.querySelectorAll('[data-wb-mode]')) button.disabled = blocked;
  }
  function updateStats() {
    if (!graph) return;
    const nodes = graph.getNodes().length, edges = graph.getEdges().length;
    $('#wbStats').textContent = nodes + ' 个节点 · ' + edges + ' 条连线';
    $('#wbCanvasEmpty').hidden = nodes > 0 || edges > 0;
    $('#wbZoom').textContent = Math.round(graph.zoom() * 100) + '%';
    controls();
  }
  function markDirty() {
    if (loading || !board) return;
    dirty = true; revision++;
    saveState('尚未保存…'); clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flush(); }, 500);
    updateStats();
  }
  function terminal(value) {
    return value?.cell ? { cell: value.cell, ...(value.port ? { port: value.port } : {}) } : { x: value.x, y: value.y };
  }
  function snapshot() {
    const offset = graph.translate();
    return validateBoard({ ...board, updatedAt: Math.max(Date.now(), board.updatedAt + 1),
      viewport: { x: offset.tx, y: offset.ty, zoom: graph.zoom() },
      nodes: graph.getNodes().map(node => ({
        id: node.id, ...node.position(), ...node.size(), zIndex: node.getZIndex(),
        title: node.getData()?.title || '', assetId: node.getData()?.assetId || '',
        caption: node.getData()?.caption || '', framed: node.getData()?.framed === true,
        pins: node.getPorts().map(pin => ({ id: pin.id, x: parseFloat(pin.args.x) / 100, y: parseFloat(pin.args.y) / 100 }))
      })),
      edges: graph.getEdges().map(edge => ({ ...defaults, ...edge.getData(), id: edge.id, source: terminal(edge.getSource()), target: terminal(edge.getTarget()), vertices: edge.getVertices() }))
    });
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (saving) { await saving; if (!dirty) return true; }
    if (!board || !dirty || loading) return true;
    let saved;
    try { saved = snapshot(); }
    catch (error) { saveState('保存失败：' + error.message, true); return false; }
    const currentRevision = revision;
    const images = [...pendingAssets.values()];
    saveState('正在保存…');
    saving = (async () => {
      try {
        await store.save(saved, images, board.updatedAt);
        for (const image of images) pendingAssets.delete(image.id);
        board.updatedAt = saved.updatedAt;
        dirty = revision !== currentRevision;
        if (!dirty) saveState('已自动保存 · 本机浏览器');
        return true;
      } catch (error) {
        saveState(error.name === 'QuotaExceededError' ? '空间不足，未能保存' : '保存失败，请重试', true);
        status('白板尚未保存，请重试保存或导出白板备份后再离开。' + (error.message || ''), true);
        return false;
      }
    })();
    const success = await saving; saving = null;
    if (success && dirty) return flush();
    return success;
  }
  function assetURL(id, original = false) {
    const key = id + (original ? ':full' : ':thumb');
    const asset = assets.get(id);
    if (!asset) return '';
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(original ? asset.blob : asset.thumbnail || asset.blob));
    return urls.get(key);
  }
  function releaseImages() {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear(); assets.clear(); pendingAssets.clear();
  }
  function decorateNode(node) {
    const { width, height } = node.size(), data = node.getData() || {};
    const title = data.caption || '';
    const framed = data.framed === true, padding = framed ? 10 : 0;
    const captionHeight = title ? 30 : 0;
    const imageWidth = width - padding * 2, imageHeight = Math.max(1, height - padding * 2 - captionHeight);
    node.setAttrs({
      body: { fill: framed ? '#fffdf8' : 'transparent', stroke: framed ? '#cfc7b8' : data.assetId ? 'none' : '#cfc7b8', rx: framed ? 5 : 0, ry: framed ? 5 : 0 },
      imageBackground: { x: padding, y: padding, width: imageWidth, height: imageHeight, display: framed ? 'block' : 'none' },
      image: { x: padding, y: padding, width: imageWidth, height: imageHeight, 'xlink:href': assetURL(data.assetId), display: data.assetId ? 'block' : 'none' },
      placeholder: { x: width / 2, y: imageHeight / 2 + padding, display: data.assetId ? 'none' : 'block' },
      label: { x: padding, y: height - padding - 13, display: title ? 'block' : 'none', text: title.length > Math.floor(imageWidth / 12) ? title.slice(0, Math.max(4, Math.floor(imageWidth / 12) - 2)) + '…' : title }
    }, { transient: true });
  }
  function edgeConfiguration(data = defaults) {
    const style = { ...defaults, ...data };
    return {
      zIndex: edgeLayer, vertices: [],
      connector: { name: 'normal' }, router: { name: 'normal' },
      attrs: { line: { stroke: style.color, strokeWidth: style.width, strokeDasharray: style.dashed ? '7 5' : '', targetMarker: style.arrow ? { name: 'classic', size: 8 } : null, sourceMarker: null } },
      labels: style.label ? [{ attrs: { label: { text: style.label, fill: '#4a463c', fontSize: 12 }, body: { fill: '#fffdf8', stroke: '#d6d0c2', rx: 3, ry: 3 } } }] : []
    };
  }
  function decorateEdge(edge) {
    const config = edgeConfiguration(edge.getData());
    edge.prop(config, { transient: true });
  }
  function addNode(config = {}) {
    if (graph.getNodes().length >= LIMITS.nodes) throw new Error('一个白板最多支持 ' + LIMITS.nodes + ' 个节点。');
    const center = graph.getGraphArea().getCenter();
    const node = graph.addNode({
      id: config.id || uid('node'), shape: 'whiteboard-image', x: config.x ?? center.x - 130, y: config.y ?? center.y - 105,
      width: config.width || 260, height: config.height || 210, zIndex: config.zIndex || graph.getNodes().length + 1,
      data: { title: config.title || '', caption: config.caption || '', framed: config.framed === true, assetId: config.assetId || '' },
      ports: { items: (config.pins || []).map(pin => ({ id: pin.id, group: 'pin', args: { x: pin.x * 100 + '%', y: pin.y * 100 + '%' } })) }
    });
    decorateNode(node); return node;
  }
  function select(cell) {
    graph.resetSelection(cell ? [cell] : []);
    if (cell?.isNode() && mode === 'select' && !presenting) transform.createWidget(cell);
    canvas.focus({ preventScroll: true });
  }
  function updateInspector() {
    if (!graph) return;
    for (const edge of graph.getEdges()) if (edge.hasTools()) edge.removeTools({ transient: true });
    const chosen = graph.getSelectedCells();
    selectedCell = chosen.length === 1 ? chosen[0] : null;
    $('#wbNoSelection').hidden = chosen.length > 0;
    $('#wbNodeProperties').hidden = !selectedCell?.isNode();
    $('#wbEdgeProperties').hidden = !selectedCell?.isEdge();
    $('#wbRemove').hidden = chosen.length === 0 || presenting;
    if (selectedCell?.isNode()) {
      const data = selectedCell.getData() || {};
      $('#wbNodeTitle').value = data.caption || '';
      $('#wbNodeFrame').checked = data.framed === true;
      $('#wbPreview').disabled = !data.assetId;
      $('#wbClearPins').disabled = !selectedCell.getPorts().length;
    } else if (selectedCell?.isEdge()) {
      const data = { ...defaults, ...selectedCell.getData() };
      $('#wbEdgeLabel').value = data.label;
      $('#wbEdgeColor').value = data.color;
      $('#wbEdgeWidth').value = String(data.width);
      $('#wbEdgeArrow').checked = data.arrow;
      $('#wbEdgeDashed').checked = data.dashed;
      if (!presenting && mode === 'select') selectedCell.setTools({ local: true, items: [
        { name: 'source-arrowhead' }, { name: 'target-arrowhead' }
      ] }, { transient: true });
    }
    if (chosen.length > 1) { $('#wbNoSelection').hidden = false; $('#wbNoSelection').textContent = '已选中 ' + chosen.length + ' 个元素，可整体移动、复制或删除。'; }
    else $('#wbNoSelection').innerHTML = '<span class="section-label">Your Composition</span><p>选中图片或连线，在这里调整内容。</p><p>双击图片可查看大图；双击空节点可选择图片。</p>';
    controls();
  }
  function setMode(value) {
    if (loading) return;
    mode = value;
    canvas.dataset.mode = value;
    for (const button of root.querySelectorAll('[data-wb-mode]')) button.setAttribute('aria-pressed', String(button.dataset.wbMode === value));
    const hints = {
      select: '拖动图片移动 · Shift 框选 · 滚轮缩放 · 中键拖动画布',
      connect: '从空心圆环拖向另一张图片或连接点 · 直线位于图片下方 · 切回选择隐藏圆环',
      pan: '拖动画布平移 · 滚轮缩放 · 点击“适应画面”查看全部',
      pin: '点击图片添加空心圆环连接点 · 切换“连线”从圆环拉线 · 选择与展示时自动隐藏'
    };
    $('#wbModeHint').textContent = hints[value];
    if (value === 'pan' || presenting) { graph.options.panning.eventTypes = ['leftMouseDown', 'mouseWheelDown']; graph.enablePanning(); }
    else { graph.options.panning.eventTypes = ['mouseWheelDown']; graph.enablePanning(); }
    if (value === 'select' && !presenting) { selection.enable(); transform.enable(); }
    else { selection.disable(); transform.clearWidgets(); transform.disable(); }
    updateInspector();
  }
  function initGraph() {
    // X6 writes pixel dimensions on its container. Keep the responsive, observed
    // canvas outside it so those inline dimensions cannot freeze the grid width.
    const surface = document.createElement('div');
    surface.className = 'wb-graph'; canvas.append(surface);
    graph = new Graph({
      container: surface, width: canvas.clientWidth || 700, height: canvas.clientHeight || 580, autoResize: false, async: false,
      grid: { size: 20, visible: true, type: 'dot', args: { color: '#b8ad99', thickness: 1 } },
      background: { color: 'transparent' }, scaling: { min: 0.15, max: 3 },
      mousewheel: { enabled: true, modifiers: [], minScale: 0.15, maxScale: 3 },
      panning: { enabled: true, eventTypes: ['mouseWheelDown'] },
      interacting() { return {
        nodeMovable: !presenting && mode === 'select' && !working,
        magnetConnectable: !presenting && mode === 'connect' && !working,
        edgeMovable: !presenting && mode === 'select', edgeLabelMovable: !presenting && mode === 'select',
        arrowheadMovable: !presenting && mode === 'select', vertexMovable: !presenting && mode === 'select',
        vertexAddable: !presenting && mode === 'select', vertexDeletable: !presenting && mode === 'select',
        useEdgeTools: !presenting && mode === 'select'
      }; },
      connecting: {
        allowBlank: false, allowLoop: true, allowMulti: true, allowNode: true, allowEdge: false, allowPort: true,
        snap: { radius: 25 }, anchor: 'center', connectionPoint: 'boundary', highlight: true,
        validateMagnet: () => editable() && mode === 'connect' && graph.getEdges().length < LIMITS.edges,
        createEdge: () => graph.createEdge({ shape: 'edge', data: { ...defaults }, ...edgeConfiguration() })
      }
    });
    history = new History({ stackSize: 100, beforeAddCommand: (_event, args) => !loading && !args.options?.transient });
    selection = new Selection({ enabled: true, multiple: true, rubberband: true, modifiers: ['shift'], showNodeSelectionBox: false, showEdgeSelectionBox: false });
    transform = new Transform({ resizing: { enabled: true, minWidth: 120, minHeight: 100, preserveAspectRatio: true }, rotating: false });
    graph.use(history).use(selection).use(transform).use(new Snapline({ enabled: true })).use(new Clipboard({ enabled: true })).use(new Export());
    graph.on('node:change:size', ({ node }) => decorateNode(node));
    graph.on('node:change:data', ({ node }) => decorateNode(node));
    graph.on('edge:change:data', ({ edge }) => decorateEdge(edge));
    // X6 temporarily raises a reconnecting edge; enforce the image-first paint order
    // during that gesture too, and when copying or restoring older documents.
    graph.on('edge:change:zIndex', ({ edge }) => { if (edge.getZIndex() !== edgeLayer) edge.setZIndex(edgeLayer, { transient: true }); });
    graph.on('cell:added', ({ cell }) => { if (cell.isNode()) decorateNode(cell); else if (cell.isEdge()) decorateEdge(cell); updateStats(); });
    graph.on('cell:removed', () => { transform.clearWidgets(); updateInspector(); updateStats(); });
    graph.on('cell:change:*', ({ options }) => { if (!options?.transient) markDirty(); });
    graph.on('cell:added', markDirty); graph.on('cell:removed', markDirty);
    graph.on('history:change', () => { updateStats(); });
    graph.on('selection:changed', () => updateInspector());
    graph.on('node:click', ({ node, x, y }) => {
      if (presenting || !editable()) return;
      if (mode === 'pin') {
        if (node.getPorts().length >= 64) { status('单张图片最多添加 64 个连接点。', true); return; }
        const box = node.getBBox();
        node.addPort({ id: uid('pin'), group: 'pin', args: { x: Math.max(0, Math.min(100, (x - box.x) / box.width * 100)) + '%', y: Math.max(0, Math.min(100, (y - box.y) / box.height * 100)) + '%' } });
        status('已添加空心圆环连接点。切换“连线”从圆环拉线；选择、展示及导出时隐藏圆环。');
      }
    });
    graph.on('node:dblclick', attempt(async ({ node }) => {
      if (node.getData()?.assetId) await previewNode(node);
      else if (editable()) openPicker(node);
    }));
    graph.on('edge:connected', ({ edge }) => { if (!loading) { decorateEdge(edge); markDirty(); } });
    graph.on('scale', () => { updateStats(); markDirty(); });
    graph.on('translate', () => markDirty());
    graph.on('blank:dblclick', ({ x, y }) => { if (editable() && mode === 'select') select(addNode({ x: x - 130, y: y - 105 })); });
  }
  async function refreshBoards() {
    boards = await store.list();
    $('#wbBoardList').replaceChildren(...boards.map(item => new Option(item.title, item.id)));
    if (board) $('#wbBoardList').value = board.id;
  }
  async function restoreBoard(record) {
    const next = validateBoard(record);
    // Read resources first; a read failure must not discard the current board.
    const images = await Promise.all(assetIds(next).map(id => store.getAsset(id)));
    if (images.some(image => !image)) throw new Error('白板图片资源缺失，请从备份恢复。');
    loading = true; controls();
    graph.cleanSelection(); transform.clearWidgets(); graph.clearCells({ transient: true }); releaseImages();
    for (const image of images) assets.set(image.id, image);
    board = next;
    $('#wbTitle').value = board.title;
    for (const node of board.nodes) addNode(node);
    for (const edge of board.edges) {
      const { color, width, line, arrow, dashed, label } = edge;
      graph.addEdge({ id: edge.id, shape: 'edge', source: edge.source, target: edge.target, vertices: edge.vertices, data: { color, width, line, arrow, dashed, label }, ...edgeConfiguration(edge) });
    }
    graph.zoomTo(board.viewport.zoom); graph.translate(board.viewport.x, board.viewport.y);
    history.clean(); dirty = false; revision = 0; loading = false; updateStats(); updateInspector(); setMode('select');
    $('#wbBoardList').value = board.id;
    saveState('已自动保存 · 本机浏览器');
    try { localStorage.setItem('prompt-studio-last-board', board.id); } catch { /* Selection is optional. */ }
  }
  async function switchBoard(id) {
    if (switching || working || !id || id === board?.id) return;
    switching = true; controls();
    try {
      if (!(await flush())) { $('#wbBoardList').value = board.id; return; }
      const next = await store.get(id);
      if (!next) throw new Error('白板已不存在，请刷新后重试。');
      await restoreBoard(next); status();
    } finally { switching = false; $('#wbBoardList').value = board?.id || ''; controls(); }
  }
  async function refreshLibrary() {
    const request = ++libraryRequest;
    const next = await gallery.listArtworks();
    if (request !== libraryRequest) return;
    artworks = next; renderLibrary();
  }
  function renderLibrary(container = $('#wbLibrary'), query = $('#wbSearch').value) {
    const filter = String(query || '').trim().toLowerCase();
    const list = artworks.filter(item => [item.prompt, item.shotTitle, item.seriesTitle].join(' ').toLowerCase().includes(filter));
    const fragment = document.createDocumentFragment();
    for (const item of list) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'wb-artwork'; button.draggable = true; button.dataset.wbArtwork = item.id;
      const name = item.shotTitle || item.prompt || '未命名作品';
      button.title = name; button.setAttribute('aria-label', '使用图片：' + name.slice(0, 80));
      const image = document.createElement('img'); image.src = item.src; image.alt = ''; image.loading = 'lazy'; image.draggable = false;
      const label = document.createElement('span'); label.textContent = name.slice(0, 40);
      button.append(image, label);
      button.addEventListener('click', attempt(async () => {
        if (!editable()) return;
        const target = pickerTarget || (selectedCell?.isNode() && !selectedCell.getData()?.assetId ? selectedCell : null);
        if (target && !graph.hasCell(target.id)) throw new Error('要替换的图片节点已被删除。');
        await useArtwork(item, target);
        closePicker();
      }));
      button.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-prompt-studio-artwork', item.id); event.dataTransfer.effectAllowed = 'copy'; });
      fragment.append(button);
    }
    container.replaceChildren(fragment);
    if (container === $('#wbLibrary')) {
      $('#wbLibraryEmpty').hidden = list.length > 0;
      $('#wbLibraryEmpty').textContent = artworks.length ? '没有找到符合条件的作品。' : '画廊还没有作品。可以先上传图片，或在创作页生成并提交画廊。';
    }
    if (!list.length && container !== $('#wbLibrary')) { const empty = document.createElement('p'); empty.textContent = '没有可用作品。可关闭窗口，在左侧上传图片。'; container.append(empty); }
  }
  async function rasterBlob(source) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(source || '')) throw new Error('图片格式暂不支持，请先下载为 PNG、JPEG 或 WebP。');
    const [header, payload] = source.split(',');
    const raw = atob(payload), data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    return new Blob([data], { type: header.slice(5, header.indexOf(';')) });
  }
  async function useArtwork(item, target = null, position = null) {
    if (!editable()) return;
    working = true; controls();
    try {
      const asset = await imageAsset(await rasterBlob(item.src), item.shotTitle || '画廊图片', item.id);
      assets.set(asset.id, asset); pendingAssets.set(asset.id, asset);
      applyAsset(asset, target, position);
      status('图片已加入白板，已保留独立副本。');
    } finally { working = false; controls(); }
  }
  function applyAsset(asset, target, position) {
    let node;
    graph.batchUpdate('place-image', () => {
      node = target || addNode({ ...position, height: Math.round(Math.max(100, Math.min(4000, 260 * asset.height / asset.width))) });
      node.setData({ ...node.getData(), assetId: asset.id });
    });
    select(node); updateInspector(); markDirty();
  }
  async function uploadFiles(files) {
    if (!editable() || !files.length) return;
    working = true; controls();
    const target = selectedCell?.isNode() && !selectedCell.getData()?.assetId ? selectedCell : null;
    try {
      const prepared = [];
      for (const file of files.slice(0, 20)) prepared.push(await imageAsset(file, file.name));
      const center = graph.getGraphArea().getCenter();
      graph.batchUpdate('upload-images', () => {
        prepared.forEach((asset, index) => {
          assets.set(asset.id, asset); pendingAssets.set(asset.id, asset);
          applyAsset(asset, index === 0 ? target : null, { x: center.x - 130 + index % 4 * 45, y: center.y - 105 + Math.floor(index / 4) * 45 });
        });
      });
      status('已添加 ' + prepared.length + ' 张图片。');
    } finally { working = false; controls(); }
  }
  function makeDialog(title) {
    const dialog = document.createElement('dialog'); dialog.className = 'wb-dialog';
    const header = document.createElement('div'); header.className = 'wb-dialog-heading';
    const heading = document.createElement('h3'); heading.id = uid('dialog'); heading.textContent = title;
    dialog.setAttribute('aria-labelledby', heading.id);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭'); close.addEventListener('click', () => dialog.close());
    header.append(heading, close); dialog.append(header); root.append(dialog);
    dialog.addEventListener('close', () => { if (activeDialog === dialog) { activeDialog = null; pickerTarget = null; } dialog.remove(); });
    activeDialog = dialog; return dialog;
  }
  function closePicker() { if (pickerTarget && activeDialog?.open) activeDialog.close(); pickerTarget = null; }
  function openPicker(node) {
    if (!editable()) return;
    activeDialog?.close();
    const dialog = makeDialog('为节点选择图片'); pickerTarget = node;
    const search = document.createElement('input'); search.type = 'search'; search.className = 'wb-search'; search.placeholder = '搜索作品或系列…'; search.setAttribute('aria-label', '搜索可选图片');
    const grid = document.createElement('div'); grid.className = 'wb-library-grid';
    dialog.append(search, grid); renderLibrary(grid, ''); search.addEventListener('input', () => renderLibrary(grid, search.value)); dialog.showModal();
  }
  async function confirmAction(title, message) {
    activeDialog?.close();
    const dialog = makeDialog(title), paragraph = document.createElement('p'), actions = document.createElement('div');
    paragraph.textContent = message; actions.className = 'wb-dialog-actions';
    const cancel = document.createElement('button'), confirm = document.createElement('button');
    cancel.type = confirm.type = 'button'; cancel.textContent = '取消'; confirm.textContent = '确认删除'; confirm.className = 'wb-danger';
    cancel.addEventListener('click', () => dialog.close('cancel')); confirm.addEventListener('click', () => dialog.close('confirm'));
    actions.append(cancel, confirm); dialog.append(paragraph, actions);
    const answer = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
    dialog.showModal(); cancel.focus(); return answer;
  }
  async function previewNode(node) {
    const asset = assets.get(node.getData()?.assetId);
    if (!asset) return;
    const dialog = makeDialog(node.getData()?.caption || '图片预览');
    const image = document.createElement('img'); image.src = assetURL(asset.id, true); image.alt = node.getData()?.caption || '白板图片'; image.style.width = '100%'; image.style.maxHeight = '65vh'; image.style.objectFit = 'contain';
    dialog.append(image); dialog.showModal();
  }
  function removeSelected() {
    if (!editable()) return;
    graph.removeCells(graph.getSelectedCells()); graph.cleanSelection(); transform.clearWidgets(); markDirty(); updateInspector();
  }
  function duplicate() {
    if (!editable()) return;
    const cells = graph.getSelectedCells(); if (!cells.length) return;
    graph.copy(cells); const copies = graph.paste({ offset: 35 });
    graph.resetSelection(copies); markDirty();
  }
  function filename(extension) { return (board.title || '白板').replace(/[\\/:*?"<>|]/g, '_') + '.' + extension; }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const readDataURL = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  async function backup() {
    const current = snapshot();
    const images = await Promise.all(assetIds(current).map(async id => {
      const asset = assets.get(id); if (!asset) throw new Error('图片缺失，不能导出完整备份。');
      return { id, name: asset.name, data: await readDataURL(asset.blob) };
    }));
    return new Blob([JSON.stringify({ format: FORMAT, version: VERSION, board: current, assets: images })], { type: 'application/json' });
  }
  async function exportBoard() {
    if (loading || working) return;
    const type = $('#wbExportType').value;
    working = true; controls();
    try {
      if (type === 'json') { download(await backup(), filename('json')); status('已导出包含图片的白板备份。'); return; }
      if (!graph.getCells().length) throw new Error('白板为空，请先添加图片。');
      const box = graph.getContentBBox();
      if (type === 'png' && (box.width / graph.zoom() > 14000 || box.height / graph.zoom() > 14000 || box.width * box.height / graph.zoom() ** 2 > 32_000_000)) throw new Error('白板范围太大，PNG 导出可能超出浏览器限制。请缩小布局或选择 SVG。');
      graph.cleanSelection(); transform.clearWidgets();
      // The list uses thumbnails; export embeds original pixels, then restores URLs.
      for (const node of graph.getNodes()) if (node.getData()?.assetId) node.attr('image/xlink:href', await readDataURL(assets.get(node.getData().assetId).blob), { transient: true });
      const options = {
        padding: 30, backgroundColor: '#f4f1ea', serializeImages: true, copyStyles: false, ratio: 1, preserveDimensions: true,
        // Editing handles never belong to the exported composition, even when
        // exporting directly from pin/connect mode with copied computed styles.
        beforeSerialize(svg) { for (const port of svg.querySelectorAll('.x6-port')) port.remove(); }
      };
      if (type === 'svg') {
        const data = await graph.toSVGAsync(options); download(new Blob([data], { type: 'image/svg+xml' }), filename('svg'));
      } else {
        const data = await graph.toPNGAsync(options); download(await rasterBlob(data), filename('png'));
      }
      status('已导出白板图片。');
    } finally { for (const node of graph.getNodes()) decorateNode(node); working = false; controls(); }
  }
  async function importFile(file) {
    if (!file || !editable()) return;
    if (file.size > LIMITS.packageBytes) throw new Error('白板备份超过 160 MB，请先拆分白板。');
    working = true; controls();
    try {
      if (!(await flush())) return;
      const data = validatePackage(JSON.parse(await file.text()));
      const importedAssets = [];
      for (const item of data.assets) {
        const asset = await imageAsset(await rasterBlob(item.data), item.name);
        // Preserve IDs referenced by this document; validate content before any write.
        importedAssets.push({ ...asset, id: item.id });
      }
      const imported = cloneImported(data.board);
      // Imported documents must not replace resources already used by other boards.
      const mapping = new Map(importedAssets.map(asset => [asset.id, uid('imported-image')]));
      for (const asset of importedAssets) asset.id = mapping.get(asset.id);
      for (const node of imported.nodes) if (node.assetId) node.assetId = mapping.get(node.assetId);
      await store.save(imported, importedAssets); await refreshBoards(); await restoreBoard(imported);
      status('已导入为新白板，原有白板保持完整。');
    } finally { working = false; controls(); }
  }
  function edgeChanged() {
    if (!editable() || !selectedCell?.isEdge()) return;
    const data = { label: $('#wbEdgeLabel').value, color: $('#wbEdgeColor').value, line: 'straight', width: Number($('#wbEdgeWidth').value), arrow: $('#wbEdgeArrow').checked, dashed: $('#wbEdgeDashed').checked };
    Object.assign(defaults, data, { label: '' }); selectedCell.setData(data, { overwrite: true }); markDirty();
  }
  function fit() { if (graph.getCells().length) graph.zoomToFit({ padding: 50, maxScale: 1.2 }); else { graph.zoomTo(1); graph.translate(0, 0); } }
  function changePresentation() {
    if (loading || working) return;
    presenting = !presenting; root.classList.toggle('is-presenting', presenting);
    $('#wbPresent').textContent = presenting ? '退出展示' : '展示'; $('#wbPresent').setAttribute('aria-pressed', String(presenting));
    graph.cleanSelection(); transform.clearWidgets(); setMode(presenting ? 'pan' : 'select'); resize(); controls();
  }
  let lastCanvasWidth = 0;
  function resize() {
    if (!visible || !graph || !canvas.clientWidth || !canvas.clientHeight) return;
    const oldWidth = lastCanvasWidth;
    lastCanvasWidth = canvas.clientWidth;
    graph.resize(canvas.clientWidth, canvas.clientHeight);
    if (oldWidth > 0 && canvas.clientWidth < oldWidth * 0.75 && !loading) fit();
  }

  initGraph();
  listen('wbNew', async () => {
    if (!editable()) return;
    working = true; controls();
    try {
      if (!(await flush())) return;
      const next = createBoard('灵感白板 ' + (boards.length + 1));
      await store.save(next); await refreshBoards(); await restoreBoard(next); status('新白板已创建。');
    } finally { working = false; controls(); }
  });
  listen('wbBoardList', event => switchBoard(event.target.value), 'change');
  listen('wbDeleteBoard', async () => {
    if (!editable() || !(await confirmAction('删除这个白板？', '将删除“' + board.title + '”的布局与连线。画廊作品不受影响。建议先导出白板备份。'))) return;
    if (!editable()) return;
    working = true; controls();
    try {
      if (!(await flush())) return;
      await store.remove(board.id); await refreshBoards();
      if (!boards.length) { const next = createBoard(); await store.save(next); await refreshBoards(); }
      await restoreBoard(boards[0]); status('白板已删除，画廊作品保留。');
    } finally { working = false; controls(); }
  });
  for (const button of root.querySelectorAll('[data-wb-mode]')) button.addEventListener('click', () => { if (!presenting && editable()) setMode(button.dataset.wbMode); });
  listen('wbAddNode', () => { if (editable()) { setMode('select'); select(addNode()); } });
  listen('wbUndo', () => { if (editable()) { transform.clearWidgets(); graph.undo(); updateInspector(); markDirty(); } });
  listen('wbRedo', () => { if (editable()) { graph.redo(); updateInspector(); markDirty(); } });
  listen('wbRetrySave', async () => {
    if (!board) await initialize();
    else if (await flush()) status('白板已保存。');
  });
  listen('wbZoomIn', () => graph.zoom(0.15)); listen('wbZoomOut', () => graph.zoom(-0.15)); listen('wbFit', fit);
  listen('wbPresent', changePresentation);
  listen('wbFullscreen', async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await root.requestFullscreen(); });
  listen('wbTitle', async () => { if (editable()) { board.title = $('#wbTitle').value.trim() || '未命名白板'; $('#wbTitle').value = board.title; markDirty(); if (await flush()) await refreshBoards(); } }, 'change');
  listen('wbSearch', () => renderLibrary(), 'input');
  listen('wbReplace', () => { if (selectedCell?.isNode()) openPicker(selectedCell); });
  listen('wbPreview', () => selectedCell?.isNode() && previewNode(selectedCell));
  listen('wbNodeTitle', () => { if (editable() && selectedCell?.isNode()) selectedCell.setData({ ...selectedCell.getData(), caption: $('#wbNodeTitle').value }); }, 'change');
  listen('wbNodeFrame', () => { if (editable() && selectedCell?.isNode()) selectedCell.setData({ ...selectedCell.getData(), framed: $('#wbNodeFrame').checked }); }, 'change');
  for (const id of ['wbEdgeLabel', 'wbEdgeColor', 'wbEdgeWidth', 'wbEdgeArrow', 'wbEdgeDashed']) listen(id, edgeChanged, 'change');
  listen('wbRemove', removeSelected); listen('wbDuplicate', duplicate);
  listen('wbFront', () => { if (editable() && selectedCell) selectedCell.toFront(); });
  listen('wbClearPins', () => {
    if (!editable() || !selectedCell?.isNode()) return;
    graph.batchUpdate('remove-pins', () => {
      for (const edge of graph.getConnectedEdges(selectedCell)) {
        if (edge.getSourceCellId() === selectedCell.id && edge.getSourcePortId()) edge.setSource({ cell: selectedCell.id });
        if (edge.getTargetCellId() === selectedCell.id && edge.getTargetPortId()) edge.setTarget({ cell: selectedCell.id });
      }
      selectedCell.removePorts();
    }); updateInspector();
  });
  listen('wbUpload', () => $('#wbUploadFile').click());
  listen('wbUploadFile', async event => { const files = [...event.target.files]; event.target.value = ''; await uploadFiles(files); }, 'change');
  listen('wbExport', exportBoard);
  listen('wbImport', () => $('#wbImportFile').click());
  listen('wbImportFile', async event => { const file = event.target.files[0]; event.target.value = ''; await importFile(file); }, 'change');
  canvas.addEventListener('dragover', event => { if (editable()) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  canvas.addEventListener('drop', attempt(async event => {
    event.preventDefault(); if (!editable()) return;
    const id = event.dataTransfer.getData('application/x-prompt-studio-artwork');
    if (id) {
      const item = artworks.find(item => item.id === id); if (!item) return;
      const point = graph.clientToLocal(event.clientX, event.clientY); await useArtwork(item, null, { x: point.x - 130, y: point.y - 105 });
    } else if (event.dataTransfer.files.length) await uploadFiles([...event.dataTransfer.files]);
  }));
  canvas.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select,button') || loading || working) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape' && presenting) { event.preventDefault(); changePresentation(); return; }
    if (presenting) return;
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? graph.redo() : graph.undo(); transform.clearWidgets(); updateInspector(); markDirty(); }
    else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); graph.redo(); updateInspector(); markDirty(); }
    else if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); graph.copy(graph.getSelectedCells()); }
    else if (modifier && event.key.toLowerCase() === 'v') { event.preventDefault(); graph.resetSelection(graph.paste({ offset: 35 })); markDirty(); }
    else if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); graph.resetSelection(graph.getCells()); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
    else if (!modifier && ['v', 'c', 'h', 'p'].includes(event.key.toLowerCase())) { event.preventDefault(); setMode({ v: 'select', c: 'connect', h: 'pan', p: 'pin' }[event.key.toLowerCase()]); }
  });
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  document.addEventListener('fullscreenchange', () => { $('#wbFullscreen').textContent = document.fullscreenElement === root ? '退出全屏' : '全屏'; resize(); });
  document.addEventListener('artgallery:change', () => { if (visible) void attempt(refreshLibrary)(); });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush(); });
  window.addEventListener('pagehide', () => { void flush(); });

  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      loading = true; controls();
      try {
        boards = await store.list();
        if (!boards.length) { const first = createBoard('我的第一块白板'); await store.save(first); boards = [first]; }
        let last; try { last = localStorage.getItem('prompt-studio-last-board'); } catch { /* Optional. */ }
        await refreshBoards(); await restoreBoard(boards.find(item => item.id === last) || boards[0]); status();
      } catch (error) {
        loading = true; controls(); saveState('无法打开白板存储，请重试', true);
        status('白板存储暂时不可用：' + error.message, true);
      }
    })();
    await initializing; initializing = null;
  }
  await initialize();

  return {
    async setVisible(value) {
      visible = value;
      if (value) { resize(); await refreshLibrary(); }
      else { activeDialog?.close(); await flush(); }
    },
    // A narrow diagnostic interface is also useful for deterministic browser regression.
    graph, snapshot, flush,
    get activeBoardId() { return board?.id; },
    dispose() { observer.disconnect(); graph.dispose(); releaseImages(); }
  };
}
