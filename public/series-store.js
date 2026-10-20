(function (root) {
  'use strict';

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

    // ---------------------------------------------------------------- series

    function listSeries() {
      return guarded(() => withStore('series', 'readonly', store => store.getAll()))
        .then(items => items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    }

    function getSeries(id) {
      return guarded(() => withStore('series', 'readonly', store => store.get(id)));
    }

    function putSeries(series) {
      return guarded(() => withStore('series', 'readwrite', store => store.put(series)));
    }

    // Deleting a series must not leave orphaned images behind.
    function deleteSeries(id) {
      return guarded(async () => {
        for (const name of ['assets', 'shots', 'runs', 'lore', 'extractions']) {
          await withStore(name, 'readwrite', store => {
            const index = store.index('seriesId');
            const request = index.openKeyCursor(IDBKeyRange.only(id));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return;
              store.delete(cursor.primaryKey);
              cursor.continue();
            };
            return null;
          });
        }
        await withStore('series', 'readwrite', store => store.delete(id));
      });
    }

    // ---------------------------------------------------------------- shots

    function listShots(seriesId) {
      return guarded(() => withStore('shots', 'readonly', store => store.index('seriesId').getAll(IDBKeyRange.only(seriesId))))
        .then(items => items.sort((a, b) => (a.order ?? a.index ?? 0) - (b.order ?? b.index ?? 0)));
    }
    function putShot(shot) {
      return guarded(() => withStore('shots', 'readwrite', store => store.put(shot)));
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
      return guarded(() => withStore('extractions', 'readwrite', store => store.put(record)));
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
      putSeries,
      deleteSeries,
      listShots,
      putShot,
      putShots,
      deleteShot,
      listAssets,
      getAsset,
      putAsset,
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
