"""Isolated browser and local fixture shared by the series regression scripts."""
from contextlib import contextmanager
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


@contextmanager
def series_browser(name, init_script=None):
    OUTPUT.mkdir(exist_ok=True)
    browser_path = next((path for path in (
        Path(os.environ.get('CHROME_PATH', '')),
        Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
        Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),
    ) if path.is_file()), None)
    if browser_path is None:
        raise RuntimeError('Install Chrome/Edge or set CHROME_PATH')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    fixture = subprocess.Popen(['node', str(ROOT / 'tests/browser-fixture.js')], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    browser = None
    dev = None
    try:
        endpoints = json.loads(fixture.stdout.readline())
        profile = OUTPUT / (name + '-profile-' + str(os.getpid()))
        browser = subprocess.Popen([str(browser_path), '--headless=new', '--no-first-run',
                                    '--no-default-browser-check', '--disable-background-networking',
                                    '--remote-debugging-port=0', '--user-data-dir=' + str(profile), 'about:blank'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        deadline = time.monotonic() + 25
        while not (profile / 'DevToolsActivePort').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Browser did not start')
            time.sleep(.15)
        port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
        tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json/list'))
        dev = DevTools(next(tab for tab in tabs if tab['type'] == 'page')['webSocketDebuggerUrl'])
        dev.call('Page.enable')
        dev.call('Runtime.enable')
        if init_script:
            dev.call('Page.addScriptToEvaluateOnNewDocument', {'source': init_script})
        dev.call('Page.navigate', {'url': endpoints['app'] + '#series'})
        dev.until("document.querySelector('#connectionText')?.textContent === '本地服务已连接'")
        dev.until("window.SeriesPage && !document.querySelector('#seriesNew').disabled")
        dev.evaluate("window.testStore = (window.testBaseStore || createSeriesStore)()")
        yield dev, endpoints
        assert not dev.errors, dev.errors
    except Exception:
        if dev:
            print('Failure context:', ascii(dev.evaluate("({series:SeriesPage.state.series?.id,status:document.querySelector('#seriesStatus')?.textContent,open:SeriesPage.state.openRequest?.id})")))
        raise
    finally:
        if dev:
            dev.sock.close()
        for process in (browser, fixture):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()


def seed_series(dev, ids=('a', 'b')):
    dev.evaluate("""
      (async () => {
        for (const id of IDS) {
          await testStore.putSeries({id,title:'系列 ' + id,theme:{statement:'主题 ' + id},
            canon:{version:1,medium:'媒介 ' + id,palette:[],terms:{},negative:[],lighting:{},lens:{},composition:{},grade:{},material:{}},
            axes:[],gallery:{defaults:{}},createdAt:1,updatedAt:1});
          await testStore.putShot({id:'shot_' + id,seriesId:id,order:0,code:'S01',title:'画面 ' + id,
            subject:'主体 ' + id,status:'draft',references:[],canonVersion:1});
          await testStore.putLore([{id:'lore_' + id,seriesId:id,title:'档案 ' + id,text:'原文 ' + id}]);
        }
        await SeriesPage.activate();
      })()
    """.replace('IDS', json.dumps(ids)))


def open_series(dev, series_id, view='outline'):
    dev.evaluate("document.querySelector('[data-series-id=" + series_id + "] .series-list-open').click()")
    dev.until("!SeriesPage.state.openRequest && SeriesPage.state.series?.id === " + json.dumps(series_id))
    dev.evaluate("document.querySelector('[data-series-view=" + view + "]').click()")


def fixture_control(endpoints, route, **options):
    url = endpoints['stats'].replace('/stats', '/' + route)
    request = urllib.request.Request(url, data=json.dumps(options).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)
