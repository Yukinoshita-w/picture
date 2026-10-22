(function (root) {
  'use strict';

  const Engine = typeof module === 'object' && module.exports ? require('./series-engine') : root.SeriesEngine;

  // Series data lives in its own database so that the existing history and gallery
  // stores keep their schema untouched.
  const DB_NAME = 'prompt-studio-series';
  const DB_VERSION = 1;
  const STORES = {
    series: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },
    assets: { keyPath: 'id', indexes: [['seriesId', 'seriesId'], ['role', 'role'], ['shotId', 'shotId']] },
    shots: { keyPath: 'id', indexes: [['seriesId', 'seriesId'], ['order', 'order']] },
    runs: { keyPath: 'id', indexes: [['seriesId', 'seriesId']] },
    lore: { keyPath: 'id', indexes: [['seriesId', 'seriesId']] },
    extractions: { keyPath: 'id', indexes: [['seriesId', 'seriesId']] }
  };

  function createSeriesStore() {
    let database = null;
    let queue = Promise.resolve();

    function open() {
      if (database) return Promise.resolve(database);
      database = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('当前浏览器不支持 IndexedDB，系列数据无法保存。')); return; }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const [name, spec] of Object.entries(STORES)) {
            const store = db.objectStoreNames.contains(name)
              ? request.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: spec.keyPath });
            for (const [indexName, keyPath] of spec.indexes) {
              if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, { unique: false });
            }
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); database = null; };
          resolve(db);
        };
        request.onerror = () => { database = null; reject(request.error || new Error('无法打开系列数据库')); };
        request.onblocked = () => { database = null; reject(new Error('系列数据库被其他页面占用，请关闭其他标签页后重试。')); };
      });
      return database;
    }

    // Every mutation goes through one queue so that a bulk write cannot interleave with a
    // single-record edit from the UI.
    function enqueue(action) {
      const pending = queue.then(action);
      queue = pending.catch(() => {});
      return pending;
    }

    async function withStore(name, mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(name, mode); }
        catch (error) { reject(error); return; }
        let result;
        try { result = action(tx.objectStore(name)); }
        catch (error) { try { tx.abort(); } catch { /* already settled */ } reject(error); return; }
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
        tx.onerror = () => reject(tx.error || new Error('系列数据读写失败'));
        tx.onabort = () => reject(tx.error || new Error('系列数据操作已取消'));
      });
    }

    function wrapError(error) {
      if (error && error.name === 'QuotaExceededError') {
        return new Error('浏览器存储空间不足，请先导出或删除部分系列的图片。');
      }
      return error;
    }

    function guarded(action) {
      return enqueue(async () => {
        try { return await action(); }
        catch (error) { throw wrapError(error); }
      });
    }

    async function withTransaction(names, mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode);
        const output = {};
        tx.oncomplete = () => resolve(output.value);
        tx.onerror = tx.onabort = () => reject(output.error || tx.error || new Error('系列数据操作已取消'));
        try { action(tx, output); }
        catch (error) { tx.abort(); reject(error); }
      });
    }

    // ---------------------------------------------------------------- series

    function listSeries() {
      return guarded(() => withStore('series', 'readonly', store => store.getAll()))
        .then(items => items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    }

    function getSeries(id) {
      return guarded(() => withStore('series', 'readonly', store => store.get(id)));
    }

    function readSeriesBundle(id) {
      return guarded(() => withTransaction(['series', 'shots', 'assets', 'lore'], 'readonly', (tx, output) => {
        const bundle = output.value = {};
        const series = tx.objectStore('series').get(id);
        series.onsuccess = () => { bundle.series = series.result; };
        for (const name of ['shots', 'assets', 'lore']) {
          const request = tx.objectStore(name).index('seriesId').getAll(IDBKeyRange.only(id));
          request.onsuccess = () => { bundle[name] = request.result; };
        }
      })).then(bundle => {
        bundle.shots.sort((a, b) => (a.order ?? a.index ?? 0) - (b.order ?? b.index ?? 0));
        return bundle;
      });
    }

    function putSeries(series) {
      return guarded(() => withStore('series', 'readwrite', store => store.put(series)));
    }

    // Run the existence check and edit in the same transaction. Late model responses
    // may update an existing target, but must never recreate a deleted owner/record.
    function patchExisting(name, id, seriesId, edit) {
      return guarded(() => withTransaction([...new Set(['series', name])], 'readwrite', (tx, output) => {
        output.value = null;
        const owner = tx.objectStore('series').get(seriesId);
        owner.onsuccess = () => {
          if (!owner.result) return;
          const apply = record => {
            if (!record || (name !== 'series' && record.seriesId !== seriesId)) return;
            try {
              const updated = edit(record);
              if (!updated) return;
              tx.objectStore(name).put(updated);
              output.value = updated;
            } catch (error) { output.error = error; tx.abort(); }
          };
          if (name === 'series') apply(owner.result);
          else {
            const target = tx.objectStore(name).get(id);
            target.onsuccess = () => apply(target.result);
          }
        };
      }));
    }

    function updateSeries(id, edit) { return patchExisting('series', id, id, edit); }
    function updateShot(id, seriesId, edit) { return patchExisting('shots', id, seriesId, edit); }
    function updateAsset(id, seriesId, edit) { return patchExisting('assets', id, seriesId, edit); }

    function appendShots(seriesId, shots, axes = [], accept = () => true, { deduplicateMatrix = false } = {}) {
      return guarded(() => withTransaction(['series', 'shots', 'lore', 'assets'], 'readwrite', (tx, output) => {
        output.value = [];
        const owner = tx.objectStore('series').get(seriesId);
        owner.onsuccess = () => {
          if (!owner.result || !accept()) return;
          const records = tx.objectStore('shots');
          const existing = records.index('seriesId').getAll(IDBKeyRange.only(seriesId));
          const lore = tx.objectStore('lore').index('seriesId').getAllKeys(IDBKeyRange.only(seriesId));
          const assets = tx.objectStore('assets').index('seriesId').getAllKeys(IDBKeyRange.only(seriesId));
          assets.onsuccess = () => {
            if (!accept()) return;
            try {
              const order = existing.result.reduce((max, item) => Math.max(max, item.order ?? item.index ?? 0), -1) + 1;
              const loreIds = new Set(lore.result);
              const assetIds = new Set(assets.result);
              const keys = new Set(deduplicateMatrix ? existing.result.map(shot => Engine.matrixKey(shot.axisValues)) : []);
              const candidates = deduplicateMatrix ? shots.filter(shot => {
                const key = Engine.matrixKey(shot.axisValues);
                if (keys.has(key)) return false;
                keys.add(key);
                return true;
              }) : shots;
              output.value = candidates.map((shot, index) => ({ ...shot, seriesId, order: order + index, index: order + index,
                ...(deduplicateMatrix ? { code: 'S' + String(order + index + 1).padStart(2, '0') } : {}),
                loreRefs: (shot.loreRefs || []).filter(id => loreIds.has(id)),
                references: (shot.references || []).filter(ref => assetIds.has(ref.assetId)) }));
              for (const shot of output.value) deduplicateMatrix ? records.add(shot) : records.put(shot);
              if (axes.length && !owner.result.axes?.length) {
                owner.result.axes = axes;
                tx.objectStore('series').put(owner.result);
              }
            } catch (error) { output.error = error; tx.abort(); }
          };
        };
      }));
    }

    function appendMatrixShots(seriesId, shots) {
      return appendShots(seriesId, shots, [], () => true, { deduplicateMatrix: true });
    }

    // Deleting a series must not leave orphaned images behind.
    function deleteSeries(id) {
      return guarded(() => withTransaction(Object.keys(STORES), 'readwrite', tx => {
        for (const name of ['assets', 'shots', 'runs', 'lore', 'extractions']) {
          const store = tx.objectStore(name);
          const index = store.index('seriesId');
          const request = index.openKeyCursor(IDBKeyRange.only(id));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            store.delete(cursor.primaryKey);
            cursor.continue();
          };
        }
        tx.objectStore('series').delete(id);
      }));
    }

    // ---------------------------------------------------------------- shots

    function listShots(seriesId) {
      return guarded(() => withStore('shots', 'readonly', store => store.index('seriesId').getAll(IDBKeyRange.only(seriesId))))
        .then(items => items.sort((a, b) => (a.order ?? a.index ?? 0) - (b.order ?? b.index ?? 0)));
    }
    function putShot(shot) {
      return guarded(() => withStore('shots', 'readwrite', store => store.put(shot)));
    }

    function getShot(id) {
      return guarded(() => withStore('shots', 'readonly', store => store.get(id)));
    }

    // Publish the image, its frame association and replacement cleanup together.
    // Nothing is returned to the UI until the entire transaction has committed.
    function saveGeneration({ seriesId, shotId, asset, result, pendingId }) {
      return guarded(() => withTransaction(['series', 'shots', 'assets'], 'readwrite', (tx, output) => {
        output.value = null;
        const owner = tx.objectStore('series').get(seriesId);
        owner.onsuccess = () => {
          if (!owner.result) return;
          const shots = tx.objectStore('shots');
          const target = shots.get(shotId);
          target.onsuccess = () => {
            const shot = target.result;
            if (!shot || shot.seriesId !== seriesId) return;
            if (pendingId ? shot.pendingGeneration?.id !== pendingId : shot.pendingGeneration) return;
            try {
              if (!asset?.id || !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(asset.data || '') || asset.seriesId !== seriesId || asset.shotId !== shotId
                || asset.role !== 'output' || result?.assetId !== asset.id || asset.id === shot.result?.assetId) {
                throw new Error('生成图片与目标帧不匹配，未保存。');
              }
              const assets = tx.objectStore('assets');
              const previousAssetId = shot.result?.assetId;
              const saved = { ...shot, result, status: 'done', canonVersion: result.canonVersion ?? shot.canonVersion, updatedAt: Date.now() };
              if (pendingId) saved.pendingGeneration = null;
              // add() also prevents a colliding ID from overwriting another image.
              assets.add(asset);
              shots.put(saved);
              output.value = { shot: saved, removedAssetId: null };
              if (previousAssetId) {
                const previous = assets.get(previousAssetId);
                previous.onsuccess = () => {
                  const old = previous.result;
                  if (old?.seriesId !== seriesId || old.role !== 'output' || (old.shotId && old.shotId !== shotId)) return;
                  try {
                    assets.delete(previousAssetId);
                    output.value.removedAssetId = previousAssetId;
                  } catch (error) { output.error = error; tx.abort(); }
                };
              }
            } catch (error) { output.error = error; tx.abort(); }
          };
        };
      }));
    }

    function putShots(shots) {
      return guarded(() => withStore('shots', 'readwrite', store => {
        for (const shot of shots) store.put(shot);
        return null;
      }));
    }

    function deleteShot(id) {
      return guarded(() => withStore('shots', 'readwrite', store => store.delete(id)));
    }

    // ---------------------------------------------------------------- assets

    function listAssets(seriesId) {
      return guarded(() => withStore('assets', 'readonly', store => store.index('seriesId').getAll(IDBKeyRange.only(seriesId))));
    }

    function getAsset(id) {
      return guarded(() => withStore('assets', 'readonly', store => store.get(id)));
    }

    function putAsset(asset) {
      return guarded(() => withStore('assets', 'readwrite', store => store.put(asset)));
    }

    function addAssetToSeries(asset, { deduplicate = true } = {}) {
      return guarded(() => withTransaction(['series', 'assets'], 'readwrite', (tx, output) => {
        const owner = tx.objectStore('series').get(asset.seriesId);
        owner.onsuccess = () => {
          if (!owner.result) { output.value = { added: false, reason: 'missing' }; return; }
          const assets = tx.objectStore('assets');
          const existing = assets.index('seriesId').getAll(IDBKeyRange.only(asset.seriesId));
          existing.onsuccess = () => {
            if (deduplicate && asset.sha256 && existing.result.some(item => item.sha256 === asset.sha256)) {
              output.value = { added: false, reason: 'duplicate' };
            } else {
              assets.put(asset);
              output.value = { added: true };
            }
          };
        };
      }));
    }

    function deleteAsset(id) {
      return guarded(() => withStore('assets', 'readwrite', store => store.delete(id)));
    }

    // ---------------------------------------------------------------- lore / runs / cache

    function listLore(seriesId) {
      return guarded(() => withStore('lore', 'readonly', store => store.index('seriesId').getAll(IDBKeyRange.only(seriesId))));
    }

    function putLore(items) {
      return guarded(() => withStore('lore', 'readwrite', store => {
        for (const item of items) store.put(item);
        return null;
      }));
    }

    function deleteLore(id) {
      return guarded(() => withStore('lore', 'readwrite', store => store.delete(id)));
    }

    function listRuns(seriesId) {
      return guarded(() => withStore('runs', 'readonly', store => store.index('seriesId').getAll(IDBKeyRange.only(seriesId))))
        .then(items => items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)));
    }

    function putRun(run) {
      return guarded(() => withStore('runs', 'readwrite', store => store.put(run)));
    }

    function getExtraction(id) {
      return guarded(() => withStore('extractions', 'readonly', store => store.get(id)));
    }

    function putExtraction(record) {
      return guarded(() => withTransaction(['series', 'extractions'], 'readwrite', tx => {
        const owner = tx.objectStore('series').get(record.seriesId);
        owner.onsuccess = () => { if (owner.result) tx.objectStore('extractions').put(record); };
      }));
    }

    function deleteExtraction(id) {
      return guarded(() => withStore('extractions', 'readwrite', store => store.delete(id)));
    }

    // ---------------------------------------------------------------- bulk

    function replaceSeriesBundle({ series, shots = [], assets = [], lore = [] }) {
      return guarded(async () => {
        await withStore('series', 'readwrite', store => store.put(series));
        if (shots.length) await withStore('shots', 'readwrite', store => { for (const shot of shots) store.put(shot); return null; });
        if (assets.length) await withStore('assets', 'readwrite', store => { for (const asset of assets) store.put(asset); return null; });
        if (lore.length) await withStore('lore', 'readwrite', store => { for (const item of lore) store.put(item); return null; });
      });
    }

    function estimateUsage() {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return Promise.resolve(null);
      return navigator.storage.estimate().catch(() => null);
    }

    return {
      DB_NAME,
      DB_VERSION,
      STORES,
      open,
      listSeries,
      getSeries,
      readSeriesBundle,
      putSeries,
      updateSeries,
      deleteSeries,
      listShots,
      getShot,
      saveGeneration,
      putShot,
      putShots,
      appendShots,
      appendMatrixShots,
      updateShot,
      deleteShot,
      listAssets,
      getAsset,
      putAsset,
      addAssetToSeries,
      updateAsset,
      deleteAsset,
      listLore,
      putLore,
      deleteLore,
      listRuns,
      putRun,
      getExtraction,
      putExtraction,
      deleteExtraction,
      replaceSeriesBundle,
      estimateUsage
    };
  }

  const api = { createSeriesStore, DB_NAME, DB_VERSION, STORES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.createSeriesStore = createSeriesStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
