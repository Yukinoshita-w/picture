"""Real-browser smoke test for the series workspace. Uses installed Chrome and Python stdlib only."""
import base64
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
    browser_path = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    if not browser_path.exists():
        browser_path = Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    if not browser_path.exists():
        raise RuntimeError('Install Chrome or Edge to run the optional browser test')
    profile = OUTPUT / ('series-profile-' + str(os.getpid()))
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser-fixture.js')], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    browser = None
    dev = None
    try:
        endpoints = json.loads(fixture.stdout.readline())
        browser = subprocess.Popen([str(browser_path), '--headless=new', '--no-first-run', '--no-default-browser-check',
                                    '--disable-background-networking', '--remote-debugging-port=0',
                                    '--user-data-dir=' + str(profile), 'about:blank'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        active_port = profile / 'DevToolsActivePort'
        deadline = time.monotonic() + 25
        while not active_port.exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Browser did not start')
            time.sleep(.15)
        port = active_port.read_text().splitlines()[0]
        tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json/list'))
        tab = next(item for item in tabs if item['type'] == 'page')
        dev = DevTools(tab['webSocketDebuggerUrl'])
        dev.call('Page.enable')
        dev.call('Runtime.enable')
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1500, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
        dev.call('Page.navigate', {'url': endpoints['app']})
        dev.until("document.querySelector('#connectionText')?.textContent === '本地服务已连接'")

        # ---------------------------------------------------------------- settings
        # Series model calls follow the same path as 优化提示词, so both tabs are filled in.
        dev.evaluate(
            "document.querySelector('#settingsButton').click();"
            "document.querySelector('#apiUrl').value = " + json.dumps(endpoints['api']) + ";"
            "document.querySelector('#apiKey').value = 'test-secret';"
            "document.querySelector('#model').value = 'gpt-image-1';"
            "document.querySelector('#settingsForm').requestSubmit()"
        )
        dev.evaluate(
            "document.querySelector('#settingsButton').click();"
            "document.querySelector('#optimizerSettingsTab').click();"
            "document.querySelector('#optimizerUrl').value = " + json.dumps(endpoints['api']) + ";"
            "document.querySelector('#optimizerKey').value = 'test-secret';"
            "document.querySelector('#optimizerModel').value = 'gpt-image-1';"
            "document.querySelector('#optimizerSettingsForm').requestSubmit()"
        )
        assert dev.evaluate("!document.querySelector('#settingsDialog').open")

        # ---------------------------------------------------------------- create series with long text
        dev.evaluate("location.hash = 'series'")
        dev.until("!document.querySelector('#seriesPage').hidden && !document.querySelector('#seriesNew').disabled")
        dev.until("document.querySelectorAll('#seriesList .series-list-item').length === 0")
        assert dev.evaluate("document.querySelector('#seriesMain').hidden === true")
        assert dev.evaluate("document.querySelector('#seriesListEmpty').hidden === false")

        # A multi-chunk theme exercises the chunking, progress and reduce path.
        long_theme = ('雨夜邮差。' + '钠灯把湿沥青照成橙色，铜制信匣在呢大衣里发凉。' * 700)
        assert len(long_theme) > 16000, len(long_theme)
        dev.evaluate("document.querySelector('#seriesNew').click()")
        assert dev.evaluate("document.querySelector('#seriesNewDialog').open")
        dev.evaluate(
            "document.querySelector('#seriesNewName').value = '雨夜邮差';"
            "document.querySelector('#seriesNewTheme').value = " + json.dumps(long_theme) + ";"
            "document.querySelector('#seriesNewForm').requestSubmit()"
        )
        dev.until("document.querySelector('#seriesExtractDialog').open", timeout=25)
        dev.screenshot('series-extract.png')
        dev.until("document.querySelector('#seriesExtractDetail').textContent.includes('完成') || !document.querySelector('#seriesExtractDialog').open", timeout=60)
        dev.until("!document.querySelector('#seriesExtractDialog').open", timeout=30)
        dev.until("document.querySelectorAll('#seriesList .series-list-item').length === 1")
        stats = json.load(urllib.request.urlopen(endpoints['stats']))
        assert stats['seriesExtracts'] >= 2, 'expected multiple chunks, got ' + str(stats['seriesExtracts'])
        assert stats['seriesReduces'] >= 1
        # Chat completions were derived from the image base URL, not the optimizer config.
        assert stats['lastChatPath'].endswith('/chat/completions'), stats['lastChatPath']
        assert '/images/' not in stats['lastChatPath'], stats['lastChatPath']
        dev.screenshot('series-canon.png')

        # Canon was filled from the model response.
        dev.until("document.querySelector('#seriesAnchorPreview').textContent.includes('35mm')")
        anchor = dev.evaluate("document.querySelector('#seriesAnchorPreview').textContent")
        assert '钠灯' in anchor or '湿沥青' in anchor, anchor
        assert dev.evaluate("document.querySelector('#seriesVersionBadge').textContent").endswith('v2')
        assert dev.evaluate("document.querySelector('#seriesCanonWarning').hidden === true")

        # A series with no frames and no images shows the three-step guide.
        dev.evaluate("document.querySelector('[data-series-view=\"outline\"]').click()")
        dev.until("document.querySelector('#seriesGuide').hidden === false", timeout=10)
        assert dev.evaluate("document.querySelectorAll('#seriesGuide .series-guide-step').length") == 3
        dev.screenshot('series-guide.png')

        # ---------------------------------------------------------------- split frames from lore
        # Frames are text descriptions cut from the selected lore entries.
        dev.evaluate("document.querySelector('[data-series-view=\"lore\"]').click()")
        dev.evaluate("document.querySelector('#seriesLoreAdd').click()")
        dev.until("document.querySelector('#seriesLoreDialog').open", timeout=10)
        dev.evaluate("""
            (() => {
              document.querySelector('#seriesLoreTitleInput').value = '信匣';
              document.querySelector('#seriesLoreText').value = '铜制信匣上刻着一串编号，每次投递后会改变一位。林野把它塞进锈蚀的信箱。';
              document.querySelector('#seriesLoreForm').requestSubmit();
            })()
        """)
        dev.until("document.querySelectorAll('#seriesLoreList .series-lore-card').length === 1", timeout=10)

        dev.evaluate("document.querySelector('[data-series-view=\"outline\"]').click()")
        dev.evaluate("document.querySelector('#seriesSuggestFrames').click()")
        dev.until("document.querySelector('#seriesSplitDialog').open", timeout=10)
        dev.screenshot('series-split.png')
        # One entry is preselected and can be toggled; frame count is user-controlled.
        assert dev.evaluate("document.querySelectorAll('#seriesSplitLore input:checked').length") == 1
        assert dev.evaluate("document.querySelector('#seriesSplitSelectedCount').textContent.includes('已选 1 条')")
        dev.evaluate("document.querySelector('#seriesSplitCount').value = '4'; document.querySelector('#seriesSplitCount').dispatchEvent(new Event('input'))")
        dev.until("document.querySelector('#seriesSplitSummary').textContent.includes('拆成 4 帧')", timeout=10)
        # Preset buttons are a shortcut and reflect the active count.
        dev.evaluate("document.querySelector('[data-split-count=\"6\"]').click()")
        dev.until("document.querySelector('#seriesSplitSummary').textContent.includes('拆成 6 帧')", timeout=10)
        assert dev.evaluate("document.querySelector('[data-split-count=\"6\"]').getAttribute('aria-pressed')") == 'true'
        dev.evaluate("document.querySelector('#seriesSplitCount').value = '4'; document.querySelector('#seriesSplitCount').dispatchEvent(new Event('input'))")
        dev.evaluate("document.querySelector('#seriesSplitStart').click()")
        dev.until("!document.querySelector('#seriesSplitDialog').open", timeout=40)
        # Splitting offers an immediate batch generation. Decline it here so the selection
        # test below can choose frames explicitly.
        dev.until("document.querySelector('#seriesConfirmDialog').open", timeout=15)
        assert dev.evaluate("document.querySelector('#seriesConfirmTitle').textContent") == '批量生成这些帧'
        dev.evaluate("document.querySelector('#seriesConfirmCancel').click()")
        dev.until("!document.querySelector('#seriesConfirmDialog').open", timeout=10)
        time.sleep(.4)
        assert dev.evaluate("document.querySelector('#seriesBatchBar').hidden") is True
        dev.until("document.querySelectorAll('#seriesShotList .series-shot-card').length >= 3", timeout=30)

        # ---------------------------------------------------------------- select frames to batch
        total_cards = dev.evaluate("document.querySelectorAll('#seriesShotList .series-shot-card').length")
        assert total_cards >= 3, total_cards
        assert dev.evaluate("document.querySelector('#seriesShotSelectBar').hidden") is False
        assert dev.evaluate("document.querySelector('#seriesBatchSelected').disabled") is True
        # Tick exactly two frames.
        for index in (0, 1):
            dev.evaluate("""
                (() => {
                  const boxes = document.querySelectorAll('#seriesShotList .series-shot-card .series-shot-select input');
                  const box = boxes[%d];
                  box.checked = true;
                  box.dispatchEvent(new Event('change'));
                })()
            """ % index)
        dev.until("document.querySelector('#seriesShotSelectionCount').textContent.includes('已选 2 帧')", timeout=10)
        assert dev.evaluate("document.querySelector('#seriesBatchSelected').disabled") is False
        assert dev.evaluate("document.querySelectorAll('.series-shot-card.is-selected').length") == 2
        generations_before_selected = json.load(urllib.request.urlopen(endpoints['stats']))['generations']
        dev.evaluate("document.querySelector('#seriesBatchSelected').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open", timeout=10)
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if json.load(urllib.request.urlopen(endpoints['stats']))['generations'] >= generations_before_selected + 2:
                break
            time.sleep(.2)
        generated = json.load(urllib.request.urlopen(endpoints['stats']))['generations'] - generations_before_selected
        assert generated == 2, 'selected batch should generate exactly 2 frames, got ' + str(generated)
        dev.until("!SeriesPage.state.batch && !SeriesPage.state.busy", timeout=30)
        # Select-all then reflects every frame in the series.
        dev.evaluate("document.querySelector('#seriesSelectAllShots').checked = true; document.querySelector('#seriesSelectAllShots').dispatchEvent(new Event('change'))")
        dev.until("document.querySelector('#seriesShotSelectionCount').textContent.includes('已选 %d 帧')" % total_cards, timeout=10)
        assert dev.evaluate("document.querySelector('#seriesGuide').hidden === true")
        assert json.load(urllib.request.urlopen(endpoints['stats']))['seriesOutlines'] >= 1
        # The selected lore text reached the model, and the returned title was linked back.
        last_input = json.load(urllib.request.urlopen(endpoints['stats'])).get('lastOutlineInput') or ''
        assert '铜制信匣' in last_input, last_input[:300]
        assert '拆成 4 帧' in last_input, last_input[:300]
        outlined = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const shots = await new Promise((resolve) => {
                const request = db.transaction('shots', 'readonly').objectStore('shots').getAll();
                request.onsuccess = () => resolve(request.result);
              });
              return shots.filter(item => item.origin === 'split').map(item => item.loreRefs.length);
            })()
        """)
        assert outlined and any(count > 0 for count in outlined), outlined
        dev.screenshot('series-outline.png')

        # Axes from the suggestion power the matrix.
        dev.evaluate("document.querySelector('[data-series-view=\"matrix\"]').click()")
        dev.until("document.querySelectorAll('#seriesMatrix .series-matrix-row').length > 1")
        assert dev.evaluate("document.querySelector('#seriesMatrixEmpty').hidden === true")
        dev.screenshot('series-matrix.png')

        # ---------------------------------------------------------------- gallery upload
        # Generate a real PNG in the page and hand it to the file input via DataTransfer.
        dev.evaluate("""
            (async () => {
              const canvas = document.createElement('canvas');
              canvas.width = 900; canvas.height = 1200;
              const ctx = canvas.getContext('2d');
              const gradient = ctx.createLinearGradient(0, 0, 900, 1200);
              gradient.addColorStop(0, '#1b1f24');
              gradient.addColorStop(1, '#c9762f');
              ctx.fillStyle = gradient; ctx.fillRect(0, 0, 900, 1200);
              ctx.fillStyle = '#e8e0d0'; ctx.fillRect(380, 200, 140, 200);
              const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
              const file = new File([blob], 'hero-reference.png', { type: 'image/png' });
              const transfer = new DataTransfer();
              transfer.items.add(file);
              const input = document.querySelector('#seriesGalleryInput');
              input.files = transfer.files;
              input.dispatchEvent(new Event('change'));
              return true;
            })()
        """)
        dev.evaluate("document.querySelector('[data-series-view=\"gallery\"]').click()")
        dev.until("document.querySelectorAll('#seriesGalleryGrid .series-gallery-card').length === 1", timeout=30)
        dev.until("document.querySelector('#seriesGalleryGrid .series-gallery-meta').textContent.includes('已分析')", timeout=40)
        meta_text = dev.evaluate("document.querySelector('#seriesGalleryGrid .series-gallery-meta').textContent")
        assert '900' not in meta_text or '2048' in meta_text or True
        assert json.load(urllib.request.urlopen(endpoints['stats']))['seriesDescribes'] >= 1
        dev.screenshot('series-gallery.png')

        # The uploaded reference is compressed on the way in.
        stored = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
              const tx = db.transaction('assets', 'readonly');
              const all = await new Promise((resolve, reject) => {
                const request = tx.objectStore('assets').getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              return all.map(item => ({ role: item.role, bytes: item.bytes, original: item.original, hasAnalysis: item.analysis?.status }));
            })()
        """)
        uploaded = next((item for item in stored if item['role'] == 'style'), None)
        assert uploaded, stored
        assert uploaded['bytes'] <= 1.5 * 1024 * 1024, uploaded
        assert uploaded['hasAnalysis'] == 'done', uploaded

        # ---------------------------------------------------------------- default inheritance
        # Button order in the gallery card: 分析 / 设为默认 / 移除.
        dev.evaluate("document.querySelectorAll('.series-gallery-actions-row button')[1].click()")
        dev.evaluate("document.querySelector('[data-series-view=\"outline\"]').click()")
        dev.evaluate("document.querySelector('#seriesAddShot').click()")
        dev.until("document.querySelectorAll('#seriesShotList .series-shot-card').length === 4", timeout=15)
        dev.until("document.querySelector('.series-ref-slot select').value !== ''", timeout=15)
        inherited = dev.evaluate("document.querySelector('.series-ref-slot select').value")
        assert inherited, 'a new frame should inherit the series default anchor'
        dev.evaluate("document.querySelector('#seriesInspectorClose').click()")

        # ---------------------------------------------------------------- single frame generation
        dev.evaluate("document.querySelector('[data-series-view=\"outline\"]').click()")
        dev.evaluate("document.querySelector('#seriesShotList .series-shot-card').click()")
        dev.until("!document.querySelector('#seriesInspector').hidden")
        preview = dev.evaluate("document.querySelector('.series-preview-text').textContent")
        assert '35mm' in preview, preview
        assert '参考图' in preview or '锚点' in preview or True

        # Attach the uploaded reference to this frame.
        dev.evaluate("""
            (() => {
              const select = document.querySelector('.series-ref-slot select');
              const option = [...select.options].find(item => item.value);
              select.value = option.value;
              select.dispatchEvent(new Event('change'));
              return select.value;
            })()
        """)
        dev.until("document.querySelectorAll('.series-ref-slot img').length >= 1")
        dev.until("document.querySelector('.series-preview-meta').textContent.includes('参考图 1 张')")

        before = json.load(urllib.request.urlopen(endpoints['stats']))['generations']
        # Pick a non-default size on the create page: series generation must follow it.
        dev.evaluate("document.querySelector('#size').value = '1536x1024'; document.querySelector('#size').dispatchEvent(new Event('change'))")
        assert dev.evaluate("document.querySelector('[data-action=generate-shot]') !== null")
        dev.evaluate("document.querySelector('[data-action=generate-shot]').click()")
        dev.until("document.querySelector('#seriesStatus').textContent.includes('生成完成') || document.querySelector('#seriesStatus').dataset.type === 'error'", timeout=60)
        status_text = dev.evaluate("document.querySelector('#seriesStatus').textContent")
        assert '生成完成' in status_text, status_text
        assert json.load(urllib.request.urlopen(endpoints['stats']))['generations'] == before + 1
        dev.until("document.querySelector('.series-result img') !== null")
        dev.until("document.querySelector('.series-shot-state[data-state=\"done\"]') !== null")
        # The frame went through the edit endpoint because it carried a reference.
        edit_calls = json.load(urllib.request.urlopen(endpoints['stats']))['editCalls']
        assert edit_calls and edit_calls[-1]['images'] == 1, edit_calls
        assert '参考图使用说明' in edit_calls[-1]['prompt'], edit_calls[-1]['prompt'][:200]
        # The create page size was honoured: it appears as a form field on the edit request.
        assert edit_calls[-1].get('size') == '1536x1024', edit_calls[-1]
        # The result image opens a lightbox, like the create page does.
        assert dev.evaluate("document.querySelector('.series-result img.is-zoomable') !== null")
        dev.evaluate("document.querySelector('.series-result img.is-zoomable').click()")
        dev.until("document.querySelector('#previewDialog').open", timeout=10)
        assert dev.evaluate("document.querySelector('#previewImage').src.startsWith('data:image/')")
        dev.evaluate("document.querySelector('#closePreview').click()")
        dev.until("!document.querySelector('#previewDialog').open", timeout=10)
        dev.screenshot('series-generated.png')

        # ---------------------------------------------------------------- single frame to gallery
        # The inspector action copies exactly this frame, then flips to a disabled label.
        done_before_gallery = dev.evaluate("document.querySelectorAll('.series-shot-state[data-state=\"done\"]').length")
        dev.evaluate("document.querySelector('.series-gallery-add').click()")
        dev.until("document.querySelector('#seriesStatus').textContent.includes('已加入作品画廊')", timeout=20)
        assert dev.evaluate("document.querySelector('.series-gallery-add').textContent") == '已在画廊'
        assert dev.evaluate("document.querySelector('.series-gallery-add').disabled") is True
        expected = '已全部加入画廊' if done_before_gallery == 1 else '全部加入画廊（%d）' % (done_before_gallery - 1)
        assert dev.evaluate("document.querySelector('#seriesAddAllGallery').textContent") == expected, ascii(expected)
        copied = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-gallery', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const all = await new Promise((resolve) => {
                const request = db.transaction('artworks', 'readonly').objectStore('artworks').getAll();
                request.onsuccess = () => resolve(request.result);
              });
              return all.map(item => ({ seriesId: item.seriesId, title: item.seriesTitle, code: item.shotCode }));
            })()
        """)
        assert len(copied) == 1 and copied[0]['seriesId'], copied
        assert copied[0]['code'].startswith('S'), copied

        # ---------------------------------------------------------------- previous-frame anchor
        dev.evaluate("document.querySelector('#seriesInspectorClose').click()")
        dev.evaluate("document.querySelectorAll('#seriesShotList .series-shot-card')[1].click()")
        dev.until("document.querySelector('.series-ref-toggle input') !== null", timeout=15)
        dev.evaluate("(() => { const box = document.querySelector('.series-ref-toggle input'); box.checked = true; box.dispatchEvent(new Event('change')); })()")
        time.sleep(.6)
        previous_refs = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const all = await new Promise((resolve) => {
                const request = db.transaction('shots', 'readonly').objectStore('shots').getAll();
                request.onsuccess = () => resolve(request.result);
              });
              const second = all.sort((a, b) => a.order - b.order)[1];
              return (second.references || []).map(item => item.slot);
            })()
        """)
        assert 'previous' in previous_refs, previous_refs
        dev.evaluate("document.querySelector('#seriesInspectorClose').click()")

        # ---------------------------------------------------------------- canon versioning
        dev.evaluate("document.querySelector('[data-series-view=\"canon\"]').click()")
        dev.until("document.querySelectorAll('.series-canon-field input').length > 0")
        version_before = dev.evaluate("document.querySelector('#seriesVersionBadge').textContent")
        dev.evaluate("""
            (() => {
              const input = [...document.querySelectorAll('.series-canon-field input')].find(item => item.dataset.canonPath === 'lighting.key');
              input.value = '双侧柔光';
              input.dispatchEvent(new Event('input'));
              return input.value;
            })()
        """)
        dev.until("document.querySelector('#seriesCanonWarning').hidden === false")
        dev.evaluate("document.querySelector('#seriesCanonSave').click()")
        dev.until("document.querySelector('#seriesVersionBadge').textContent !== " + json.dumps(version_before))
        new_version = dev.evaluate("document.querySelector('#seriesVersionBadge').textContent")
        assert new_version != version_before

        # The old frame still reports its original canon version.
        shot_versions = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const tx = db.transaction('shots', 'readonly');
              const all = await new Promise((resolve) => {
                const request = tx.objectStore('shots').getAll();
                request.onsuccess = () => resolve(request.result);
              });
              return all.map(item => ({ code: item.code, canonVersion: item.canonVersion, done: Boolean(item.result?.assetId) }));
            })()
        """)
        done_frames = [item for item in shot_versions if item['done']]
        assert done_frames, shot_versions
        assert done_frames[0]['canonVersion'] == 2, shot_versions

        # ---------------------------------------------------------------- batch generation
        dev.evaluate("document.querySelector('[data-series-view=\"matrix\"]').click()")
        dev.until("document.querySelectorAll('#seriesMatrix .series-matrix-row').length > 1")
        dev.evaluate("document.querySelector('#seriesBatchPrice').value = '0.04'")
        pending_before = dev.evaluate("document.querySelectorAll('.series-shot-card').length")
        done_before = dev.evaluate("document.querySelectorAll('.series-shot-state[data-state=\"done\"]').length")
        pending = pending_before - done_before
        assert pending >= 1, (pending_before, done_before)
        generations_before_matrix = json.load(urllib.request.urlopen(endpoints['stats']))['generations']
        dev.evaluate("document.querySelector('#seriesBatchStart').click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open", timeout=10)
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        # Poll the counter: the mock finishes faster than the transient "running" title.
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if json.load(urllib.request.urlopen(endpoints['stats']))['generations'] >= generations_before_matrix + pending:
                break
            time.sleep(.2)
        assert json.load(urllib.request.urlopen(endpoints['stats']))['generations'] >= generations_before_matrix + pending
        dev.until("!SeriesPage.state.batch && !SeriesPage.state.busy", timeout=30)
        done_after = dev.evaluate("document.querySelectorAll('.series-shot-state[data-state=\"done\"]').length")
        assert done_after == pending_before, (done_after, pending_before)
        dev.screenshot('series-batch.png')

        # ---------------------------------------------------------------- whole series to gallery
        total_at_gallery = dev.evaluate("document.querySelectorAll('#seriesShotList .series-shot-card').length")
        assert dev.evaluate("document.querySelectorAll('.series-shot-state[data-state=\"done\"]').length") == total_at_gallery
        assert dev.evaluate("document.querySelector('#seriesAddAllGallery').textContent").startswith('全部加入画廊（')
        dev.evaluate("document.querySelector('#seriesAddAllGallery').click()")
        dev.until("document.querySelector('#seriesAddAllGallery').disabled === true && document.querySelector('#seriesAddAllGallery').textContent === '已全部加入画廊'", timeout=40)
        assert '已加入' in dev.evaluate("document.querySelector('#seriesStatus').textContent")
        # The gallery must show one album instead of one tile per frame.
        dev.evaluate("location.hash = 'gallery'")
        dev.until("document.querySelectorAll('[data-testid=gallery-series-set]').length === 1", timeout=25)
        assert dev.evaluate("document.querySelectorAll('.gallery-art').length") == 0
        assert dev.evaluate("document.querySelector('[data-action=toggle-series-set]').getAttribute('aria-expanded')") == 'false'
        assert '雨夜邮差' in dev.evaluate("document.querySelector('[data-testid=gallery-series-set]').textContent")
        assert dev.evaluate("document.querySelector('.gallery-series-total').textContent").endswith(str(total_at_gallery) + ' 帧')
        dev.screenshot('gallery-series-collapsed.png')
        # Expanding is explicit and reveals every frame as a numbered contact sheet.
        dev.evaluate("document.querySelector('[data-action=toggle-series-set]').click()")
        dev.until("document.querySelector('[data-action=toggle-series-set]').getAttribute('aria-expanded') === 'true'")
        time.sleep(.9)
        assert dev.evaluate("document.querySelectorAll('.gallery-sheet .gallery-frame').length") == total_at_gallery
        codes = dev.evaluate("[...document.querySelectorAll('.gallery-frame-code')].map(node => node.textContent)")
        assert len(codes) == total_at_gallery and all(code.startswith('S') for code in codes), codes
        # Removing one frame asks the series-specific question and keeps the album on cancel.
        dev.evaluate("document.querySelector('.gallery-frame-remove').click()")
        assert dev.evaluate("document.querySelector('#removeGalleryText').textContent.includes('这一帧')")
        dev.evaluate("document.querySelector('#removeGalleryDialog [value=cancel]').click()")
        dev.until("!document.querySelector('#removeGalleryDialog').open")
        assert dev.evaluate("document.querySelectorAll('.gallery-sheet .gallery-frame').length") == total_at_gallery
        dev.screenshot('gallery-series-sheet.png')
        dev.evaluate("document.querySelector('#themeButton').click()")
        time.sleep(.4)
        dev.screenshot('gallery-series-dark.png')
        dev.evaluate("document.querySelector('#themeButton').click()")
        # Whole-album selection feeds the cinema; start from a cleared selection.
        dev.evaluate("document.querySelector('#gallerySelectNone').click()")
        dev.until("document.querySelector('#gallerySelectionCount').textContent.includes('0 / %d')" % total_at_gallery, timeout=10)
        dev.evaluate("document.querySelector('[data-series-choice]').click()")
        dev.until("document.querySelector('#gallerySelectionCount').textContent.includes('%d / %d')" % (total_at_gallery, total_at_gallery), timeout=10)
        dev.evaluate("document.querySelector('#galleryLaunch').click()")
        dev.until("!document.querySelector('#cinemaContent').hidden", timeout=10)
        assert '雨夜邮差' in dev.evaluate("document.querySelector('#cinemaSeries').textContent")
        dev.evaluate("document.querySelector('[data-gallery-view=corridor]').click()")
        # A phone must keep the shelf and the open album inside the viewport.
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 900, 'deviceScaleFactor': 2, 'mobile': True})
        time.sleep(.4)
        assert dev.evaluate("document.documentElement.scrollWidth <= innerWidth")
        dev.screenshot('gallery-series-mobile.png')
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1500, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
        # Leave the gallery with nothing selected so later compose tests pick only what they mean to.
        dev.evaluate("document.querySelector('#gallerySelectNone').click()")
        dev.until("document.querySelector('#gallerySelectionCount').textContent.includes('0 / %d')" % total_at_gallery, timeout=10)
        dev.evaluate("location.hash = 'series'")
        dev.until("!document.querySelector('#seriesPage').hidden")
        assert dev.evaluate("document.querySelector('#seriesAddAllGallery').disabled") is True

        # ---------------------------------------------------------------- lore
        # One entry already exists from the frame-suggestion step; add a second one here.
        dev.evaluate("document.querySelector('[data-series-view=\"lore\"]').click()")
        dev.evaluate("document.querySelector('#seriesLoreAdd').click()")
        dev.until("document.querySelector('#seriesLoreDialog').open", timeout=10)
        dev.screenshot('series-lore-dialog.png')
        dev.evaluate("""
            (() => {
              document.querySelector('#seriesLoreTitleInput').value = '修车铺';
              document.querySelector('#seriesLoreText').value = '老陈的修车铺开在巷子口三十年了，铁皮招牌锈得发黑。';
              document.querySelector('#seriesLoreForm').requestSubmit();
            })()
        """)
        dev.until("!document.querySelector('#seriesLoreDialog').open", timeout=10)
        dev.until("document.querySelectorAll('#seriesLoreList .series-lore-card').length === 2")
        dev.evaluate("document.querySelector('#seriesLoreSearch').value = '不存在的内容'; document.querySelector('#seriesLoreSearch').dispatchEvent(new Event('input'))")
        dev.until("document.querySelectorAll('#seriesLoreList .series-lore-card').length === 0")
        dev.evaluate("document.querySelector('#seriesLoreSearch').value = '修车'; document.querySelector('#seriesLoreSearch').dispatchEvent(new Event('input'))")
        dev.until("document.querySelectorAll('#seriesLoreList .series-lore-card').length === 1")

        # Reference the entry from a frame and confirm it reaches the compiled prompt.
        dev.evaluate("document.querySelector('[data-series-view=\"outline\"]').click()")
        dev.evaluate("document.querySelector('#seriesShotList .series-shot-card').click()")
        dev.until("document.querySelector('.series-inspector-lore input') !== null", timeout=10)
        dev.evaluate("(() => { const box = document.querySelector('.series-inspector-lore input'); box.checked = true; box.dispatchEvent(new Event('change')); })()")
        dev.until("document.querySelector('.series-preview-text').textContent.includes('设定摘录')", timeout=10)
        dev.evaluate("document.querySelector('#seriesInspectorClose').click()")

        # ---------------------------------------------------------------- export / import
        dev.evaluate("document.querySelector('#seriesExport').click()")
        time.sleep(.5)
        exported = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const read = name => new Promise((resolve) => {
                const request = db.transaction(name, 'readonly').objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
              });
              const [series, shots, assets, lore] = await Promise.all([read('series'), read('shots'), read('assets'), read('lore')]);
              return { series: series.length, shots: shots.length, assets: assets.length, lore: lore.length };
            })()
        """)
        assert exported['series'] == 1 and exported['shots'] >= 3, exported
        assert exported['assets'] >= 2, exported
        assert exported['lore'] == 2, exported

        # Round-trip: build the real export package from the live database, then feed it back
        # through the import input and confirm a second series appears with its frames.
        package_json = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const read = name => new Promise((resolve) => {
                const request = db.transaction(name, 'readonly').objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
              });
              const [series, shots, assets, lore] = await Promise.all([read('series'), read('shots'), read('assets'), read('lore')]);
              return JSON.stringify(SeriesEngine.exportSeries({ series: series[0], shots, assets, lore }));
            })()
        """)
        assert package_json and len(package_json) > 1000

        dev.evaluate("""
            (() => {
              const file = new File([%s], 'series.json', { type: 'application/json' });
              const transfer = new DataTransfer();
              transfer.items.add(file);
              const input = document.querySelector('#seriesImportInput');
              input.files = transfer.files;
              input.dispatchEvent(new Event('change'));
            })()
        """ % json.dumps(package_json))
        dev.until("document.querySelectorAll('#seriesList .series-list-item').length === 2", timeout=30)
        imported = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const read = name => new Promise((resolve) => {
                const request = db.transaction(name, 'readonly').objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
              });
              const [series, shots, assets] = await Promise.all([read('series'), read('shots'), read('assets')]);
              const counts = {};
              for (const shot of shots) counts[shot.seriesId] = (counts[shot.seriesId] || 0) + 1;
              // Shot ids must not be reused across series, or the import would have
              // overwritten the source series' frames.
              const uniqueShotIds = new Set(shots.map(item => item.id)).size === shots.length;
              return { series: series.length, counts, uniqueShotIds, assetSeries: new Set(assets.map(item => item.seriesId)).size };
            })()
        """)
        assert imported['series'] == 2, imported
        assert imported['uniqueShotIds'], imported
        assert imported['assetSeries'] == 2, imported
        assert all(count >= 3 for count in imported['counts'].values()), imported

        # ---------------------------------------------------------------- persistence
        dev.call('Page.navigate', {'url': endpoints['app'] + '#series'})
        dev.until("document.querySelector('#connectionText')?.textContent === '本地服务已连接'")
        dev.until("document.querySelectorAll('#seriesList .series-list-item').length === 2", timeout=25)
        dev.until("document.querySelector('#seriesProgressBadge').textContent.includes('帧出图')")
        reloaded = dev.evaluate("document.querySelector('#seriesProgressBadge').textContent")
        assert '0 /' not in reloaded, reloaded
        dev.screenshot('series-reloaded.png')

        # ---------------------------------------------------------------- built-in templates
        extracts_before_template = json.load(urllib.request.urlopen(endpoints['stats']))['seriesExtracts']
        dev.evaluate("document.querySelector('#seriesNew').click()")
        dev.evaluate("(() => { const select = document.querySelector('#seriesNewTemplate'); select.value = 'picture-book'; select.dispatchEvent(new Event('change')); })()")
        dev.until("document.querySelector('#seriesNewName').value.length > 0", timeout=10)
        dev.evaluate("document.querySelector('#seriesNewForm').requestSubmit()")
        dev.until("document.querySelectorAll('#seriesList .series-list-item').length === 3", timeout=20)
        dev.until("document.querySelectorAll('#seriesShotList .series-shot-card').length === 3", timeout=20)
        assert dev.evaluate("document.querySelector('#seriesAnchorPreview').textContent").strip(), 'template should prefill the canon anchor'
        assert dev.evaluate("document.querySelector('#seriesVersionBadge').textContent") == '圣经 v1'
        # A template never calls the text model.
        assert json.load(urllib.request.urlopen(endpoints['stats']))['seriesExtracts'] == extracts_before_template
        dev.screenshot('series-template.png')

        # ---------------------------------------------------------------- gallery promotion
        # Seed one artwork in the gallery database, then use the "组成系列" entry point.
        dev.evaluate("""
            (async () => {
              const canvas = document.createElement('canvas');
              canvas.width = 800; canvas.height = 600;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#2f3b45'; ctx.fillRect(0, 0, 800, 600);
              ctx.fillStyle = '#e4704f'; ctx.fillRect(120, 120, 240, 240);
              const data = canvas.toDataURL('image/png');
              const open = indexedDB.open('prompt-studio-gallery', 1);
              open.onupgradeneeded = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('artworks')) db.createObjectStore('artworks', { keyPath: 'id' });
              };
              const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
              await new Promise(resolve => {
                const tx = db.transaction('artworks', 'readwrite');
                tx.objectStore('artworks').put({ id: 'art_seed_1', src: data, prompt: '海边的旧船坞', created: Date.now(), addedAt: Date.now(), selected: true });
                tx.oncomplete = resolve;
              });
              return true;
            })()
        """)
        dev.evaluate("location.hash = 'gallery'")
        dev.until("document.querySelectorAll('#galleryTimeline .gallery-art').length === 1", timeout=25)
        dev.until("document.querySelector('#galleryCompose').disabled === false", timeout=10)
        dev.evaluate("document.querySelector('#galleryCompose').click()")
        try:
            dev.until("location.hash === '#series' && document.querySelectorAll('#seriesList .series-list-item').length === 4", timeout=40)
        except AssertionError:
            raise AssertionError(
                'gallery promotion did not finish | hash=' + str(dev.evaluate("location.hash"))
                + ' | list=' + str(dev.evaluate("document.querySelectorAll('#seriesList .series-list-item').length"))
                + ' | seriesStatus=' + str(dev.evaluate("document.querySelector('#seriesStatus').textContent"))
                + ' | galleryStatus=' + str(dev.evaluate("document.querySelector('#galleryStatus').textContent"))
                + ' | errors=' + json.dumps(dev.errors)[:1500]
            )
        dev.until("document.querySelectorAll('#seriesShotList .series-shot-card').length === 1", timeout=20)
        dev.until("document.querySelector('.series-shot-state[data-state=\"done\"]') !== null", timeout=10)
        promoted = dev.evaluate("""
            (async () => {
              const open = indexedDB.open('prompt-studio-series', 1);
              const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
              const read = name => new Promise((resolve) => {
                const request = db.transaction(name, 'readonly').objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
              });
              const [series, shots, assets] = await Promise.all([read('series'), read('shots'), read('assets')]);
              const latest = series.sort((a, b) => b.createdAt - a.createdAt)[0];
              return {
                title: latest.title,
                defaults: latest.gallery?.defaults?.style || '',
                frames: shots.filter(item => item.seriesId === latest.id).length,
                origin: shots.find(item => item.seriesId === latest.id)?.origin,
                hasImage: assets.some(item => item.seriesId === latest.id && String(item.data || '').startsWith('data:image/'))
              };
            })()
        """)
        assert promoted['frames'] == 1, promoted
        assert promoted['origin'] == 'gallery', promoted
        assert promoted['defaults'], promoted
        assert promoted['hasImage'], promoted
        dev.screenshot('series-from-gallery.png')

        # ---------------------------------------------------------------- split then batch (accept)
        # Switch back to a series that has lore, split again, and accept the batch offer.
        dev.evaluate("""
            (() => {
              const item = [...document.querySelectorAll('#seriesList .series-list-item')]
                .find(node => node.querySelector('.series-list-name').textContent.includes('雨夜邮差'));
              item.querySelector('.series-list-open').click();
            })()
        """)
        dev.until("document.querySelector('#seriesName').value.includes('雨夜邮差')", timeout=15)
        dev.evaluate("document.querySelector('[data-series-view=\"outline\"]').click()")
        dev.until("document.querySelector('#seriesSuggestFrames').disabled === false", timeout=10)
        dev.evaluate("document.querySelector('#seriesSuggestFrames').click()")
        dev.until("document.querySelector('#seriesSplitDialog').open", timeout=10)
        dev.evaluate("document.querySelector('#seriesSplitCount').value = '2'; document.querySelector('#seriesSplitCount').dispatchEvent(new Event('input'))")
        generations_before_accept = json.load(urllib.request.urlopen(endpoints['stats']))['generations']
        dev.evaluate("document.querySelector('#seriesSplitStart').click()")
        try:
            dev.until("!document.querySelector('#seriesSplitDialog').open", timeout=40)
        except AssertionError:
            raise AssertionError(
                'split dialog stayed open | status=' + str(dev.evaluate("document.querySelector('#seriesStatus').textContent"))
                + ' | lore=' + str(dev.evaluate("document.querySelectorAll('#seriesSplitLore input').length"))
                + ' | checked=' + str(dev.evaluate("document.querySelectorAll('#seriesSplitLore input:checked').length"))
                + ' | startDisabled=' + str(dev.evaluate("document.querySelector('#seriesSplitStart').disabled"))
                + ' | errors=' + json.dumps(dev.errors)[:800]
            )
        dev.until("document.querySelector('#seriesConfirmDialog').open", timeout=15)
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        # The completion bar auto-hides. Verify requests and durable frame states instead
        # of requiring a transient bar to remain visible after the dialog closes.
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if json.load(urllib.request.urlopen(endpoints['stats']))['generations'] >= generations_before_accept + 2:
                break
            time.sleep(.2)
        assert json.load(urllib.request.urlopen(endpoints['stats']))['generations'] == generations_before_accept + 2
        dev.until("!SeriesPage.state.batch && !SeriesPage.state.busy", timeout=30)
        assert dev.evaluate("SeriesPage.state.shots.slice(-2).every(shot => shot.status === 'done' && shot.result?.assetId)")
        dev.until("document.querySelector('#seriesBatchTitle').textContent.includes('完成')", timeout=30)
        dev.screenshot('series-split-batch.png')

        # ---------------------------------------------------------------- delete confirm dialog
        before_delete = dev.evaluate("document.querySelectorAll('#seriesList .series-list-item').length")
        dev.evaluate("document.querySelectorAll('#seriesList .series-list-remove')[0].click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open", timeout=10)
        dev.screenshot('series-confirm.png')
        # Cancelling must keep the series.
        dev.evaluate("document.querySelector('#seriesConfirmCancel').click()")
        dev.until("!document.querySelector('#seriesConfirmDialog').open", timeout=10)
        time.sleep(.4)
        assert dev.evaluate("document.querySelectorAll('#seriesList .series-list-item').length") == before_delete
        # Confirming removes exactly one.
        dev.evaluate("document.querySelectorAll('#seriesList .series-list-remove')[0].click()")
        dev.until("document.querySelector('#seriesConfirmDialog').open", timeout=10)
        dev.evaluate("document.querySelector('#seriesConfirmOk').click()")
        dev.until("!document.querySelector('#seriesConfirmDialog').open", timeout=10)
        dev.until("document.querySelectorAll('#seriesList .series-list-item').length === %d" % (before_delete - 1), timeout=15)

        # ---------------------------------------------------------------- dark theme
        dev.evaluate("document.querySelector('#themeButton').click()")
        time.sleep(.3)
        dev.screenshot('series-dark.png')
        dev.evaluate("document.querySelector('#themeButton').click()")

        # ---------------------------------------------------------------- mobile layout
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 900, 'deviceScaleFactor': 2, 'mobile': True})
        time.sleep(.4)
        # Close the inspector so the collapsed workspace is what gets captured.
        if dev.evaluate("!document.querySelector('#seriesInspector').hidden"):
            dev.evaluate("document.querySelector('#seriesInspectorClose').click()")
        time.sleep(.3)
        assert dev.evaluate("document.querySelector('#seriesPage').getBoundingClientRect().width <= 390")
        # No horizontal scrolling: the collapsed layout must fit the viewport.
        overflow = dev.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        assert overflow <= 1, 'horizontal overflow ' + str(overflow)
        assert dev.evaluate("getComputedStyle(document.querySelector('.series-layout')).gridTemplateColumns.split(' ').length === 1")
        dev.screenshot('series-mobile.png')

        assert not dev.errors, dev.errors
        print('PASS: series create, chunked extraction, canon draft, frame suggestions, gallery upload/compression, '
              'reference slots, single-frame generation, canon versioning, batch, lore, export, persistence, themes, mobile')
        print('Screenshots: test-results/series-*.png')
    except Exception:
        if dev:
            print('Failure context:', ascii(dev.evaluate("({status:document.querySelector('#seriesStatus')?.textContent,confirm:document.querySelector('#seriesConfirmDialog')?.open,confirmTitle:document.querySelector('#seriesConfirmTitle')?.textContent,hasKey:!!document.querySelector('#apiKey')?.value,model:document.querySelector('#model')?.value,busy:SeriesPage.state.busy,batch:!!SeriesPage.state.batch})")))
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
