"""Generation commits and rollback under injected faults in real IndexedDB."""
import json
import time
import urllib.request

from series_test_driver import series_browser, seed_series, open_series, fixture_control


FAULTS = r"""
  window.storageFault = '';
  window.storageObservations = [];
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(names, mode, ...rest) {
    if (window.storageFault === 'unavailable' && mode === 'readwrite') {
      throw new DOMException('simulated persistent storage failure', 'QuotaExceededError');
    }
    return transaction.call(this, names, mode, ...rest);
  };
  for (const method of ['add', 'put', 'delete']) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function(...args) {
      const tx = this.transaction;
      const generation = tx.mode === 'readwrite' &&
        ['series', 'shots', 'assets'].every(name => tx.objectStoreNames.contains(name));
      if (generation && this.name === 'assets' && method === 'add' && window.storageFault === 'quota') {
        window.storageFault = '';
        window.storageInjected = true;
        throw new DOMException('simulated full storage', 'QuotaExceededError');
      }
      const request = original.apply(this, args);
      if (generation && ((this.name === 'assets' && method === 'add') ||
        (this.name === 'shots' && method === 'put') || (this.name === 'runs' && method === 'put') || (this.name === 'assets' && method === 'delete'))) {
        const stage = method === 'add' ? 'asset' : this.name === 'runs' ? 'run' : method === 'put' ? 'shot' : 'cleanup';
        request.addEventListener('success', () => {
          window.storageObservations.push({stage, result:window.SeriesPage?.state.shots[0]?.result?.assetId || null,
            assets:window.SeriesPage?.state.assets.map(a => a.id)});
          if (window.storageFault === stage || (window.storageFault === 'history' && stage === 'shot' && args[0]?.generationHistory?.length > 1)) {
            window.storageFault = '';
            window.storageInjected = true;
            tx.abort();
          }
        });
      }
      return request;
    };
  }
"""


