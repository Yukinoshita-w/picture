"""Remote generation download, pending recovery and save-only retry in a browser."""
import json
import time
import urllib.request

from series_test_driver import series_browser, seed_series, open_series, fixture_control
from series_storage_smoke import FAULTS


def main():
    with series_browser('series-remote', FAULTS) as (dev, endpoints):
        seed_series(dev, ('a', 'b', 'c'))

        def stats():
            return json.load(urllib.request.urlopen(endpoints['stats'], timeout=10))

        def wait_download():
            deadline = time.monotonic() + 15
            while not stats().get('heldDownload'):
                assert time.monotonic() < deadline, 'Download was not held'
                time.sleep(.05)

        def idle():
            dev.until('!SeriesPage.state.busy && !SeriesPage.state.generationTask', timeout=30)

        def select(series_id='a'):
            open_series(dev, series_id)
            dev.evaluate("document.querySelector('[data-shot-id=shot_" + series_id + "]').click()")

        def read(series_id='a'):
            return dev.evaluate("testStore.getShot('shot_" + series_id + "')")

        def assets(series_id='a'):
            return dev.evaluate("testStore.listAssets('" + series_id + "')")

        def generate(**download):
            fixture_control(endpoints, 'generation-control', remote=True)
            fixture_control(endpoints, 'download-control', **download)
            dev.evaluate("document.querySelector('[data-action=generate-shot]').click()")
            if download.get('hold'):
                wait_download()
            else:
                idle()

        def retry(**download):
            fixture_control(endpoints, 'download-control', **download)
            dev.evaluate("window.retryButton=document.querySelector('[data-action=retry-generation-save]');retryButton.click()")
            if download.get('hold'):
                wait_download()
            else:
                idle()

        def reload(series_id='a'):
            dev.call('Page.reload')
            dev.until("window.SeriesPage && !document.querySelector('#seriesNew').disabled")
            dev.evaluate('window.testStore=createSeriesStore()')
            select(series_id)

        select()
        dev.evaluate("document.querySelector('#settingsButton').click();"
                     "document.querySelector('#apiUrl').value=" + json.dumps(endpoints['api']) + ";"
                     "document.querySelector('#apiKey').value='test-secret';"
                     "document.querySelector('#model').value='gpt-image-1';"
                     "document.querySelector('#settingsForm').requestSubmit()")
        # Existing local result must stay adopted throughout the download.
        dev.evaluate("document.querySelector('[data-action=generate-shot]').click()")
        idle()
        original = read()['result']
        original_assets = assets()
        generate(hold=True)
        pending = read()['pendingGeneration']
        assert pending['persisted'] and pending['asset']['data'].startswith('http://')
        assert read()['result'] == original and assets() == original_assets
        assert dev.evaluate("document.querySelector('[data-shot-id=shot_a] .series-shot-state').textContent") == '保存中'
        assert dev.evaluate("document.querySelector('[data-action=retry-generation-save]').disabled")
        assert dev.evaluate("document.querySelector('[data-action=delete-shot]').disabled")
        assert 'test-secret' not in json.dumps(pending) and 'apiKey' not in json.dumps(pending)
        dev.evaluate("document.querySelector('#size').value='1536x1024'")
        fixture_control(endpoints, 'download-control', release=True)
        idle()
        saved = read()
        assert saved['status'] == 'done' and saved['pendingGeneration'] is None
        assert saved['result']['parameters'] == pending['result']['parameters']
        assert len(assets()) == 2 and all(asset['data'].startswith('data:image/png;base64,') for asset in assets())
        assert saved['result']['assetId'] in {asset['id'] for asset in assets()} and saved['result']['assetId'] != original['assetId']
        assert saved['generationHistory'] == [original, saved['result']]
        assert stats()['downloadAuth'] is None

        # Expired links leave durable pending metadata and the previous image.
        original = saved['result']
        original_assets = assets()
        generate(fail=True)
        pending = read()['pendingGeneration']
        assert read()['status'] == 'pending-save' and read()['result'] == original
        assert assets() == original_assets and pending['error']
        assert dev.evaluate("document.querySelector('[data-shot-id=shot_a] .series-shot-state').textContent") == '待保存'
        assert dev.evaluate("document.querySelector('[data-action=generate-shot]').disabled")
        assert dev.evaluate("document.querySelector('[data-action=retry-generation-save]') !== null")
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
        dev.evaluate("document.querySelector('[data-testid=pending-generation]').scrollIntoView({block:'center'})")
        assert dev.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        dev.screenshot('series-remote-pending-mobile.png')
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1280, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})
        counts = stats()
        reload()
        assert read()['pendingGeneration'] == pending
        assert stats()['generations'] == counts['generations'] and stats()['downloads'] == counts['downloads']
        # Retrying works without model credentials; it only calls the download route.
        dev.evaluate("document.querySelector('#apiKey').value='';document.querySelector('#model').value=''")
        for failure in ({'unsupported': True}, {'corrupt': True}):
            retry(**failure)
            assert read()['pendingGeneration']['id'] == pending['id']
            assert read()['result'] == original and assets() == original_assets
            assert stats()['generations'] == counts['generations']

        # Rollback of final commit preserves the pending record and old result.
        for fault in ('quota', 'history'):
            dev.evaluate('window.storageFault=' + json.dumps(fault) + ';window.storageInjected=false')
            retry()
            assert dev.evaluate('storageInjected')
            assert read()['pendingGeneration']['id'] == pending['id'] and read()['result'] == original
            assert assets() == original_assets
            assert stats()['generations'] == counts['generations']

        # Export/import a pending response; retry only the copy without touching A.
        dev.evaluate("(async()=>{const bundle=await testStore.readSeriesBundle('a');"
                     "const payload=JSON.parse(JSON.stringify(SeriesEngine.exportSeries(bundle)));"
                     "const restored=SeriesEngine.normalizeImportedSeries(payload,{newId:'copy'});"
                     "await testStore.replaceSeriesBundle(restored);await SeriesPage.activate();})()")
        open_series(dev, 'copy')
        dev.evaluate("document.querySelector('.series-shot-card').click();window.importedShotId=SeriesPage.state.shots[0].id")
        retry()
        assert dev.evaluate("testStore.getShot(importedShotId).then(s=>s.pendingGeneration===null && s.status==='done')")
        copy_assets = assets('copy')
        assert len(copy_assets) == len(original_assets) + 1 and all(asset['data'].startswith('data:image/') for asset in copy_assets)
        assert read()['result'] == original and read()['pendingGeneration']['id'] == pending['id']
        assert assets() == original_assets and stats()['generations'] == counts['generations']
        dev.evaluate("testStore.deleteSeries('copy').then(()=>SeriesPage.activate())")
        select()

        # A delayed retry cannot submit twice or disturb B's editor.
        retry(hold=True)
        before_downloads = stats()['downloads']
        dev.evaluate("retryButton.dispatchEvent(new MouseEvent('click'))")
        select('b')
        dev.evaluate("window.bInput=document.querySelector('[data-shot-field=title]');"
                     "bInput.value='B 未提交';bInput.dispatchEvent(new Event('input'));"
                     "document.querySelector('#seriesStatus').textContent='B 提示'")
        b_state = dev.evaluate('JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})')
        fixture_control(endpoints, 'download-control', release=True)
        idle()
        assert stats()['downloads'] == before_downloads and stats()['generations'] == counts['generations']
        assert dev.evaluate('JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})') == b_state
        assert dev.evaluate("bInput===document.querySelector('[data-shot-field=title]') && bInput.value==='B 未提交'")
        assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 提示'
        assert read()['pendingGeneration'] is None and read()['status'] == 'done'

        # Refreshing during a download preserves its pending response, without auto retry.
        select()
        dev.evaluate("document.querySelector('#apiKey').value='test-secret';document.querySelector('#model').value='gpt-image-1'")
        generate(hold=True)
        interrupted = read()['pendingGeneration']
        count = stats()['generations']
        reload()
        assert read()['pendingGeneration']['id'] == interrupted['id']
        fixture_control(endpoints, 'download-control', release=True)
        retry()
        assert stats()['generations'] == count and read()['pendingGeneration'] is None

        # Saved bytes survive reload and network loss.
        reload()
        dev.call('Network.enable')
        dev.call('Network.emulateNetworkConditions', {'offline': True, 'latency': 0,
                 'downloadThroughput': 0, 'uploadThroughput': 0})
        assert dev.evaluate("(async()=>{const s=await testStore.getShot('shot_a');const a=await testStore.getAsset(s.result.assetId);"
                            "const image=new Image();image.src=a.data;await image.decode();return image.naturalWidth>0})()")
        dev.call('Network.emulateNetworkConditions', {'offline': False, 'latency': 0,
                 'downloadThroughput': -1, 'uploadThroughput': -1})

        # Legacy URL assets can be localized manually, without a model request.
        legacy_version = read()['canonVersion']
        dev.evaluate("(async()=>{const s=await testStore.getShot('shot_a');await testStore.updateAsset(s.result.assetId,'a',"
                     "a=>({...a,data:" + json.dumps(pending['asset']['data']) + "}));"
                     "await testStore.updateShot('shot_a','a',s=>({...s,result:{assetId:s.result.assetId,drift:0}}));})()")
        reload()
        count = stats()['generations']
        dev.evaluate("document.querySelector('[data-action=localize-generation]').click()")
        idle()
        assert dev.evaluate("testStore.getShot('shot_a').then(s=>testStore.getAsset(s.result.assetId)).then(a=>a.data.startsWith('data:image/'))")
        assert stats()['generations'] == count
        assert read()['canonVersion'] == legacy_version

        # A first remote failure has no adopted result or orphan; discard costs no API call.
        select('c')
        dev.evaluate("document.querySelector('#apiKey').value='test-secret';document.querySelector('#model').value='gpt-image-1'")
        fixture_control(endpoints, 'generation-control', remote=True)
        fixture_control(endpoints, 'download-control', fail=True)
        dev.evaluate("document.querySelector('[data-shot-id=shot_c] input[type=checkbox]').click();"
                     "document.querySelector('#seriesBatchSelected').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until("SeriesPage.state.shots[0].pendingGeneration && !SeriesPage.state.batch && !SeriesPage.state.busy")
        assert read('c')['status'] == 'pending-save' and not read('c').get('result') and assets('c') == []
        dev.until("document.querySelector('#seriesStatus').textContent.includes('1 帧图片待保存')")
        assert dev.evaluate("document.querySelector('#seriesStatus').dataset.type") == 'info'
        count = stats()['generations']
        dev.evaluate("document.querySelector('#seriesBatchSelected').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        assert '检查通过 0 帧，跳过 1 帧' in dev.evaluate("document.querySelector('#seriesConfirmText').textContent")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until('!SeriesPage.state.batch && !SeriesPage.state.batchStarting')
        assert stats()['generations'] == count
        dev.evaluate("document.querySelector('[data-action=discard-pending-generation]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until("!SeriesPage.state.shots[0].pendingGeneration")
        assert read('c')['pendingGeneration'] is None and read('c')['status'] == 'draft'
        assert stats()['generations'] == count

        # If even metadata cannot be stored, retain it in memory across series switches
        # and warn before refresh. Retry can persist it once storage is available.
        dev.evaluate("window.storageFault='unavailable'")
        generate()
        assert not read('c').get('pendingGeneration')
        assert dev.evaluate('SeriesPage.state.shots[0].pendingGeneration.persisted') is False
        assert '请勿刷新' in dev.evaluate("document.querySelector('[data-testid=pending-generation]').textContent")
        select('b')
        select('c')
        assert dev.evaluate("document.querySelector('[data-action=retry-generation-save]') !== null")
        dev.evaluate("window.storageFault=''")
        count = stats()['generations']
        retry()
        assert read('c')['status'] == 'done' and read('c')['pendingGeneration'] is None
        assert stats()['generations'] == count

        # A target deleted outside the current page must never be resurrected.
        generate(hold=True)
        before_delete = assets('c')
        dev.evaluate("testStore.deleteShot('shot_c')")
        fixture_control(endpoints, 'download-control', release=True)
        idle()
        assert read('c') is None and assets('c') == before_delete
        print('PASS: remote local bytes, pending recovery/import, expired/corrupt/unsupported downloads, save-only retry, '
              'quota/transaction rollback, volatile metadata, B isolation, refresh, offline decode, legacy URL, '
              'batch pending notice, mobile, discard, deleted target')


if __name__ == '__main__':
    main()
