"""Phase-two prompt/request equality and atomic matrix creation in a real browser."""
import json
import urllib.request

from series_test_driver import series_browser, seed_series, open_series


GATES = r"""
  window.matrixCalls=0; window.matrixSettled=0;
  Object.defineProperty(window,'createSeriesStore',{configurable:true,set(base){
    window.testBaseStore=base;
    Object.defineProperty(window,'createSeriesStore',{value:()=>{
      const store=base();const append=store.appendMatrixShots;
      store.appendMatrixShots=async(...args)=>{
        window.matrixCalls++;
        try{
          const gate=window.matrixGate;
          if(gate){gate.started=true;await new Promise(resolve=>{gate.release=resolve})}
          return await append(...args);
        }finally{window.matrixSettled++}
      };
      return store;
    }});
  }});
  const add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(value,...rest){
    const request=add.call(this,value,...rest);
    if(this.name==='shots' && value?.origin==='matrix' && window.abortMatrix){
      window.matrixWrites=(window.matrixWrites||0)+1;
      if(window.matrixWrites===2)request.addEventListener('success',()=>{
        window.abortMatrix=false;this.transaction.abort();
      },{once:true});
    }
    return request;
  };
"""


def main():
    with series_browser('series-matrix', GATES) as (dev, endpoints):
        seed_series(dev, ('a', 'b', 'c', 'd'))

        def stats():
            return json.load(urllib.request.urlopen(endpoints['stats'], timeout=10))

        def select(series_id='a', shot_id=None):
            open_series(dev, series_id)
            dev.evaluate("document.querySelector('[data-shot-id=" + (shot_id or 'shot_' + series_id) + "]').click()")

        def idle():
            dev.until('!SeriesPage.state.busy && !SeriesPage.state.generationTask')

        def built():
            dev.until('matrixCalls===matrixSettled')

        def choose(axis_id, value):
            dev.evaluate("{const select=document.querySelector('.series-inspector-axes select[data-axis-id=" + axis_id + "]');"
                         "select.value=" + json.dumps(value) + ";select.dispatchEvent(new Event('change'))}")
            dev.until("document.querySelector('.series-preview-text').textContent.includes(" + json.dumps(value) + ")")

        def preview():
            return dev.evaluate("document.querySelector('.series-preview-text').textContent")

        def generate(edit=False):
            prompt = preview()
            assert not dev.evaluate("document.querySelector('[data-action=generate-shot]').disabled"), prompt
            dev.evaluate("document.querySelector('[data-action=generate-shot]').click()")
            idle()
            sent = stats()['lastEdit' if edit else 'lastBody']['prompt']
            assert sent == prompt, (sent[-400:], prompt[-400:])
            assert dev.evaluate("testStore.getShot('shot_a').then(s=>s.result.prompt)") == prompt
            assert sent.count('【本次生成要求】') == 1
            return sent

        dev.evaluate("""
          (async()=>{
            await testStore.updateSeries('a',s=>{
              s.axes=[{id:'scene',label:'场景',values:['海边']},{id:'time',label:'时间',values:['雨夜','清晨']},
                {id:'shot',label:'景别',values:['全身','特写']},{id:'prop',label:'关键道具',values:['铜制信匣']}];
              s.canon.lens={distance:'半身',angle:'平视',focal:'35mm'};
              s.canon.lighting={key:'夜间月光',ratio:'1:3'};
              s.canon.characterLook='短黑发，深灰呢大衣';
              s.canon.anchorSentence=SeriesEngine.renderAnchor(s.canon);return s;
            });
            await testStore.updateShot('shot_a','a',s=>({...s,scene:'旧地点',
              axisValues:{scene:'海边',time:'雨夜',shot:'全身',prop:'铜制信匣'}}));
            const values=Array.from({length:24},(_,i)=>'地点'+i);
            await testStore.updateSeries('b',s=>({...s,axes:[{id:'scene',label:'场景',values},
              {id:'time',label:'时间',values:values.map((_,i)=>'时段'+i)},
              {id:'shot',label:'景别',values:['特写','全身']}]}));
            await testStore.updateSeries('c',s=>({...s,axes:[{id:'axis1',label:'场景',values:['公园','街道']},
              {id:'axis2',label:'时间',values:['雨夜','清晨']},{id:'axis3',label:'景别',values:['特写','全身']}]}));
            await testStore.updateSeries('d',s=>({...s,axes:[{id:'place',label:'场景',values:['甲','乙']},
              {id:'time',label:'时间',values:['清晨','正午']}]}));
            await SeriesPage.activate();
          })()
        """)
        select()
        dev.evaluate("document.querySelector('#settingsButton').click();"
                     "document.querySelector('#apiUrl').value=" + json.dumps(endpoints['api']) + ";"
                     "document.querySelector('#apiKey').value='test-secret';"
                     "document.querySelector('#model').value='gpt-image-1';"
                     "document.querySelector('#settingsForm').requestSubmit();"
                     "document.querySelector('#size').value='1024x1024';"
                     "document.querySelector('#quality').value='medium'")
        # Reopen to render the preview with the selected creation parameters.
        select()
        canon_before = dev.evaluate("testStore.getSeries('a').then(s=>JSON.stringify(s.canon))")
        night = generate()
        assert '时间：雨夜' in night and '景别：全身' in night and '关键道具：铜制信匣' in night
        assert '固定半身' not in night and '场景：旧地点' not in night and '短黑发' in night
        choose('time', '清晨')
        choose('shot', '特写')
        morning = generate()
        assert '时间：清晨' in morning and '景别：特写' in morning and '夜间月光' not in morning
        assert night != morning
        assert dev.evaluate("testStore.getSeries('a').then(s=>JSON.stringify(s.canon))") == canon_before

        # Multipart references, custom purpose and parameter suffix match byte for byte too.
        dev.evaluate("""
          (async()=>{
            const image=(await testStore.listAssets('a')).find(a=>a.role==='output');
            await testStore.putAsset({...image,id:'style_a',shotId:null,role:'style'});
            await testStore.updateShot('shot_a','a',s=>({...s,references:[{slot:'style',assetId:'style_a',
              purpose:'custom',customPurpose:'纸张材质',preserve:'纸纹',change:'背景'}]}));
          })()
        """)
        select()
        with_ref = generate(edit=True)
        assert '参考图1（用途：纸张材质）' in with_ref
        assert '时间：清晨' in with_ref and '景别：特写' in with_ref

        # Known conflicts disable the control; a stale/programmatic click is also blocked.
        choose('shot', '全身')
        dev.evaluate("{const detail=document.querySelector('[data-shot-field=detail]');"
                     "detail.value='固定半身构图';detail.dispatchEvent(new Event('input'));detail.dispatchEvent(new Event('change'))}")
        dev.until("document.querySelector('[data-action=generate-shot]').disabled")
        assert '固定半身' in dev.evaluate("document.querySelector('.series-preview-warnings').textContent")
        count = stats()['generations']
        dev.evaluate("document.querySelector('[data-action=generate-shot]').dispatchEvent(new MouseEvent('click'))")
        assert stats()['generations'] == count
        assert '变量冲突' in dev.evaluate("document.querySelector('#seriesStatus').textContent")
        dev.evaluate("{const detail=document.querySelector('[data-shot-field=detail]');"
                     "detail.value='纸纹清晰';detail.dispatchEvent(new Event('input'));detail.dispatchEvent(new Event('change'))}")
        dev.until("!document.querySelector('[data-action=generate-shot]').disabled")
        # Clearing variables keeps old frames usable.
        dev.evaluate("document.querySelectorAll('.series-inspector-axes select').forEach(s=>{s.value='';s.dispatchEvent(new Event('change'))})")
        dev.until("!document.querySelector('.series-preview-text').textContent.includes('【本帧变量】')")
        assert '【本帧变量】' not in generate(edit=True)

        # A 1152-combination build, held before storage, must remain owned by B.
        open_series(dev, 'b', 'matrix')
        assert '1152' in dev.evaluate("document.querySelector('#seriesMatrixSummary').textContent")
        assert dev.evaluate("document.querySelectorAll('[data-matrix-key]').length") == 200
        assert dev.evaluate("Array.from(document.querySelectorAll('[data-matrix-key]')).every(row=>JSON.parse(row.dataset.matrixKey).length===3)")
        assert '前 200' in dev.evaluate("document.querySelector('#seriesMatrixBuild').textContent")
        count = stats()['generations']
        dev.evaluate("window.matrixGate={};document.querySelector('#seriesMatrixBuild').click()")
        dev.until('matrixGate.started')
        select()
        dev.evaluate("window.aInput=document.querySelector('[data-shot-field=title]');aInput.value='A 未提交';"
                     "aInput.dispatchEvent(new Event('input'));document.querySelector('#seriesStatus').textContent='A 提示'")
        a_state = dev.evaluate('JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})')
        dev.evaluate('matrixGate.release();window.matrixGate=null')
        built()
        assert dev.evaluate('JSON.stringify({shots:SeriesPage.state.shots,assets:SeriesPage.state.assets})') == a_state
        assert dev.evaluate("aInput===document.querySelector('[data-shot-field=title]') && aInput.value==='A 未提交'")
        assert dev.evaluate("document.querySelector('#seriesStatus').textContent") == 'A 提示'
        assert dev.evaluate("testStore.listShots('b').then(s=>s.length)") == 201
        open_series(dev, 'b', 'matrix')
        dev.evaluate("window.buildButton=document.querySelector('#seriesMatrixBuild');buildButton.click();buildButton.dispatchEvent(new MouseEvent('click'))")
        built()
        b_shots = dev.evaluate("testStore.listShots('b')")
        matrix_shots = [s for s in b_shots if s.get('origin') == 'matrix']
        assert len(matrix_shots) == 200 and len(b_shots) == 201
        assert len({json.dumps(s['axisValues'], sort_keys=True) for s in matrix_shots}) == 200
        assert all(len(s['axisValues']) == 3 and s['status'] == 'draft' for s in matrix_shots)
        assert len({s['order'] for s in b_shots}) == len({s['code'] for s in b_shots}) == 201
        assert '已建 200 组' in dev.evaluate("document.querySelector('#seriesMatrixSummary').textContent")
        assert stats()['generations'] == count
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
        assert dev.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        dev.screenshot('series-matrix-mobile.png')
        dev.call('Emulation.setDeviceMetricsOverride', {'width': 1280, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})

        # Row clicks and whole-matrix builds use the same atomic deduplication.
        open_series(dev, 'c', 'matrix')
        dev.evaluate("window.rowBuild=document.querySelector('[data-action=build-matrix-frame]');rowBuild.click();rowBuild.dispatchEvent(new MouseEvent('click'))")
        built()
        assert dev.evaluate("testStore.listShots('c').then(s=>s.length)") == 2
        dev.evaluate("document.querySelector('#seriesMatrixBuild').click()")
        built()
        assert dev.evaluate("testStore.listShots('c').then(s=>s.length)") == 9
        c_shots = dev.evaluate("testStore.listShots('c')")
        dev.evaluate("""
          (async()=>{
            await testStore.updateSeries('c',s=>({...s,axes:s.axes.slice().reverse()}));
            const shots=await testStore.listShots('c');
            for(const shot of shots){shot.axisValues=Object.fromEntries(Object.entries(shot.axisValues||{}).reverse());await testStore.putShot(shot)}
          })()
        """)
        open_series(dev, 'c', 'matrix')
        assert dev.evaluate("document.querySelectorAll('[data-action=build-matrix-frame]').length") == 0
        dev.evaluate("document.querySelector('#seriesMatrixBuild').click()")
        built()
        assert dev.evaluate("testStore.listShots('c').then(s=>s.length)") == 9
        # Deleted axes cannot collide with active IDs or rebind historical frame values.
        dev.evaluate("document.querySelector('[data-series-view=canon]').click();"
                     "document.querySelector('.series-axis-row[data-axis-id=axis2] [data-action=remove-axis]').click();"
                     "document.querySelector('[data-action=add-axis]').click()")
        axis_ids = dev.evaluate('SeriesPage.state.series.axes.map(a=>a.id)')
        assert len(axis_ids) == len(set(axis_ids)) == 3 and 'axis2' not in axis_ids
        assert any(axis_id.startswith('axis_') for axis_id in axis_ids)
        assert dev.evaluate("testStore.listShots('c').then(s=>s.every(shot=>shot.id==='shot_c'||shot.axisValues.axis2))")
        dev.evaluate("document.querySelector('#seriesCanonSave').click()")
        dev.until("!SeriesPage.state.series.canonDirty")
        assert {s['id'] for s in dev.evaluate("testStore.listShots('c')")} == {s['id'] for s in c_shots}

        # Aborting a multi-frame insertion rolls back the entire build.
        open_series(dev, 'd', 'matrix')
        before = dev.evaluate("testStore.readSeriesBundle('d').then(b=>JSON.stringify(b))")
        dev.evaluate("window.abortMatrix=true;window.matrixWrites=0;document.querySelector('#seriesMatrixBuild').click()")
        built()
        assert dev.evaluate("testStore.readSeriesBundle('d').then(b=>JSON.stringify(b))") == before
        assert '建帧失败' in dev.evaluate("document.querySelector('#seriesStatus').textContent")
        dev.evaluate("document.querySelector('#seriesMatrixBuild').click()")
        built()
        assert dev.evaluate("testStore.listShots('d').then(s=>s.length)") == 5
        # Independent queues still deduplicate inside the IndexedDB transaction.
        inserted = dev.evaluate("Promise.all([testStore,createSeriesStore()].map((store,i)=>store.appendMatrixShots('d',"
                                "[{id:'race'+i,seriesId:'d',origin:'matrix',axisValues:{custom:'same'},references:[]}]))).then(r=>r.map(s=>s.length).sort())")
        assert inserted == [0, 1]
        # A late build cannot recreate a deleted series.
        dev.evaluate("window.matrixGate={};document.querySelector('#seriesMatrixBuild').click()")
        dev.until('matrixGate.started')
        dev.evaluate("testStore.deleteSeries('d')")
        dev.evaluate('matrixGate.release();window.matrixGate=null')
        built()
        assert dev.evaluate("testStore.getSeries('d')") is None
        assert dev.evaluate("testStore.listShots('d')") == []
        assert stats()['generations'] == count
        print('PASS: variable preview/request/result equality for JSON and multipart, overrides, conflicts, old frames, '
              '1152 complete combinations, bounded build, concurrent/row/reordered dedup, unique axis IDs, '
              'atomic rollback, ownership/deletion, no generation on build, mobile')


if __name__ == '__main__':
    main()
