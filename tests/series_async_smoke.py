"""Read/upload isolation with delayed reads, image decoding, and real IndexedDB."""
from series_test_driver import series_browser, seed_series, open_series

GATES = r"""
  window.readGates = new Map();
  window.bitmapGates = [];
  Object.defineProperty(window, 'createSeriesStore', {configurable:true, set(base) {
    window.testBaseStore = base;
    Object.defineProperty(window, 'createSeriesStore', {value:() => {
      const store = base();
      const read = store.readSeriesBundle;
      store.readSeriesBundle = async id => {
        const result = await read(id);
        const gate = readGates.get(id);
        if (gate) { gate.started = true; await new Promise(resolve => {gate.release = resolve;}); }
        if (gate?.fail) throw new Error('delayed read failure');
        return result;
      };
      return store;
    }});
  }});
  const bitmap = window.createImageBitmap.bind(window);
  window.createImageBitmap = async (...args) => {
    if (window.holdBitmap) {
      window.holdBitmap = false;
      await new Promise(resolve => bitmapGates.push(resolve));
    }
    return bitmap(...args);
  };
"""


def upload(dev, name, color='red', hold=True):
    dev.evaluate("""
      (() => {
        const canvas = document.createElement('canvas'); canvas.width=32; canvas.height=32;
        const ctx = canvas.getContext('2d'); ctx.fillStyle=COLOR; ctx.fillRect(0,0,32,32);
        const raw=atob(canvas.toDataURL('image/png').split(',')[1]);
        const file=new File([Uint8Array.from(raw,c=>c.charCodeAt(0))],NAME,{type:'image/png'});
        const transfer=new DataTransfer(); transfer.items.add(file);
        window.holdBitmap=HOLD;
        const input=document.querySelector('#seriesGalleryInput'); input.files=transfer.files;
        input.dispatchEvent(new Event('change'));
      })()
    """.replace('COLOR', repr(color)).replace('NAME', repr(name)).replace('HOLD', 'true' if hold else 'false'))
    if hold:
        dev.until('bitmapGates.length > 0')


