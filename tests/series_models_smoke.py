"""Model-operation ownership, deletion and dialog lifetime regression."""
import json
import time
import urllib.request
from series_test_driver import series_browser, seed_series, open_series, fixture_control


def main():
    with series_browser('series-models') as (dev, endpoints):
        seed_series(dev)
        dev.evaluate("""
          document.querySelector('#optimizerUrl').value=API;
          document.querySelector('#optimizerKey').value='test-secret';
          document.querySelector('#optimizerModel').value='text-model';
          window.testPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
        """.replace('API', json.dumps(endpoints['api'])))

        def stats():
            return json.load(urllib.request.urlopen(endpoints['stats'], timeout=10))

        def arm(phase, fail=False):
            fixture_control(endpoints, 'text-control', phase=phase, hold=True, fail=fail)

        def held(phase):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if stats().get('heldText', {}).get(phase):
                    return
                time.sleep(.05)
            raise AssertionError('Mock did not receive phase: ' + phase)

        def release(phase):
            fixture_control(endpoints, 'text-control', phase=phase, release=True)
            dev.until('SeriesPage.state.modelTasks.size === 0', timeout=30)

        def mark_b():
            open_series(dev, 'b')
            dev.evaluate("""
              document.querySelector('[data-shot-id=shot_b]').click();
              window.bInput=document.querySelector('[data-shot-field=title]');
              bInput.value='B 输入保留'; bInput.dispatchEvent(new Event('input'));
              document.querySelector('#seriesStatus').textContent='B 状态保留';
            """)
            return dev.evaluate("JSON.stringify({series:SeriesPage.state.series,shots:SeriesPage.state.shots,assets:SeriesPage.state.assets,lore:SeriesPage.state.lore})")

        def unchanged_b(before):
            assert dev.evaluate("JSON.stringify({series:SeriesPage.state.series,shots:SeriesPage.state.shots,assets:SeriesPage.state.assets,lore:SeriesPage.state.lore})") == before
            assert dev.evaluate("document.querySelector('[data-shot-field=title]') === bInput && bInput.value === 'B 输入保留'")
            assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 状态保留'

        def expand(fail=False):
            open_series(dev, 'a')
            dev.evaluate("document.querySelector('[data-shot-id=shot_a]').click()")
            arm('shot', fail)
            dev.evaluate("window.oldExpand=document.querySelector('[data-action=expand-shot]'); oldExpand.click(); oldExpand.dispatchEvent(new MouseEvent('click'))")
            held('shot')

        # Successful and failed expansions stay in A; duplicate events submit once.
        calls_before = len([r for r in stats().get('textRequests', []) if r['phase'] == 'shot'])
        expand()
        b_before = mark_b()
        release('shot')
        unchanged_b(b_before)
        assert dev.evaluate("testStore.getShot('shot_a').then(s=>s.subject)") == '林野'
        assert len([r for r in stats()['textRequests'] if r['phase'] == 'shot']) == calls_before + 1
        expand(fail=True)
        b_before = mark_b()
        release('shot')
        unchanged_b(b_before)

        # Closing details keeps expansion running, without reopening its inspector.
        expand()
        dev.evaluate("document.querySelector('#seriesInspectorClose').click()")
        release('shot')
        assert dev.evaluate("document.querySelector('#seriesInspector').hidden")
        assert dev.evaluate("testStore.getShot('shot_a').then(s=>s.subject)") == '林野'

        # A different frame selected while waiting keeps its inspector and unsaved input.
        dev.evaluate("testStore.putShot({id:'shot_a2',seriesId:'a',order:1,code:'S02',title:'第二帧',subject:'第二主体',references:[],status:'draft'})")
        expand()
        dev.evaluate("document.querySelector('[data-shot-id=shot_a2]').click(); window.secondInput=document.querySelector('[data-shot-field=title]'); secondInput.value='第二帧未提交'; secondInput.dispatchEvent(new Event('input'))")
        release('shot')
        assert dev.evaluate("SeriesPage.state.selectedShotId === 'shot_a2' && secondInput === document.querySelector('[data-shot-field=title]') && secondInput.value === '第二帧未提交'")
        dev.evaluate("testStore.deleteShot('shot_a2')")

        # Deleting an expanded frame must not be undone by the response.
        expand()
        dev.evaluate("document.querySelector('[data-action=delete-shot]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until('SeriesPage.state.shots.length === 0')
        release('shot')
        assert dev.evaluate("testStore.getShot('shot_a')") is None
        dev.evaluate("testStore.putShot({id:'shot_a',seriesId:'a',order:0,code:'S01',title:'恢复 A',subject:'新主体',references:[],status:'draft'})")

        # Description persists to the original asset, and preserves newer annotations.
        dev.evaluate("testStore.putAsset({id:'ref_a',seriesId:'a',role:'style',name:'A参考',data:testPng,mime:'image/png',note:''})")
        open_series(dev, 'a', 'gallery')
        arm('describe')
        dev.evaluate("document.querySelector('[data-asset-id=ref_a] [data-action=analyze-asset]').click()")
        held('describe')
        dev.evaluate("testStore.updateAsset('ref_a','a',s=>({...s,name:'等待时改名',note:'手动说明'}))")
        b_before = mark_b()
        release('describe')
        unchanged_b(b_before)
        a = dev.evaluate("testStore.getAsset('ref_a')")
        assert a['analysis']['status'] == 'done' and a['name'] == '等待时改名' and a['note'] == '手动说明'
        assert '媒介 a' in next(r['input'] for r in stats()['textRequests'] if r['phase'] == 'describe')

        # Late description success and failure cannot restore a removed reference.
        for fail in (False, True):
            dev.evaluate("testStore.putAsset({id:'ref_a',seriesId:'a',role:'style',name:'A参考',data:testPng,mime:'image/png',note:''})")
            open_series(dev, 'a', 'gallery')
            arm('describe', fail)
            dev.evaluate("document.querySelector('[data-asset-id=ref_a] [data-action=analyze-asset]').click()")
            held('describe')
            dev.evaluate("testStore.deleteAsset('ref_a')")
            b_before = mark_b()
            release('describe')
            unchanged_b(b_before)
            assert dev.evaluate("testStore.getAsset('ref_a')") is None

        # Extraction finishes in A after switching to B. The original cache is owner-scoped.
        open_series(dev, 'a', 'canon')
        arm('reduce')
        dev.evaluate("document.querySelector('#seriesCanonExtract').click()")
        held('reduce')
        b_before = mark_b()
        release('reduce')
        unchanged_b(b_before)
        assert dev.evaluate("testStore.getSeries('a').then(s=>s.canon.version)") == 2
        assert dev.evaluate("testStore.getSeries('b').then(s=>s.canon.version)") == 1
        dev.until("!document.querySelector('#seriesExtractDialog').open")

        # Closing extraction pauses work; delayed responses do not apply a new version.
        dev.evaluate("testStore.updateSeries('a',s=>({...s,theme:{statement:'新的提炼原文'}}))")
        open_series(dev, 'a', 'canon')
        arm('extract')
        dev.evaluate("document.querySelector('#seriesCanonExtract').click()")
        held('extract')
        dev.evaluate("document.querySelector('#seriesExtractClose').click()")
        release('extract')
        assert dev.evaluate("testStore.getSeries('a').then(s=>s.canon.version)") == 2
        assert '暂停' in dev.evaluate("document.querySelector('#seriesStatus').textContent")

        def split():
            open_series(dev, 'a')
            arm('outline')
            dev.evaluate("document.querySelector('#seriesSuggestFrames').click(); document.querySelector('#seriesSplitStart').click()")
            held('outline')

        # Split results and reference bindings use A's opening snapshot, not B's outline.
        split()
        b_before = mark_b()
        release('outline')
        unchanged_b(b_before)
        assert len(dev.evaluate("testStore.listShots('a')")) > 1
        assert len(dev.evaluate("testStore.listShots('b')")) == 1
        assert not dev.evaluate("document.querySelector('#seriesConfirmDialog').open")
        count = len(dev.evaluate("testStore.listShots('a')"))
        open_series(dev, 'a')
        arm('outline', fail=True)
        dev.evaluate("document.querySelector('#seriesSuggestFrames').click(); document.querySelector('#seriesSplitStart').click()")
        held('outline')
        b_before = mark_b()
        release('outline')
        unchanged_b(b_before)
        assert len(dev.evaluate("testStore.listShots('a')")) == count
        dev.evaluate("document.querySelector('#seriesSplitCancel').click()")
        split()
        assert dev.evaluate("document.querySelector('#seriesSplitCancel').click(); SeriesPage.state.splitTask.cancelled"), 'Cancel must take effect before the asynchronous close event'
        release('outline')
        assert len(dev.evaluate("testStore.listShots('a')")) == count
        assert '取消' in dev.evaluate("document.querySelector('#seriesStatus').textContent")

        # Escape also cancels synchronously before a response can append frames.
        split()
        assert dev.evaluate("document.querySelector('#seriesSplitDialog').dispatchEvent(new Event('cancel',{cancelable:true})); SeriesPage.state.splitTask.cancelled")
        release('outline')
        assert len(dev.evaluate("testStore.listShots('a')")) == count

        # Deleting selected lore during split leaves no dangling lore references.
        split()
        dev.evaluate("testStore.deleteLore('lore_a')")
        b_before = mark_b()
        release('outline')
        unchanged_b(b_before)
        assert dev.evaluate("testStore.listShots('a').then(shots=>shots.filter(s=>s.origin==='split').slice(-3).every(s=>s.loreRefs.length===0))")

        # Delete extraction's owner while the reduction is pending; no cache or series returns.
        dev.evaluate("testStore.updateSeries('a',s=>({...s,theme:{statement:'删除目标的提炼'}}))")
        open_series(dev, 'a', 'canon')
        arm('reduce')
        dev.evaluate("document.querySelector('#seriesCanonExtract').click()")
        held('reduce')
        dev.evaluate("document.querySelector('[data-series-id=a] [data-action=delete-series]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until('SeriesPage.state.series === null')
        release('reduce')
        assert dev.evaluate("testStore.getSeries('a')") is None
        assert dev.evaluate("testStore.listShots('a')") == []
        assert dev.evaluate("testStore.open().then(db=>new Promise(resolve=>{const q=db.transaction('extractions').objectStore('extractions').index('seriesId').getAll('a');q.onsuccess=()=>resolve(q.result.length)}))") == 0
        print('PASS: expansion/description/extraction/split ownership, failures, duplicate model submissions, deleted targets, dialog cancel/pause, scoped caches and source references')


if __name__ == '__main__':
    main()
