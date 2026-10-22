"""Single-frame isolation checks with a real browser and held local API responses."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'test-results'
sys.path.insert(0, str(ROOT / 'checks'))
from browser_driver import DevTools


def main():
    OUTPUT.mkdir(exist_ok=True)
    browser_path = next((path for path in (
        Path(os.environ.get('CHROME_PATH', '')),
        Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
        Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),
    ) if path.is_file()), None)
    if browser_path is None:
        raise RuntimeError('Install Chrome/Edge or set CHROME_PATH')
    profile = OUTPUT / ('series-generation-profile-' + str(os.getpid()))
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    fixture = subprocess.Popen(['node', str(ROOT / 'tests/browser-fixture.js')], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    browser = None
    dev = None
    try:
        endpoints = json.loads(fixture.stdout.readline())
        control_url = endpoints['stats'].replace('/stats', '/generation-control')

        def stats():
            return json.load(urllib.request.urlopen(endpoints['stats'], timeout=10))

        def control(**values):
            request = urllib.request.Request(control_url, data=json.dumps(values).encode(),
                                             headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                assert json.load(response)['ok']

        def held():
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if stats().get('heldGeneration'):
                    return
                time.sleep(.05)
            raise AssertionError('Mock did not receive the generation request')

        browser = subprocess.Popen([str(browser_path), '--headless=new', '--no-first-run',
                                    '--no-default-browser-check', '--disable-background-networking',
                                    '--remote-debugging-port=0', '--user-data-dir=' + str(profile), 'about:blank'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        active_port = profile / 'DevToolsActivePort'
        deadline = time.monotonic() + 25
        while not active_port.exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Browser did not start')
            time.sleep(.15)
        port = active_port.read_text().splitlines()[0]
        tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json/list'))
        dev = DevTools(next(tab for tab in tabs if tab['type'] == 'page')['webSocketDebuggerUrl'])
        dev.call('Page.enable')
        dev.call('Runtime.enable')
        dev.call('Page.navigate', {'url': endpoints['app'] + '#series'})
        dev.until("document.querySelector('#connectionText')?.textContent === '本地服务已连接'")
        dev.until("window.SeriesPage && !document.querySelector('#seriesNew').disabled")

        dev.evaluate("""
          (async () => {
            window.testSeriesStore = createSeriesStore();
            const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
            for (const id of ['a', 'b']) {
              await testSeriesStore.putSeries({id, title:'系列 ' + id, canon:{version:3,medium:'原始胶片',palette:[],terms:{},negative:[]},
                theme:{}, axes:[], gallery:{defaults:{}}, createdAt:1, updatedAt:1});
              await testSeriesStore.putShot({id:'shot_' + id, seriesId:id, order:0, code:'S01',
                title:'画面 ' + id, subject:'原始主体 ' + id, scene:'海边', status:'draft', canonVersion:3,
                references:[{slot:'style',assetId:'ref_' + id,purpose:'style',preserve:'原始质感',change:'背景'}]});
              await testSeriesStore.putAsset({id:'ref_' + id,seriesId:id,role:'style',mime:'image/png',
                data:png,sha256:'hash_' + id,name:'参考 ' + id});
            }
            await SeriesPage.activate();
          })()
        """)

        def open_series(series_id):
            if dev.evaluate("SeriesPage.state.series?.id") != series_id:
                dev.evaluate("document.querySelector('[data-series-id=" + series_id + "] .series-list-open').click()")
            dev.until("SeriesPage.state.series?.id === " + json.dumps(series_id)
                      + " && SeriesPage.state.shots.length === 1 && SeriesPage.state.shots[0].seriesId === "
                      + json.dumps(series_id) + " && document.querySelector('#seriesName').value === '系列 ' + "
                      + json.dumps(series_id))
            dev.evaluate("document.querySelector('[data-series-view=outline]').click(); document.querySelector('[data-shot-id=shot_"
                         + series_id + "]').click()")
            dev.until("document.querySelector('[data-action=generate-shot]') !== null")

        def read_shot(series_id='a'):
            return dev.evaluate("testSeriesStore.getShot('shot_" + series_id + "')")

        def idle():
            dev.until("!SeriesPage.state.busy && !SeriesPage.state.generationTask", timeout=30)

        def launch(**options):
            control(hold=True, **options)
            before = stats()['generations']
            dev.evaluate("window.lastGenerateButton = document.querySelector('[data-action=generate-shot]'); lastGenerateButton.click()")
            held()
            return before

        def mark_b():
            open_series('b')
            dev.evaluate("""
              window.bTitleInput = document.querySelector('[data-shot-field=title]');
              bTitleInput.value = 'B 尚未提交的编辑';
              bTitleInput.dispatchEvent(new Event('input'));
              document.querySelector('#seriesStatus').textContent = 'B 自己的状态';
              document.querySelector('#seriesStatus').hidden = false;
            """)
            return dev.evaluate("JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})")

        def unchanged_b(before):
            assert dev.evaluate("JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})") == before
            assert dev.evaluate("document.querySelector('[data-shot-field=title]') === bTitleInput")
            assert dev.evaluate("bTitleInput.value") == 'B 尚未提交的编辑'
            assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'B 自己的状态'
            assert dev.evaluate("!document.querySelector('[data-action=generate-shot]').disabled")
            assert read_shot('b')['status'] == 'draft'
            assert len(dev.evaluate("testSeriesStore.listAssets('b')")) == 1

        open_series('a')
        dev.evaluate("document.querySelector('#settingsButton').click();"
                     "document.querySelector('#apiUrl').value=" + json.dumps(endpoints['api']) + ";"
                     "document.querySelector('#apiKey').value='test-secret';"
                     "document.querySelector('#model').value='gpt-image-1';"
                     "document.querySelector('#settingsForm').requestSubmit();"
                     "document.querySelector('#size').value='1024x1024';"
                     "document.querySelector('#quality').value='medium';"
                     "document.querySelector('#responseFormat').value='auto'")
        open_series('a')
        original_b = read_shot('b')
        original_prompt = dev.evaluate("document.querySelector('.series-preview-text').textContent")
        before = launch()

        # Repeated events, including an already detached button, cannot submit twice.
        dev.evaluate("lastGenerateButton.click(); lastGenerateButton.dispatchEvent(new MouseEvent('click'))")
        assert dev.evaluate("document.querySelector('[data-action=generate-shot]').disabled")
        assert dev.evaluate("document.querySelector('[data-action=delete-shot]').disabled")
        assert dev.evaluate("document.querySelector('[data-series-id=a] [data-action=delete-series]').disabled")
        assert '生成' in dev.evaluate("document.querySelector('[data-action=delete-shot]').textContent")
        dev.evaluate("document.querySelector('[data-action=delete-shot]').dispatchEvent(new MouseEvent('click'));"
                     "document.querySelector('[data-series-id=a] [data-action=delete-series]').dispatchEvent(new MouseEvent('click'))")
        assert not dev.evaluate("document.querySelector('#seriesConfirmDialog').open")
        assert read_shot()['id'] == 'shot_a'

        # Editing conditions mid-flight affects future requests only.
        dev.evaluate("""
          const input = document.querySelector('[data-shot-field=subject]');
          input.value = '后来修改的主体';
          input.dispatchEvent(new Event('input'));
          input.dispatchEvent(new Event('change'));
          document.querySelector('#size').value = '1536x1024';
          document.querySelector('#quality').value = 'high';
          document.querySelector('#responseFormat').value = 'b64_json';
          document.querySelector('#model').value = 'later-model';
          document.querySelector('[data-series-view=canon]').click();
          const medium = document.querySelector('[data-canon-path=medium]');
          medium.value = '后来修改的媒介';
          medium.dispatchEvent(new Event('input'));
          document.querySelector('#seriesCanonSave').click();
        """)
        dev.until("SeriesPage.state.series.canon.version === 4")
        dev.evaluate("""
          (async () => {
            const shot = await testSeriesStore.getShot('shot_a');
            shot.references[0].preserve = '后来修改的参考要求';
            await testSeriesStore.putShot(shot);
          })()
        """)
        b_before = mark_b()
        assert dev.evaluate("document.querySelector('[data-action=generate-shot]').disabled")
        assert not dev.evaluate("document.querySelector('[data-action=delete-shot]').disabled")
        control(release=True)
        idle()
        unchanged_b(b_before)
        assert stats()['generations'] == before + 1
        assert read_shot('b') == original_b
        a = read_shot()
        assert a['status'] == 'done' and a['subject'] == '后来修改的主体', a
        result = a['result']
        assert a['canonVersion'] == result['canonVersion'] == 3
        assert result['prompt'] == original_prompt
        assert result['parameters']['model'] == 'gpt-image-1'
        assert result['parameters']['size'] == '1024x1024'
        assert result['parameters']['quality'] == 'medium'
        assert result['parameters']['responseFormat'] == 'auto'
        assert result['references'][0]['assetId'] == 'ref_a'
        assert result['references'][0]['preserve'] == '原始质感'
        assert result['references'][0]['sha256'] == 'hash_a'
        assert a['references'][0]['preserve'] == '后来修改的参考要求'
        sent = stats()['lastEdit']
        assert sent['model'] == 'gpt-image-1' and sent['size'] == '1024x1024' and sent['quality'] == 'medium', sent
        assert '原始主体 a' in sent['prompt'] and '后来修改的主体' not in sent['prompt']
        assert all(asset['seriesId'] == 'a' for asset in dev.evaluate("testSeriesStore.listAssets('a')"))
        assert any(asset['shotId'] == 'shot_a' for asset in dev.evaluate("testSeriesStore.listAssets('a')") if asset['role'] == 'output')
        assert 'test-secret' not in json.dumps(a) and 'apiKey' not in json.dumps(result)

        # A delayed failure must remain in A and leave B's DOM and data alone.
        open_series('a')
        before = launch(fail=True)
        b_before = mark_b()
        control(release=True)
        idle()
        unchanged_b(b_before)
        assert stats()['generations'] == before + 1
        assert read_shot()['status'] == 'failed'
        assert read_shot()['result'] == result
        assert len(dev.evaluate("testSeriesStore.listAssets('a')")) == 2

        # Reopening A while pending uses new objects; preserve its latest inputs.
        open_series('a')
        before = launch()
        open_series('b')
        open_series('a')
        assert dev.evaluate("document.querySelector('[data-action=delete-shot]').disabled")
        assert dev.evaluate("document.querySelector('[data-action=generate-shot]').textContent") == '生成中…'
        dev.evaluate("""
          const title = document.querySelector('[data-shot-field=title]');
          title.value = '返回 A 后的编辑';
          title.dispatchEvent(new Event('input'));
          title.dispatchEvent(new Event('change'));
        """)
        control(release=True)
        idle()
        assert read_shot()['title'] == '返回 A 后的编辑'
        assert read_shot()['canonVersion'] == 4
        assert read_shot()['result']['parameters']['model'] == 'later-model'
        assert dev.evaluate("document.querySelector('.series-result img') !== null")
        assert not dev.evaluate("document.querySelector('[data-action=delete-shot]').disabled")
        assert stats()['generations'] == before + 1

        # Closing the inspector and navigating away does not lose task ownership.
        before = launch()
        dev.evaluate("document.querySelector('#seriesInspectorClose').click(); location.hash='create'")
        dev.until("document.querySelector('#seriesPage').hidden")
        control(release=True)
        idle()
        assert read_shot()['status'] == 'done'
        dev.evaluate("location.hash='series'")
        dev.until("!document.querySelector('#seriesPage').hidden && document.querySelector('[data-shot-id=shot_a] img') !== null")
        assert dev.evaluate("document.querySelector('#seriesInspector').hidden")
        assert stats()['generations'] == before + 1

        # If B is deleted, there is no current series when A's response arrives.
        open_series('a')
        before = launch()
        open_series('b')
        dev.evaluate("document.querySelector('[data-series-id=b] [data-action=delete-series]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until("SeriesPage.state.series === null")
        control(release=True)
        idle()
        assert read_shot()['status'] == 'done'
        assert stats()['generations'] == before + 1
        assert dev.evaluate("SeriesPage.state.shots.length") == 0
        open_series('a')
        assert dev.evaluate("document.querySelector('.series-result img') !== null")

        # A delete dialog opened before generation must recheck the lock on confirm.
        dev.evaluate("document.querySelector('[data-action=delete-shot]').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open")
        before = launch()
        dev.evaluate("window.deleteDialogClosed=false;"
                     "document.querySelector('#seriesConfirmDialog').addEventListener('close',()=>{window.deleteDialogClosed=true},{once:true});"
                     "document.querySelector('#seriesConfirmOk').click()")
        # close() clears .open before the close event resolves confirmAction.
        # Keep the mock held until the actual confirmation/lock check has run.
        dev.until("window.deleteDialogClosed && !document.querySelector('#seriesConfirmDialog').open")
        assert read_shot()['id'] == 'shot_a'
        control(release=True)
        idle()
        assert read_shot()['status'] == 'done'
        assert stats()['generations'] == before + 1

        # Exercise the JSON generation path as well as multipart reference edits.
        dev.evaluate("""
          const select = document.querySelector('.series-ref-slot select');
          select.value = '';
          select.dispatchEvent(new Event('change'));
        """)
        dev.until("SeriesPage.state.shots[0].references.length === 0")
        before = launch()
        control(release=True)
        idle()
        assert stats()['generations'] == before + 1
        assert read_shot()['result']['references'] == []
        assert stats()['lastBody']['model'] == 'later-model'
        assert read_shot()['result']['parameters']['model'] == stats()['lastBody']['model']

        # Refresh reads the saved result and safe request metadata without migration.
        last_result = read_shot()['result']
        dev.call('Page.reload')
        dev.until("document.querySelector('[data-shot-id=shot_a] img') !== null")
        dev.evaluate("window.testSeriesStore = createSeriesStore()")
        assert read_shot()['result'] == last_result
        assert not dev.errors, dev.errors
        print('PASS: held success/failure, A/B data and DOM isolation, prompt/model/parameter/reference/version snapshots, '
              'duplicate submission, deletion locks, reopen/edit, navigation, no current series, refresh, no stored credentials')
    except Exception:
        if dev:
            print('Failure context:', ascii(dev.evaluate("({status:document.querySelector('#seriesStatus')?.textContent,busy:SeriesPage.state.busy,series:SeriesPage.state.series?.id,errors:SeriesPage.state.shots.map(s=>({id:s.id,status:s.status}))})")))
            print('Browser errors:', dev.errors)
        raise
    finally:
        if dev:
            dev.sock.close()
        for process in [browser, fixture]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == '__main__':
    main()