def main():
    with series_browser('series-async', GATES) as (dev, endpoints):
        seed_series(dev)
        open_series(dev, 'b')
        dev.evaluate("readGates.set('a', {}); document.querySelector('[data-series-id=a] .series-list-open').click()")
        dev.until("readGates.get('a').started")
        # A is delayed; its partial reads must never mix with B's current records.
        assert dev.evaluate("SeriesPage.state.series.id === 'b' && SeriesPage.state.shots.every(s=>s.seriesId==='b') && SeriesPage.state.lore.every(s=>s.seriesId==='b')")
        open_series(dev, 'b')
        dev.evaluate("readGates.get('a').release(); readGates.delete('a')")
        dev.evaluate("testStore.listSeries()")
        assert dev.evaluate("SeriesPage.state.series.id === 'b' && document.querySelector('#seriesName').value === '系列 b'")

        # Late failures cannot overwrite the newer series' status.
        dev.evaluate("readGates.set('a', {fail:true}); document.querySelector('[data-series-id=a] .series-list-open').click()")
        dev.until("readGates.get('a').started")
        open_series(dev, 'b')
        dev.evaluate("document.querySelector('#seriesStatus').textContent='B 状态'; readGates.get('a').release(); readGates.delete('a')")
        dev.evaluate('testStore.listSeries()')
        assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 状态'

        # Upload initiated in A, returned while B is edited: write A only, leave B DOM intact.
        open_series(dev, 'a', 'gallery')
        upload(dev, 'A-red.png')
        open_series(dev, 'b')
        dev.evaluate("document.querySelector('[data-shot-id=shot_b]').click(); window.bInput=document.querySelector('[data-shot-field=title]'); bInput.value='B 未提交'; bInput.dispatchEvent(new Event('input')); document.querySelector('#seriesStatus').textContent='B 提示'; bitmapGates.shift()()")
        dev.until('SeriesPage.state.uploads.size === 0')
        assert len(dev.evaluate("testStore.listAssets('a')")) == 1
        assert len(dev.evaluate("testStore.listAssets('b')")) == 0
        assert dev.evaluate("SeriesPage.state.assets.length === 0 && bInput === document.querySelector('[data-shot-field=title]') && bInput.value === 'B 未提交'")
        assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 提示'
        open_series(dev, 'a', 'gallery')
        assert dev.evaluate("document.querySelectorAll('.series-gallery-card').length") == 1
        upload(dev, 'same-red.png', hold=False)
        dev.until('SeriesPage.state.uploads.size === 0')
        assert len(dev.evaluate("testStore.listAssets('a')")) == 1

        # The same image is allowed in a different series; deduplication uses its owner.
        open_series(dev, 'b', 'gallery')
        upload(dev, 'B-red.png', hold=False)
        dev.until('SeriesPage.state.uploads.size === 0')
        assert len(dev.evaluate("testStore.listAssets('b')")) == 1

        # Returning to A before decoding ends updates the fresh A objects once.
        open_series(dev, 'a', 'gallery')
        upload(dev, 'A-blue.png', 'blue')
        open_series(dev, 'b')
        open_series(dev, 'a', 'gallery')
        dev.evaluate('bitmapGates.shift()()')
        dev.until('SeriesPage.state.uploads.size === 0')
        assert dev.evaluate("SeriesPage.state.assets.length") == 2
        assert dev.evaluate("document.querySelectorAll('.series-gallery-card').length") == 2

        # Two uploads finishing together cannot bypass per-series duplicate checks.
        upload(dev, 'orange-1.png', 'orange')
        upload(dev, 'orange-2.png', 'orange')
        dev.evaluate('bitmapGates.splice(0).forEach(release=>release())')
        dev.until('SeriesPage.state.uploads.size === 0')
        assert len(dev.evaluate("testStore.listAssets('a')")) == 3

        # A failed multi-store deletion must roll back records already deleted in its transaction.
        before_delete = dev.evaluate("testStore.readSeriesBundle('a').then(bundle=>JSON.stringify(bundle))")
        aborted = dev.evaluate("""
          (async () => {
            const rawDelete=IDBObjectStore.prototype.delete;
            let injected=false;
            IDBObjectStore.prototype.delete=function(key) {
              const request=rawDelete.call(this,key);
              if (this.name==='assets' && !injected) {
                injected=true;
                request.addEventListener('success',()=>this.transaction.abort(),{once:true});
              }
              return request;
            };
            try { await testStore.deleteSeries('a'); return false; }
            catch { return injected; }
            finally { IDBObjectStore.prototype.delete=rawDelete; }
          })()
        """)
        assert aborted
        assert dev.evaluate("testStore.readSeriesBundle('a').then(bundle=>JSON.stringify(bundle))") == before_delete

        # Gallery promotion also finishes in its new series after the user opens B.
        dev.evaluate("window.holdBitmap=true; window.composePromise=SeriesPage.composeFromGallery([{src:SeriesPage.state.assets[0].data,prompt:'来自画廊'}]); true")
        dev.until('bitmapGates.length > 0')
        promoted_id = dev.evaluate('SeriesPage.state.series.id')
        assert promoted_id not in ('a', 'b')
        open_series(dev, 'b')
        dev.evaluate("document.querySelector('#seriesStatus').textContent='B 继续编辑'; bitmapGates.shift()(); composePromise")
        assert dev.evaluate('SeriesPage.state.series.id') == 'b'
        assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 继续编辑'
        promoted = dev.evaluate("testStore.readSeriesBundle(" + repr(promoted_id) + ")")
        assert len(promoted['shots']) == len(promoted['assets']) == 1
        assert promoted['shots'][0]['seriesId'] == promoted_id
        assert promoted['series']['gallery']['defaults']['style'] == promoted['assets'][0]['id']
        assert dev.evaluate("testStore.getSeries('b').then(s=>Object.keys(s.gallery.defaults).length)") == 0
        dev.evaluate("testStore.deleteSeries(" + repr(promoted_id) + ").then(()=>SeriesPage.activate())")
        open_series(dev, 'a', 'gallery')

        # Deleting the upload owner before decoding ends must not recreate it or its assets.
        upload(dev, 'A-green.png', 'green')
        dev.evaluate("document.querySelector('[data-series-id=a] [data-action=delete-series]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until("SeriesPage.state.series === null")
        dev.evaluate('bitmapGates.shift()()')
        dev.until('SeriesPage.state.uploads.size === 0')
        assert dev.evaluate("testStore.getSeries('a')") is None
        assert dev.evaluate("testStore.listAssets('a')") == []
        assert dev.evaluate("testStore.listShots('a')") == []

        # A read already completed in storage cannot restore a series deleted before display.
        dev.evaluate("readGates.set('b', {}); document.querySelector('[data-series-id=b] .series-list-open').click()")
        dev.until("readGates.get('b').started")
        dev.evaluate("document.querySelector('[data-series-id=b] [data-action=delete-series]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until("document.querySelectorAll('.series-list-item').length === 0")
        dev.evaluate("readGates.get('b').release(); readGates.delete('b')")
        dev.evaluate('testStore.listSeries()')
        assert dev.evaluate("SeriesPage.state.series === null && document.querySelector('#seriesMain').hidden")
        print('PASS: latest open wins, atomic read snapshot, stale failure, upload owner, fresh objects, per-series dedup, delete during upload/read')


if __name__ == '__main__':
    main()
