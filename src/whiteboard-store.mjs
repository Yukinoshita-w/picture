import { validateBoard, assetIds, uid, LIMITS } from './whiteboard-model.mjs';

export function createWhiteboardStore() {
  let connection;
  let queue = Promise.resolve();
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('prompt-studio-whiteboards', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('boards', { keyPath: 'id' });
        request.result.createObjectStore('assets', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
      request.onerror = () => { connection = null; reject(request.error); };
      request.onblocked = () => { connection = null; reject(new Error('白板存储被其他标签页占用，请关闭其他页面后重试。')); };
    });
    return connection;
  }
  async function transaction(names, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let result;
      try { result = action(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result?.result);
      tx.onerror = tx.onabort = () => reject(tx.whiteboardError || tx.error || new Error('白板保存失败，请重试。'));
    });
  }
  const write = action => {
    const pending = queue.then(action);
    queue = pending.catch(() => {});
    return pending;
  };
  return {
    async list() {
      await queue;
      const items = await transaction(['boards'], 'readonly', tx => tx.objectStore('boards').getAll());
      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) { await queue; return transaction(['boards'], 'readonly', tx => tx.objectStore('boards').get(id)); },
    async getAsset(id) { await queue; return transaction(['assets'], 'readonly', tx => tx.objectStore('assets').get(id)); },
    // One transaction keeps imported image resources and their board inseparable.
    save(input, assets = [], expectedUpdatedAt) {
      const board = validateBoard(input);
      return write(() => transaction(['boards', 'assets'], 'readwrite', tx => {
        if (expectedUpdatedAt !== undefined) {
          const previous = tx.objectStore('boards').get(board.id);
          previous.onsuccess = () => {
            if (!previous.result || previous.result.updatedAt !== expectedUpdatedAt) {
              tx.whiteboardError = new Error('这个白板已在其他标签页修改或删除。请先导出当前白板备份，再刷新页面。');
              tx.abort();
            }
          };
        }
        const images = tx.objectStore('assets');
        for (const asset of assets) images.put(asset);
        // Abort rather than saving a layout that points to an absent image.
        for (const id of assetIds(board)) {
          const request = images.get(id);
          request.onsuccess = () => { if (!request.result) tx.abort(); };
        }
        tx.objectStore('boards').put(board);
      }));
    },
    remove(id) {
      // Preserve assets while this or another editor's undo history may refer to them.
      return write(() => transaction(['boards'], 'readwrite', tx => tx.objectStore('boards').delete(id)));
    }
  };
}

export async function imageAsset(blob, name = '图片', sourceArtworkId = '') {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > LIMITS.imageBytes) throw new Error('请选择 20 MB 以内的 PNG、JPEG 或 WebP 图片。');
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width, height = bitmap.height;
  if (!width || !height || width * height > 80_000_000) { bitmap.close(); throw new Error('图片像素过大，请先缩小后添加。'); }
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const id = 'image_' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const canvas = document.createElement('canvas');
  const ratio = Math.min(1, 640 / Math.max(width, height));
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const thumbnail = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('缩略图创建失败。')), 'image/webp', 0.85));
  return { id, blob, thumbnail, name: String(name).slice(0, 120), sourceArtworkId, width, height, createdAt: Date.now() };
}

export function cloneImported(board) {
  return { ...board, id: uid('board'), title: board.title + ' · 导入', createdAt: Date.now(), updatedAt: Date.now() };
}