def main():
    with series_browser('series-storage', FAULTS) as (dev, endpoints):
        seed_series(dev)
        open_series(dev, 'a')
        dev.evaluate("document.querySelector('[data-shot-id=shot_a]').click();"
                     "document.querySelector('#settingsButton').click();"
                     "document.querySelector('#apiUrl').value=" + json.dumps(endpoints['api']) + ";"
                     "document.querySelector('#apiKey').value='test-secret';"
                     "document.querySelector('#model').value='gpt-image-1';"
                     "document.querySelector('#settingsForm').requestSubmit()")

        def read_shot():
            return dev.evaluate("testStore.getShot('shot_a')")

        def generate(fault='', hold=False):
            fixture_control(endpoints, 'generation-control', hold=hold)
            dev.evaluate("window.storageInjected=false; window.storageObservations=[]; window.storageFault="
                         + json.dumps(fault) + "; document.querySelector('[data-action=generate-shot]').click()")
            if hold:
                deadline = time.monotonic() + 15
                while not json.load(urllib.request.urlopen(endpoints['stats'], timeout=10)).get('heldGeneration'):
                    assert time.monotonic() < deadline, 'Generation request was not held'
                    time.sleep(.05)
            else:
                idle()

        def idle():
            dev.until('!SeriesPage.state.busy && !SeriesPage.state.generationTask', timeout=30)

        # A first-generation failure must not leave an orphan or a phantom result.
        generate('shot')
        assert dev.evaluate('storageInjected')
        assert read_shot()['status'] == 'failed' and 'result' not in read_shot()
        assert dev.evaluate("testStore.listAssets('a')") == []
        assert dev.evaluate("!SeriesPage.state.shots[0].result && SeriesPage.state.assets.length === 0")
        assert dev.evaluate("document.querySelector('[data-shot-id=shot_a] .series-shot-state').dataset.state") == 'failed'

        generate()
        old_shot = read_shot()
        old_result = old_shot['result']
        old_id = old_result['assetId']
        old_assets = dev.evaluate("testStore.listAssets('a')")
        assert old_shot['status'] == 'done' and len(old_assets) == 1
        assert old_assets[0]['id'] == old_id and old_assets[0]['data'].startswith('data:image/')
        assert all(item['result'] is None for item in dev.evaluate('storageObservations'))

        # Abort after image/frame/history writes; all versions must roll back together.
        # Each must roll back every generated record while the old result stays visible.
        for fault in ('asset', 'shot', 'history', 'quota', 'unavailable'):
            generate(fault)
            if fault != 'unavailable':
                assert dev.evaluate('storageInjected'), fault
            dev.evaluate("window.storageFault=''")
            shot = read_shot()
            assert shot['result'] == old_result and shot['status'] in ('failed', 'done'), (fault, shot)
            assert dev.evaluate("testStore.listAssets('a')") == old_assets, fault
            assert dev.evaluate('SeriesPage.state.shots[0].result') == old_result, fault
            assert dev.evaluate('SeriesPage.state.shots[0].status') == 'failed', fault
            assert dev.evaluate('SeriesPage.state.assets') == old_assets, fault
            assert dev.evaluate("document.querySelector('.series-result-image').src") == old_assets[0]['data']
            assert '保存失败' in dev.evaluate("document.querySelector('#seriesStatus').textContent")
            assert '原有图片已保留' in dev.evaluate("document.querySelector('#seriesStatus').textContent")
            if fault in ('quota', 'unavailable'):
                assert '存储空间不足' in dev.evaluate("document.querySelector('#seriesStatus').textContent")
            assert all(item['result'] == old_id for item in dev.evaluate('storageObservations'))

        # Rollback state is also intact after reopening and refreshing from disk.
        dev.call('Page.reload')
        dev.until("document.querySelector('[data-shot-id=shot_a] img') !== null")
        dev.evaluate('window.testStore=createSeriesStore()')
        assert read_shot()['result'] == old_result
        assert dev.evaluate("testStore.listAssets('a')") == old_assets
        dev.evaluate("document.querySelector('[data-shot-id=shot_a]').click()")

        # A failed save returning in B must leave B's records, DOM and input alone.
        generate('shot', hold=True)
        open_series(dev, 'b')
        dev.evaluate("document.querySelector('[data-shot-id=shot_b]').click();"
                     "window.bInput=document.querySelector('[data-shot-field=title]');"
                     "bInput.value='B 尚未提交'; bInput.dispatchEvent(new Event('input'));"
                     "document.querySelector('#seriesStatus').textContent='B 提示'")
        b_state = dev.evaluate('JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})')
        fixture_control(endpoints, 'generation-control', release=True)
        idle()
        assert dev.evaluate('storageInjected')
        assert dev.evaluate('JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})') == b_state
        assert dev.evaluate("bInput===document.querySelector('[data-shot-field=title]') && bInput.value==='B 尚未提交'")
        assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 提示'
        assert dev.evaluate("testStore.listAssets('a')") == old_assets

        # Successful retry appends history atomically; edits and older images persist.
        open_series(dev, 'a')
        dev.evaluate("document.querySelector('[data-shot-id=shot_a]').click()")
        generate(hold=True)
        dev.evaluate("const title=document.querySelector('[data-shot-field=title]');"
                     "title.value='保存期间修改标题'; title.dispatchEvent(new Event('input'));"
                     "title.dispatchEvent(new Event('change'))")
        dev.evaluate('testStore.listSeries()')
        fixture_control(endpoints, 'generation-control', release=True)
        idle()
        saved = read_shot()
        assets = dev.evaluate("testStore.listAssets('a')")
        assert saved['status'] == 'done' and saved['title'] == '保存期间修改标题'
        assert saved['result']['assetId'] != old_id
        assert len(assets) == 2 and {asset['id'] for asset in assets} == {old_id, saved['result']['assetId']}
        assert saved['generationHistory'] == [old_result, saved['result']]
        assert dev.evaluate('SeriesPage.state.shots[0].result') == saved['result']
        assert sorted(dev.evaluate('SeriesPage.state.assets'), key=lambda asset: asset['id']) == assets
        assert all(item['result'] == old_id for item in dev.evaluate('storageObservations'))

        # Data survives reload, and the local image can be decoded without network.
        dev.call('Page.reload')
        dev.until("document.querySelector('[data-shot-id=shot_a] img')?.complete")
        dev.evaluate('window.testStore=createSeriesStore()')
        assert read_shot() == saved
        dev.call('Network.enable')
        dev.call('Network.emulateNetworkConditions', {'offline': True, 'latency': 0,
                 'downloadThroughput': 0, 'uploadThroughput': 0})
        assert dev.evaluate("(async()=>{const asset=await testStore.getAsset(" + json.dumps(assets[0]['id'])
                            + ");const image=new Image();image.src=asset.data;await image.decode();return image.naturalWidth>0;})()")
        dev.call('Network.emulateNetworkConditions', {'offline': False, 'latency': 0,
                 'downloadThroughput': -1, 'uploadThroughput': -1})

        # Same-transaction existence checks reject deleted or mismatched targets.
        dev.evaluate("window.newAsset={id:'late_asset',seriesId:'a',shotId:'shot_a',role:'output',data:"
                     + json.dumps(assets[0]['data']) + "};window.newResult={assetId:'late_asset',canonVersion:1}")
        assert dev.evaluate("testStore.saveGeneration({seriesId:'b',shotId:'shot_a',asset:newAsset,result:newResult})") is None
        assert dev.evaluate("testStore.getAsset('late_asset')") is None
        assert dev.evaluate("testStore.saveGeneration({seriesId:'a',shotId:'shot_a',asset:{...newAsset,seriesId:'b'},result:newResult}).then(()=>false,()=>true)")
        assert read_shot() == saved
        assert dev.evaluate("testStore.listAssets('a')") == assets
        # Existing IDs must fail without overwriting the existing image.
        assert dev.evaluate("testStore.saveGeneration({seriesId:'b',shotId:'shot_b',asset:{...newAsset,id:"
                            + json.dumps(assets[0]['id']) + ",seriesId:'b',shotId:'shot_b'},result:{assetId:"
                            + json.dumps(assets[0]['id']) + ",canonVersion:1}}).then(()=>false,()=>true)")
        assert dev.evaluate("testStore.listAssets('a')") == assets
        dev.evaluate("testStore.deleteShot('shot_a')")
        assert dev.evaluate("testStore.saveGeneration({seriesId:'a',shotId:'shot_a',asset:newAsset,result:newResult})") is None
        assert dev.evaluate("testStore.getAsset('late_asset')") is None
        dev.evaluate("testStore.deleteSeries('a')")
        assert dev.evaluate("testStore.saveGeneration({seriesId:'a',shotId:'shot_a',asset:newAsset,result:newResult})") is None
        assert dev.evaluate("testStore.listShots('a')") == []
        assert dev.evaluate("testStore.listAssets('a')") == []
        print('PASS: atomic image/frame/history commit, rollback after each write, quota and persistent failure, '
              'no phantom result/orphan, B isolation, successful retry, edits, refresh, offline image, deleted targets, ID collision')


if __name__ == '__main__':
    main()
