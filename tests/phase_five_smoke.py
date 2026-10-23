"""Phase five browser checks use isolated storage and a local text model fixture."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

from phase_five_driver import DevTools, ROOT, OUTPUT


def main():
    OUTPUT.mkdir(exist_ok=True)
    browser_path = next((path for path in [Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'), Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')] if path.exists()), None)
    assert browser_path, 'Chrome or Edge is required'
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    fixture = subprocess.Popen(['node', 'tests/phase-five-fixture.js'], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    browser = None
    dev = None
    try:
        endpoints = json.loads(fixture.stdout.readline())
        profile = OUTPUT / ('phase-five-profile-' + str(os.getpid()))
        browser = subprocess.Popen([str(browser_path), '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + str(profile), 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        deadline = time.monotonic() + 25
        while not (profile / 'DevToolsActivePort').exists():
            assert time.monotonic() < deadline, 'Browser did not start'
            time.sleep(.1)
        port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
        tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json/list'))
        dev = DevTools(next(tab for tab in tabs if tab['type'] == 'page')['webSocketDebuggerUrl'])
        dev.call('Page.enable')
        dev.call('Runtime.enable')
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
        dev.call('Page.navigate', {'url': endpoints['app'] + '/#series'})
        try:
            dev.until('Boolean(window.SeriesPage && window.createSeriesStore)')
        except Exception:
            print(json.dumps(dev.evaluate("({url:location.href,ready:document.readyState,scripts:[...document.scripts].map(s=>s.src),body:document.body?.innerText.slice(0,200)})"), ensure_ascii=True))
            print(json.dumps(dev.errors, ensure_ascii=True))
            raise

        def stats():
            return json.load(urllib.request.urlopen(endpoints['stats']))

        def control(**body):
            request = urllib.request.Request(endpoints['control'], json.dumps(body).encode(), {'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request))

        def click(selector):
            dev.evaluate('document.querySelector(' + json.dumps(selector) + ').click()')

        def split():
            click('#seriesSuggestFrames')
            dev.until("document.querySelector('#seriesSplitDialog').open")
            dev.evaluate("document.querySelector('#seriesSplitCount').value='2';document.querySelector('#seriesSplitCount').dispatchEvent(new Event('input'))")

        def draft():
            dev.until("!SeriesPage.state.splitTask && !document.querySelector('#seriesSplitConfirm').hidden", timeout=30)

        def reload():
            dev.evaluate("window.phaseFiveOldDocument=true")
            dev.call('Page.reload', {'ignoreCache': True})
            dev.until("!window.phaseFiveOldDocument && document.readyState==='complete'")
            dev.until("window.SeriesPage?.state.series?.title === '第五阶段验收' && !SeriesPage.state.openRequest")
            dev.evaluate('window.testStore=createSeriesStore()')

        dev.evaluate("document.querySelector('#optimizerUrl').value=" + json.dumps(endpoints['api']) + ";document.querySelector('#optimizerKey').value='local-test-secret';document.querySelector('#optimizerModel').value='text-test';document.querySelector('#apiKey').value='local-test-secret';document.querySelector('#apiUrl').value=" + json.dumps(endpoints['api']) + ";window.testStore=createSeriesStore()")
        click('#seriesNew')
        dev.evaluate("document.querySelector('#seriesNewName').value='第五阶段验收';document.querySelector('#seriesNewForm').requestSubmit()")
        dev.until("SeriesPage.state.series?.title === '第五阶段验收'")
        source = '# 第一章\r\n开场事件：邮差带着信匣沿河岸启程。\r\n' + ('河岸景物与旅途细节。' * 450) + '\r\n# 第二章\r\n末尾关键事件：邮差在桥头找到铜制信匣，帽子始终戴在头上。'
        dev.evaluate("(async()=>{const s=SeriesPage.state.series;await testStore.putLore([{id:'lore-story',seriesId:s.id,title:'长篇故事',text:" + json.dumps(source) + "}]);await testStore.putShot({id:'existing',seriesId:s.id,order:0,code:'S01',subject:'已有画面',status:'draft',references:[],loreRefs:[]});await testStore.updateSeries(s.id,x=>({...x,canon:{...x.canon,medium:'水彩',anchorSentence:'水彩绘画'}}))})()")
        reload()
        dev.evaluate("document.querySelector('#optimizerUrl').value=" + json.dumps(endpoints['api']) + ";document.querySelector('#optimizerKey').value='local-test-secret';document.querySelector('#optimizerModel').value='text-test'")
        split()
        assert dev.evaluate("document.querySelectorAll('[data-fragment-key]').length") == 2, dev.evaluate("({lore:SeriesPage.state.lore,summary:document.querySelector('#seriesSplitSummary').textContent,html:document.querySelector('#seriesSplitLore').innerHTML,errors:document.querySelector('#seriesStatus').textContent})")
        assert str(len(source)) in dev.evaluate("document.querySelector('#seriesSplitSummary').textContent")
        # Only the tail is selected; it must be read with its actual offset.
        click('#seriesSplitSelectAll')
        dev.evaluate("document.querySelectorAll('[data-fragment-key]')[1].click()")
        click('#seriesSplitStart')
        draft()
        assert stats()['summaries'] == [source[source.index('# 第二章'):]]
        assert '字符' in dev.evaluate("document.querySelector('#seriesSplitDraftShots').textContent")
        assert '桥头找到铜制信匣' in dev.evaluate("document.querySelector('#seriesSplitDraftShots pre').textContent")
        assert dev.evaluate('testStore.listShots(SeriesPage.state.series.id).then(s=>s.length)') == 1
        assert stats()['generations'] == 0
        dev.screenshot('phase-five-tail-draft-desktop.png')
        click('#seriesSplitCancel')
        # A partial failure preserves success, retry submits only the failed fragment.
        split()
        click('#seriesSplitSelectAll')
        control(failTail=True)
        dev.evaluate("document.querySelector('#optimizerModel').value='retry-model'")
        click('#seriesSplitStart')
        dev.until("!SeriesPage.state.splitTask && !document.querySelector('#seriesSplitRetry').hidden")
        assert '1 段摘要失败' in dev.evaluate("document.querySelector('#seriesSplitProgress').textContent")
        before = len(stats()['summaries'])
        control(failTail=False)
        click('#seriesSplitRetry')
        draft()
        assert len(stats()['summaries']) == before + 1
        assert '复用摘要缓存' in dev.evaluate("document.querySelector('#seriesSplitProgress').textContent")
        assert dev.evaluate('testStore.listShots(SeriesPage.state.series.id).then(s=>s.length)') == 1
        # A changed source is rejected atomically before append.
        dev.evaluate("testStore.putLore([{id:'lore-story',seriesId:SeriesPage.state.series.id,title:'长篇故事',text:'已修改'}])")
        click('#seriesSplitConfirm')
        dev.until("document.querySelector('#seriesStatus').textContent.includes('原文已修改')")
        assert dev.evaluate('testStore.listShots(SeriesPage.state.series.id).then(s=>s.length)') == 1
        dev.evaluate("testStore.putLore([{id:'lore-story',seriesId:SeriesPage.state.series.id,title:'长篇故事',text:" + json.dumps(source) + '}])')
        dev.evaluate("document.querySelector('#seriesSplitConfirm').click();document.querySelector('#seriesSplitConfirm').click()")
        dev.until("!document.querySelector('#seriesSplitDialog').open && SeriesPage.state.shots.length===3")
        assert stats()['generations'] == 0
        assert not dev.evaluate("document.querySelector('#seriesConfirmDialog').open")
        assert dev.evaluate("SeriesPage.state.shots.map(s=>s.code)") == ['S01', 'S02', 'S03']
        assert dev.evaluate("testStore.listLore(SeriesPage.state.series.id).then(l=>l[0].text)") == source
        click('[data-shot-id="' + dev.evaluate('SeriesPage.state.shots[2].id') + '"]')
        assert '桥头找到铜制信匣' in dev.evaluate("document.querySelector('.series-preview-lore').textContent")
        select = '.series-lore-range select'
        dev.evaluate("document.querySelector(" + json.dumps(select) + ").value='';document.querySelector(" + json.dumps(select) + ").dispatchEvent(new Event('change'))")
        dev.until("document.querySelector('[data-action=generate-shot]').disabled")
        assert '尚未选择' in dev.evaluate("document.querySelector('.series-lore-excerpt').textContent")
        dev.evaluate("const s=document.querySelector('.series-lore-range select');s.value=s.options[s.options.length-1].value;s.dispatchEvent(new Event('change'))")
        dev.until("document.querySelector('.series-preview-lore').textContent.includes('末尾关键事件')")
        dev.evaluate("document.querySelector('.series-lore-reference .series-source-view').open=true")
        dev.until("Boolean(document.querySelector('.series-source-view mark'))")
        assert dev.evaluate("document.querySelector('.series-lore-reference .series-source-view pre').textContent") == source
        assert '末尾关键事件' in dev.evaluate("document.querySelector('.series-source-view mark').textContent")
        dev.screenshot('phase-five-inspector-desktop.png')
        # Round trip and reload retain confirmed references and exact original text.
        assert dev.evaluate("(async()=>{const bundle=await testStore.readSeriesBundle(SeriesPage.state.series.id);const imported=SeriesEngine.normalizeImportedSeries(SeriesEngine.exportSeries(bundle),{newId:'roundtrip'});const s=imported.shots[2];return s.loreSelections[0].loreId===imported.lore[0].id&&!SeriesEngine.compileShot({canon:imported.series.canon,shot:s,lore:imported.lore}).blocked})()")
        reload()
        assert dev.evaluate('SeriesPage.state.shots.length') == 3
        assert dev.evaluate("SeriesPage.state.shots[2].loreSelections[0].text.includes('末尾关键事件')")
        dev.evaluate("document.querySelector('#optimizerUrl').value=" + json.dumps(endpoints['api']) + ";document.querySelector('#optimizerKey').value='local-test-secret';document.querySelector('#optimizerModel').value='retry-model'")
        split()
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
        assert dev.evaluate("document.querySelector('#seriesSplitDialog').getBoundingClientRect().right<=innerWidth && document.documentElement.scrollWidth<=innerWidth")
        dev.screenshot('phase-five-mobile.png')
        before = len(stats()['summaries'])
        click('#seriesSplitStart')
        draft()
        assert len(stats()['summaries']) == before
        assert dev.evaluate("document.querySelector('#seriesSplitDialog').scrollWidth<=document.querySelector('#seriesSplitDialog').clientWidth")
        dev.screenshot('phase-five-mobile-draft.png')
        click('#seriesSplitCancel')
        # Closing a dialog while a request is in flight must discard the late result.
        control(hold=True)
        dev.evaluate("document.querySelector('#optimizerModel').value='cancel-model'")
        split()
        click('#seriesSplitStart')
        deadline = time.monotonic() + 10
        while len(stats()['summaries']) == before:
            assert time.monotonic() < deadline, 'Summary request did not start'
            time.sleep(.05)
        click('#seriesSplitCancel')
        control(hold=False, release=True)
        dev.until('!SeriesPage.state.splitTask')
        assert dev.evaluate('testStore.listShots(SeriesPage.state.series.id).then(s=>s.length)') == 3
        assert stats()['generations'] == 0
        assert not dev.errors, dev.errors
        print('Phase five browser checks passed: tail input, partial retry/cache, draft confirmation, atomic source validation, no image requests, excerpts, import/reload, desktop/mobile.')
    finally:
        if dev:
            dev.sock.close()
        if browser:
            browser.terminate()
            browser.wait(timeout=15)
        fixture.terminate()
        fixture.wait(timeout=15)


if __name__ == '__main__':
    main()
