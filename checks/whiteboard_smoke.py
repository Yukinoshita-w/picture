"""Real Chrome/Edge regression for the gallery whiteboard. No provider calls or personal profile."""
import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import urllib.request
import zlib
from browser_driver import DevTools, OUTPUT

ROOT = Path(__file__).resolve().parents[1]


def png(red, green, blue, width=320, height=180):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    data = b''.join(b'\x00' + bytes((red, green, blue)) * width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b'')


def main():
    OUTPUT.mkdir(exist_ok=True)
    chrome = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    if not chrome.exists():
        chrome = Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    if not chrome.exists():
        raise RuntimeError('Chrome or Edge is required')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    fixture = subprocess.Popen(['node', str(ROOT / 'checks/whiteboard-fixture.cjs')], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    browser = dev = None
    try:
        endpoint = json.loads(fixture.stdout.readline())['app']
        profile = OUTPUT / ('whiteboard-profile-' + str(os.getpid()))
        downloads = OUTPUT / ('whiteboard-downloads-' + str(os.getpid()))
        downloads.mkdir(exist_ok=True)
        browser = subprocess.Popen([str(chrome), '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + str(profile), 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        deadline = time.monotonic() + 25
        while not (profile / 'DevToolsActivePort').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Browser did not start')
            time.sleep(.15)
        port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
        tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json/list'))
        dev = DevTools(next(tab for tab in tabs if tab['type'] == 'page')['webSocketDebuggerUrl'])
        dev.call('Page.enable'); dev.call('Runtime.enable'); dev.call('Log.enable')
        dev.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(downloads)})
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1700, 'height': 1200, 'deviceScaleFactor': 1, 'mobile': False})
        dev.call('Page.navigate', {'url': endpoint})
        dev.until("document.querySelector('#connectionText')?.textContent === '本地服务已连接'")
        assert not dev.evaluate("performance.getEntriesByType('resource').some(r => r.name.includes('whiteboard.bundle'))"), 'whiteboard should load lazily'

        def evaluate(expression):
            return dev.evaluate(expression)

        def click(selector):
            rect = evaluate("(() => { const e=document.querySelector(" + json.dumps(selector) + "); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()")
            dev.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': rect['x'], 'y': rect['y'], 'button': 'left', 'clickCount': 1})
            dev.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': rect['x'], 'y': rect['y'], 'button': 'left', 'clickCount': 1})

        def drag(start, end, button='left'):
            buttons = 4 if button == 'middle' else 1
            dev.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': start['x'], 'y': start['y']})
            dev.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': start['x'], 'y': start['y'], 'button': button, 'buttons': buttons, 'clickCount': 1})
            for step in range(1, 13):
                dev.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': start['x'] + (end['x']-start['x'])*step/12, 'y': start['y']+(end['y']-start['y'])*step/12, 'button': button, 'buttons': buttons})
            dev.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': end['x'], 'y': end['y'], 'button': button, 'buttons': 0, 'clickCount': 1})

        editor = 'GalleryWhiteboard.editor'
        graph = editor + '.graph'
        evaluate("location.hash='gallery'")
        evaluate("window.wbTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(this.name==='prompt-studio-whiteboards')throw new DOMException('simulated storage failure','InvalidStateError');return window.wbTransaction.apply(this,args)}")
        click('[data-gallery-view="board"]')
        dev.until("window.GalleryWhiteboard?.editor && !document.querySelector('#wbRetrySave').hidden", timeout=30)
        evaluate('IDBDatabase.prototype.transaction=window.wbTransaction;true')
        click('#wbRetrySave')
        dev.until("window.GalleryWhiteboard?.editor && document.querySelector('#wbTitle').value.length > 0", timeout=30)
        assert evaluate("document.querySelector('#galleryEmpty').hidden && !document.querySelector('#galleryBoard').hidden")
        assert evaluate("document.querySelectorAll('#wbBoardList option').length") == 1
        click('#wbAddNode')
        assert evaluate(graph + '.getNodes().length') == 1
        click('#wbUndo')
        assert evaluate(graph + '.getNodes().length') == 0
        click('#wbRedo')
        assert evaluate(graph + '.getNodes().length') == 1
        evaluate('void ' + graph + '.resetSelection([' + graph + '.getNodes()[0]])')
        click('#wbRemove')
        assert evaluate(graph + '.getNodes().length') == 0

        red = 'data:image/png;base64,' + base64.b64encode(png(185, 64, 38)).decode()
        blue = 'data:image/png;base64,' + base64.b64encode(png(45, 100, 135, 180, 320)).decode()
        fixtures = [dict(id='wb-fixture-red', src=red, prompt='朱红色的傍晚', created=1, selected=True), dict(id='wb-fixture-blue', src=blue, prompt='蓝色的清晨', created=2, selected=True)]
        evaluate("new Promise((resolve,reject)=>{const r=indexedDB.open('prompt-studio-gallery',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('artworks','readwrite');for(const a of " + json.dumps(fixtures) + ")tx.objectStore('artworks').put(a);tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})")
        evaluate('ArtGallery.refresh()')
        dev.until("document.querySelectorAll('#wbLibrary [data-wb-artwork]').length===2")
        click('[data-wb-artwork="wb-fixture-red"]')
        dev.until(graph + '.getNodes().length===1 && ' + graph + '.getNodes()[0].getData().assetId')
        # Real mouse drag verifies node movement rather than setting model coordinates.
        evaluate("document.querySelector('#wbCanvas').scrollIntoView({block:'center'})")
        start = evaluate("(() => {const b=" + graph + ".getNodes()[0].getBBox();return " + graph + ".localToClient(b.x+b.width/2,b.y+45)})()")
        before = evaluate(graph + '.getNodes()[0].position()')
        drag(start, {'x': start['x'] - 155, 'y': start['y'] - 90})
        after = evaluate(graph + '.getNodes()[0].position()')
        assert abs(after['x'] - before['x']) > 100, (before, after)
        # Panning changes the viewport, keeping the artwork's layout coordinates.
        click('#wbPan')
        evaluate("document.querySelector('#wbCanvas').scrollIntoView({block:'center'})")
        node_position = evaluate(graph + '.getNodes()[0].position()')
        for target in ['blank', 'image']:
            if target == 'blank':
                start = evaluate("(() => {const r=document.querySelector('#wbCanvas').getBoundingClientRect();return {x:r.x+35,y:r.y+35}})()")
            else:
                start = evaluate("(() => {const b=" + graph + ".getNodes()[0].getBBox();return " + graph + ".localToClient(b.x+b.width/2,b.y+45)})()")
            offset = evaluate(graph + '.translate()')
            drag(start, {'x': start['x'] + 65, 'y': start['y'] + 40})
            moved = evaluate(graph + '.translate()')
            assert abs(moved['tx'] - offset['tx'] - 65) < 2 and abs(moved['ty'] - offset['ty'] - 40) < 2, ('pan', target, offset, moved)
            assert evaluate(graph + '.getNodes()[0].position()') == node_position
        click('#wbSelect')
        evaluate("document.querySelector('#wbCanvas').scrollIntoView({block:'center'})")
        start = evaluate("(() => {const r=document.querySelector('#wbCanvas').getBoundingClientRect();return {x:r.x+35,y:r.y+35}})()")
        offset = evaluate(graph + '.translate()')
        drag(start, {'x': start['x'] - 65, 'y': start['y'] - 40}, 'middle')
        moved = evaluate(graph + '.translate()')
        assert abs(moved['tx'] - offset['tx'] + 65) < 2 and abs(moved['ty'] - offset['ty'] + 40) < 2, ('middle pan', offset, moved)
        assert evaluate(graph + '.getNodes()[0].position()') == node_position
        click('[data-wb-artwork="wb-fixture-blue"]')
        dev.until(graph + '.getNodes().length===2')
        # Offset the new node with a real gesture so it does not obscure the first one.
        evaluate("document.querySelector('#wbCanvas').scrollIntoView({block:'center'})")
        start = evaluate("(() => {const b=" + graph + ".getNodes()[1].getBBox();return " + graph + ".localToClient(b.x+b.width/2,b.y+45)})()")
        drag(start, {'x': start['x'] + 165, 'y': start['y'] + 100})
        click('#wbFit'); click('#wbConnect')
        evaluate("document.querySelector('#wbCanvas').scrollIntoView({block:'center'})")
        points = evaluate(graph + '.getNodes().map(n=>{const b=n.getBBox();return ' + graph + '.localToClient(b.x+b.width/2,b.y+b.height/2)})')
        drag(points[0], points[1])
        dev.until(graph + '.getEdges().length===1', timeout=5)
        drag(points[1], points[0])
        dev.until(graph + '.getEdges().length===2', timeout=5)
        assert evaluate(graph + '.getEdges().every(e=>e.getSourceCellId()&&e.getTargetCellId())')
        assert evaluate(graph + ".getEdges().every(e=>e.getData().line==='straight'&&e.getConnector().name==='normal'&&e.getVertices().length===0&&e.getZIndex()<Math.min(..." + graph + '.getNodes().map(n=>n.getZIndex())))')
        # Even X6's temporary toFront during reconnecting must stay below images.
        evaluate('void ' + graph + '.getEdges()[0].toFront()')
        assert evaluate(graph + '.getEdges().every(e=>e.getZIndex()<Math.min(...' + graph + '.getNodes().map(n=>n.getZIndex())))')

        # Relative pins are created through the actual pin tool, then persisted.
        click('#wbPin')
        point = evaluate("(() => {const b=" + graph + ".getNodes()[0].getBBox();return " + graph + ".localToClient(b.x+b.width*.3,b.y+b.height*.4)})()")
        dev.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': point['x'], 'y': point['y'], 'button': 'left', 'clickCount': 1})
        dev.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': point['x'], 'y': point['y'], 'button': 'left', 'clickCount': 1})
        assert evaluate(graph + '.getNodes()[0].getPorts().length') == 1
        assert evaluate("(() => {const v=" + graph + ".findViewByCell(" + graph + ".getNodes()[0]),p=v.container.querySelector('.x6-port'),img=v.container.querySelector('image');return !!(img.compareDocumentPosition(p)&Node.DOCUMENT_POSITION_FOLLOWING)})()"), 'editing rings must paint above the image'
        assert evaluate("getComputedStyle(document.querySelector('.x6-port-body')).opacity==='1'"), 'new pin must be visible immediately'
        assert evaluate("document.elementFromPoint(" + str(point['x']) + ',' + str(point['y']) + ").closest('.x6-port')!==null"), 'transparent ring center must be draggable'
        dev.screenshot('whiteboard-pins.png')
        click('#wbConnect')
        dev.until("getComputedStyle(document.querySelector('.x6-port-body')).opacity==='1'")
        points = evaluate("(() => {const ns=" + graph + ".getNodes(),a=ns[0].getBBox(),b=ns[1].getBBox(),p=ns[0].getPorts()[0];return [" + graph + ".localToClient(a.x+a.width*parseFloat(p.args.x)/100,a.y+a.height*parseFloat(p.args.y)/100)," + graph + ".localToClient(b.x+b.width/2,b.y+b.height/2)]})()")
        drag(points[0], points[1])
        dev.until(graph + '.getEdges().length===3', timeout=5)
        assert evaluate(graph + '.getEdges()[2].getSourcePortId()')
        click('#wbUndo')
        assert evaluate(graph + '.getEdges().length') == 2
        click('#wbSelect')
        dev.until("getComputedStyle(document.querySelector('.x6-port-body')).opacity==='0' && getComputedStyle(document.querySelector('.x6-port-body')).pointerEvents==='none'")
        node_id = evaluate(graph + '.getNodes()[0].id')
        click('.x6-node[data-cell-id="' + node_id + '"]')
        dev.until("document.querySelector('.x6-widget-transform-resize[data-position=\"bottom-right\"]')!==null")
        size = evaluate(graph + '.getNodes()[0].size()')
        corner = evaluate("(() => {const r=document.querySelector('.x6-widget-transform-resize[data-position=\"bottom-right\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        drag(corner, {'x': corner['x'] + 55, 'y': corner['y'] + 40})
        assert evaluate(graph + '.getNodes()[0].size().width') > size['width'] + 20
        evaluate('void ' + graph + '.resetSelection([' + graph + '.getEdges()[0]])')
        assert evaluate(graph + '.getEdges()[0].getTools().local'), 'edge handles must share the lower edge layer'
        evaluate("document.querySelector('#wbEdgeLabel').value='灵感的关联';document.querySelector('#wbEdgeLabel').dispatchEvent(new Event('change'))")
        evaluate("document.querySelector('#wbEdgeArrow').checked=true;document.querySelector('#wbEdgeArrow').dispatchEvent(new Event('change'))")
        assert evaluate(graph + ".getEdges()[0].getData().label==='灵感的关联'")

        # Swap through the picker, then undo: the source image and all edges must survive.
        evaluate('void ' + graph + '.resetSelection([' + graph + '.getNodes()[0]])')
        assert evaluate(graph + ".getNodes().every(n=>n.attr('body/fill')==='transparent'&&n.attr('body/stroke')==='none'&&n.attr('image/x')===0&&n.attr('label/display')==='none')"), 'new artworks must be plain images without prompt captions'
        assert evaluate("document.querySelector('#wbNodeTitle').value===''&&!document.querySelector('#wbNodeFrame').checked")
        click('#wbNodeFrame')
        assert evaluate(graph + ".getNodes()[0].attr('body/fill')==='#fffdf8'")
        click('#wbUndo')
        assert evaluate(graph + ".getNodes()[0].attr('body/fill')==='transparent'")
        click('#wbRedo')
        assert evaluate(graph + ".getNodes()[0].getData().framed===true")
        evaluate("document.querySelector('#wbNodeTitle').value='我的建筑展';document.querySelector('#wbNodeTitle').dispatchEvent(new Event('change'))")
        assert evaluate(graph + ".getNodes()[0].attr('label/text')==='我的建筑展'&&" + graph + ".getNodes()[0].attr('label/display')==='block'")
        evaluate("document.querySelector('#wbNodeTitle').value='';document.querySelector('#wbNodeTitle').dispatchEvent(new Event('change'))")
        assert evaluate(graph + ".getNodes()[0].attr('label/display')==='none'"), 'clearing a caption must hide the text'
        click('#wbUndo')
        assert evaluate(graph + ".getNodes()[0].getData().caption==='我的建筑展'")
        original = evaluate(graph + '.getNodes()[0].getData().assetId')
        click('#wbReplace')
        dev.until("document.querySelector('.wb-dialog[open]')!==null")
        click('.wb-dialog [data-wb-artwork="wb-fixture-blue"]')
        dev.until("document.querySelector('.wb-dialog[open]')===null")
        assert evaluate(graph + '.getNodes()[0].getData().assetId') != original
        assert evaluate(graph + ".getNodes()[0].getData().caption==='我的建筑展'&&" + graph + '.getNodes()[0].getData().framed===true'), 'replacement must preserve custom presentation'
        click('#wbUndo')
        assert evaluate(graph + '.getNodes()[0].getData().assetId') == original
        assert evaluate(graph + '.getEdges().length') == 2

        # Rename, flush, refresh and remove the original gallery records.
        evaluate("document.querySelector('#wbTitle').value='测试展示板';document.querySelector('#wbTitle').dispatchEvent(new Event('change'))")
        assert evaluate(editor + '.flush()')
        snapshot = evaluate(editor + '.snapshot()')
        dev.screenshot('whiteboard-desktop.png')
        evaluate("new Promise(resolve=>{const r=indexedDB.open('prompt-studio-gallery',1);r.onsuccess=()=>{const tx=r.result.transaction('artworks','readwrite');tx.objectStore('artworks').clear();tx.oncomplete=()=>{r.result.close();resolve(true)}}})")
        old_origin = evaluate('performance.timeOrigin')
        dev.call('Page.reload')
        dev.until('performance.timeOrigin > ' + str(old_origin))
        dev.until("document.querySelector('#connectionText')?.textContent==='本地服务已连接'")
        click('[data-gallery-view="board"]')
        dev.until('window.GalleryWhiteboard?.editor?.graph.getNodes().length===2')
        restored = evaluate(editor + '.snapshot()')
        assert restored['nodes'] == snapshot['nodes']
        assert restored['edges'] == snapshot['edges']
        assert evaluate(graph + ".getNodes()[0].getData().caption==='我的建筑展'&&" + graph + '.getNodes()[0].getData().framed===true')
        assert evaluate(graph + ".getNodes()[1].attr('label/display')==='none'&&" + graph + ".getNodes()[1].attr('body/fill')==='transparent'")
        assert evaluate(graph + ".getEdges().every(e=>e.getConnector().name==='normal'&&e.getVertices().length===0&&e.getZIndex()<Math.min(..." + graph + '.getNodes().map(n=>n.getZIndex())))')
        assert evaluate("document.querySelectorAll('#wbLibrary [data-wb-artwork]').length") == 0
        assert evaluate(graph + '.getNodes().every(n=>n.attr("image/xlink:href").startsWith("blob:"))')

        # Every export must complete and contain real, self-contained image bytes.
        click('#wbConnect')
        dev.until("getComputedStyle(document.querySelector('.x6-port-body')).opacity==='1'")
        for kind in ['json', 'svg', 'png']:
            evaluate("document.querySelector('#wbExportType').value=" + json.dumps(kind))
            click('#wbExport')
            deadline = time.monotonic() + 25
            while not list(downloads.glob('*.' + kind)):
                if time.monotonic() > deadline:
                    raise AssertionError('Export failed: ' + kind + ' ' + str(evaluate("document.querySelector('#wbStatus').textContent")))
                time.sleep(.1)
            dev.until("!document.querySelector('#wbExport').disabled")
        backup_file = next(downloads.glob('*.json'))
        data = json.loads(backup_file.read_text(encoding='utf-8'))
        assert len(data['board']['nodes']) == 2 and len(data['assets']) == 2
        svg = next(downloads.glob('*.svg')).read_text(encoding='utf-8')
        assert 'data:image/png;base64,' in svg and 'blob:' not in svg
        assert '我的建筑展' in svg and '朱红色的傍晚' not in svg and '蓝色的清晨' not in svg, 'export should include only authored captions'
        assert 'x6-port' not in svg, 'export must omit editing rings even from connect mode'
        assert next(downloads.glob('*.png')).read_bytes().startswith(b'\x89PNG')
        assert evaluate("getComputedStyle(document.querySelector('.x6-port-body')).opacity==='1'"), 'export should preserve editor mode'

        # A portable backup imports as a separate board and preserves its connections.
        document = dev.call('DOM.getDocument')
        selector = dev.call('DOM.querySelector', {'nodeId': document['root']['nodeId'], 'selector': '#wbImportFile'})
        dev.call('DOM.setFileInputFiles', {'nodeId': selector['nodeId'], 'files': [str(backup_file)]})
        dev.until("document.querySelectorAll('#wbBoardList option').length===2 && document.querySelector('#wbTitle').value.includes('导入')")
        assert evaluate(graph + '.getEdges().length') == 2

        # Switch/create/delete have independent documents and require confirmation.
        click('#wbNew')
        dev.until("document.querySelectorAll('#wbBoardList option').length===3")
        assert evaluate(graph + '.getNodes().length') == 0
        click('#wbDeleteBoard')
        dev.until("document.querySelector('.wb-dialog[open]')!==null")
        click('.wb-dialog[open] .wb-dialog-actions button:first-child')
        dev.until("document.querySelector('.wb-dialog')===null")
        assert evaluate("document.querySelectorAll('#wbBoardList option').length") == 3
        click('#wbDeleteBoard')
        dev.until("document.querySelector('.wb-dialog[open]')!==null")
        click('.wb-dialog[open] .wb-dialog-actions button:last-child')
        dev.until("document.querySelectorAll('#wbBoardList option').length===2")
        dev.until(graph + '.getNodes().length===2')

        # A failing write keeps the unsaved layout and exposes retry, then recovers.
        evaluate("window.wbOriginalPut=IDBObjectStore.prototype.put;window.wbFailSave=true;IDBObjectStore.prototype.put=function(...args){if(this.name==='boards'&&window.wbFailSave)throw new DOMException('simulated quota','QuotaExceededError');return window.wbOriginalPut.apply(this,args)};void " + graph + ".getNodes()[0].translate(10,0)")
        assert evaluate(editor + '.flush()') is False
        assert evaluate("document.querySelector('#wbSaveState').dataset.error==='true'&&!document.querySelector('#wbRetrySave').hidden")
        evaluate('window.wbFailSave=false;IDBObjectStore.prototype.put=window.wbOriginalPut;true')
        click('#wbRetrySave')
        dev.until("document.querySelector('#wbSaveState').dataset.error==='false'")

        # Presenting is read-only and returns to normal editing; theme and phone layout fit.
        click('#wbPresent')
        click('#wbFullscreen')
        dev.until("document.fullscreenElement?.id==='galleryBoard'")
        click('#wbFullscreen')
        dev.until('!document.fullscreenElement')
        assert evaluate("document.querySelector('#galleryBoard').classList.contains('is-presenting')")
        dev.until("getComputedStyle(document.querySelector('.x6-port-body')).opacity==='0'")
        click('#wbPresent')
        click('#themeButton')
        dev.screenshot('whiteboard-dark.png')
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 900, 'deviceScaleFactor': 1, 'mobile': True})
        time.sleep(.3)
        assert evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile overflow'
        assert evaluate("document.querySelector('.wb-graph').clientWidth <= innerWidth"), 'graph did not resize with its responsive wrapper'
        assert evaluate(graph + '.zoom()') < 1, 'mobile composition should fit'
        evaluate("document.querySelector('#galleryBoard').scrollIntoView({block:'start'})")
        dev.screenshot('whiteboard-mobile.png')
        # Exercise a larger composition through the real X6 model, sharing image assets.
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1700, 'height': 1200, 'deviceScaleFactor': 1, 'mobile': False})
        perf = evaluate("(() => {const g=" + graph + ",t=performance.now(),assetId=g.getNodes()[0].getData().assetId;g.batchUpdate('large-board',()=>{g.removeCells(g.getEdges());for(let i=g.getNodes().length;i<100;i++)g.addNode({id:'stress-'+i,shape:'whiteboard-image',x:(i%10)*300,y:Math.floor(i/10)*250,width:260,height:210,data:{assetId,title:'Image '+i}});const ns=g.getNodes();for(let i=0;i<200;i++)g.addEdge({id:'stress-edge-'+i,source:ns[i%100].id,target:ns[(i+1+Math.floor(i/100))%100].id})});g.zoomToFit({padding:30});return {nodes:g.getNodes().length,edges:g.getEdges().length,elapsedMs:Math.round(performance.now()-t)}})()")
        assert perf['nodes'] == 100 and perf['edges'] == 200
        assert evaluate(editor + '.flush()')
        print('Large board measurement:', perf)
        # An external writer must never be silently overwritten.
        stamp = evaluate(editor + '.snapshot().updatedAt')
        evaluate("new Promise((resolve,reject)=>{const r=indexedDB.open('prompt-studio-whiteboards',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('boards','readwrite'),s=tx.objectStore('boards'),q=s.get(" + editor + ".activeBoardId);q.onsuccess=()=>s.put({...q.result,updatedAt:" + str(stamp + 10000) + "});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})")
        evaluate('void ' + graph + '.getNodes()[0].translate(1,0)')
        assert evaluate(editor + '.flush()') is False
        assert evaluate("document.querySelector('#wbStatus').textContent.includes('其他标签页')")
        click('[data-gallery-view="corridor"]')
        assert evaluate("document.querySelector('#galleryBoard').hidden && !document.querySelector('#galleryEmpty').hidden")
        click('[data-gallery-view="cinema"]')
        assert evaluate("document.querySelector('#galleryBoard').hidden")
        assert not dev.errors, dev.errors
        assert not dev.log_errors, dev.log_errors
        print('PASS: lazy load, storage retry, empty gallery, nodes, real dragging/resizing/connections, pins, image replacement/undo, durable snapshots, source deletion, PNG/SVG/backup, import, multiple boards, save failure/retry, fullscreen, themes, mobile, 100 images/200 edges, concurrent writer protection, gallery views and CSP')
        print('Screenshots: test-results/whiteboard-{desktop,dark,mobile}.png')
    except Exception:
        if dev:
            print('Runtime errors:', dev.errors)
            print('Browser log errors:', dev.log_errors)
            try:
                print('Status:', ascii(dev.evaluate("document.querySelector('#wbStatus')?.textContent")))
                print('Pin state:', dev.evaluate("({mode:document.querySelector('#wbCanvas')?.dataset.mode,pins:[...document.querySelectorAll('.x6-port-body')].map(p=>({opacity:getComputedStyle(p).opacity,html:p.outerHTML}))})"))
                dev.screenshot('whiteboard-failure.png')
            except Exception:
                pass
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
