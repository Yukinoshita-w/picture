(function (root) {
  'use strict';
  root.createArtGallery = function ({ safeImageSource, preview, download, reuse, notify }) {
    const $ = selector => document.querySelector(selector);
    let database;
    let queue = Promise.resolve();
    let items = [];
    let view = 'corridor';
    let visible = false;
    let currentId = null;
    let playing = false;
    let timer;
    let removalId = null;
    let selectionBusy = false;
    const submitting = new Set();
    const date = value => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    // Cut at a natural boundary so a headline never ends mid-word ("Bongo Ca").
    function clip(text, limit) {
      if (text.length <= limit) return text;
      const window = text.slice(0, limit);
      const boundary = Math.max(
        window.lastIndexOf('，'), window.lastIndexOf('。'), window.lastIndexOf('、'),
        window.lastIndexOf('；'), window.lastIndexOf('：'), window.lastIndexOf(' '),
        window.lastIndexOf('（'), window.lastIndexOf(',')
      );
      if (boundary >= limit * 0.45) return window.slice(0, boundary);
      return window.replace(/[\s，。、；：,]+$/, '') + '…';
    }
    const headline = item => {
      const text = String(item.prompt || '无题作品').replace(/\s+/g, ' ').trim();
      const sentence = text.split(/[。！？]/)[0] || text;
      return clip(sentence, 64);
    };
    const title = item => clip(String(item.prompt || '无题作品').replace(/\s+/g, ' ').trim(), 28);
    function status(message, error = false) {
      $('#galleryStatus').textContent = message;
      $('#galleryStatus').hidden = !message;
      $('#galleryStatus').dataset.type = error ? 'error' : 'success';
    }
    function db() {
      if (!database) database = new Promise((resolve, reject) => {
        const request = indexedDB.open('prompt-studio-gallery', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('artworks', { keyPath: 'id' });
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); database = null; };
          resolve(request.result);
        };
        request.onerror = () => { database = null; reject(request.error); };
        request.onblocked = () => { database = null; reject(new Error('画廊存储被其他页面占用，请关闭其他页面后重试。')); };
      });
      return database;
    }
    async function store(mode, action) {
      const connection = await db();
      return new Promise((resolve, reject) => {
        const tx = connection.transaction('artworks', mode);
        let result;
        try { result = action(tx.objectStore('artworks')); }
        catch (error) { tx.abort(); reject(error); return; }
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('存储失败'));
      });
    }
    function enqueue(action) {
      const pending = queue.then(action);
      queue = pending.catch(() => {});
      return pending;
    }
    function sorted() {
      const direction = $('#gallerySort').value === 'oldest' ? 1 : -1;
      return [...items].sort((a, b) => direction * (a.created - b.created || a.addedAt - b.addedAt));
    }
    function selected() { return sorted().filter(item => item.selected !== false); }
    function submissionState() {
      document.querySelectorAll('.gallery-submit').forEach(button => {
        const id = button.dataset.artworkId;
        const saved = items.some(item => item.id === id);
        button.disabled = saved || submitting.has(id);
        button.textContent = saved ? '已入藏' : submitting.has(id) ? '提交中…' : '提交画廊';
      });
    }
    async function read() {
      items = (await store('readonly', storage => storage.getAll())).filter(item => safeImageSource(item.src));
      render();
      submissionState();
    }
    async function load() {
      try { await enqueue(read); }
      catch { status('无法读取画廊，请检查浏览器存储权限后重新进入画廊。', true); }
    }
    async function permanentSource(src) {
      if (!safeImageSource(src)) throw new Error('图片来源无效');
      if (src.startsWith('data:')) return src;
      const response = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: src }) });
      if (!response.ok) throw new Error('无法保存图片，链接可能已过期，请稍后重试。');
      const blob = await response.blob();
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(blob);
      });
      if (!safeImageSource(data)) throw new Error('暂不支持将此图片格式保存至画廊。');
      return data;
    }
    async function submit(item) {
      if (submitting.has(item.id)) return;
      submitting.add(item.id);
      submissionState();
      try {
        await enqueue(async () => {
          const existing = await store('readonly', storage => storage.get(item.id));
          if (!existing) {
            const src = await permanentSource(item.src);
            await store('readwrite', storage => storage.put({ id: item.id, src, prompt: String(item.prompt || ''), created: item.created || Date.now(), addedAt: Date.now(), selected: true }));
          }
          await read();
        });
        notify('已提交至作品画廊，可在顶部“作品画廊”中查看。', 'success');
        status('作品已入藏，可在作品走廊中挑选放映。');
      } catch (error) {
        notify('提交画廊失败：' + (error.name === 'QuotaExceededError' ? '浏览器存储空间不足，请先下载或整理作品。' : error.message || '请检查浏览器存储权限后重试。'), 'error');
      } finally { submitting.delete(item.id); submissionState(); }
    }
    function submitButton(item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'download-link gallery-submit';
      button.dataset.artworkId = item.id;
      button.textContent = items.some(art => art.id === item.id) ? '已入藏' : '提交画廊';
      button.disabled = items.some(art => art.id === item.id) || submitting.has(item.id);
      button.addEventListener('click', () => submit(item));
      return button;
    }
    function makeButton(label, action, className = '') {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.className = className;
      button.addEventListener('click', action);
      return button;
    }
    function artworkImage(item, className = '') {
      const image = document.createElement('img');
      image.src = item.src; image.alt = title(item); image.loading = 'lazy'; image.className = className;
      image.addEventListener('error', () => { image.alt = '图片无法显示，可尝试下载原图'; image.classList.add('image-load-error'); });
      return image;
    }
    function timeline() {
      const fragment = document.createDocumentFragment();
      const groups = new Map();
      sorted().forEach(item => {
        const key = date(item.created);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
      let serial = 0;
      for (const [day, artworks] of groups) {
        const section = document.createElement('section'); section.className = 'gallery-day';
        const heading = document.createElement('div'); heading.className = 'gallery-day-heading';
        const stamp = document.createElement('h2'); stamp.textContent = day;
        const total = document.createElement('span'); total.textContent = String(artworks.length).padStart(2, '0') + ' 件作品';
        heading.append(stamp, total);
        const grid = document.createElement('div'); grid.className = 'gallery-wall';
        for (const item of artworks) {
          const card = document.createElement('article'); card.className = 'gallery-art'; card.dataset.artworkId = item.id;
          const frame = makeButton('', () => preview(item.src, item.prompt), 'gallery-art-frame');
          frame.setAttribute('aria-label', '欣赏作品：' + title(item));
          frame.append(artworkImage(item));
          const choice = document.createElement('label'); choice.className = 'gallery-art-choice';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected !== false;
          checkbox.dataset.selectionId = item.id;
          checkbox.setAttribute('aria-label', '加入放映：' + title(item));
          checkbox.addEventListener('change', () => changeSelection(new Map([[item.id, checkbox.checked]])));
          choice.append(checkbox, '加入放映');
          const caption = document.createElement('div'); caption.className = 'gallery-art-caption';
          const number = document.createElement('span'); number.className = 'gallery-art-number'; number.textContent = String(++serial).padStart(3, '0');
          const name = document.createElement('h3'); name.textContent = title(item);
          const prompt = document.createElement('p'); prompt.textContent = item.prompt;
          const time = document.createElement('time'); time.dateTime = new Date(item.created).toISOString(); time.textContent = new Date(item.created).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          caption.append(number, name, prompt, time);
          const actions = document.createElement('div'); actions.className = 'gallery-art-actions';
          actions.append(makeButton('复用提示词', () => reuse(item.prompt)), makeButton('下载 ↗', event => download(item.src, event.currentTarget)), makeButton('移出画廊', () => {
            removalId = item.id;
            $('#removeGalleryDialog').returnValue = 'cancel';
            $('#removeGalleryDialog').showModal();
          }));
          card.append(choice, frame, caption, actions); grid.append(card);
        }
        section.append(heading, grid); fragment.append(section);
      }
      $('#galleryTimeline').replaceChildren(fragment);
    }
    async function changeSelection(changes) {
      if (selectionBusy) { selectionUI(); return; }
      selectionBusy = true; selectionUI();
      try {
        await enqueue(async () => {
          const updates = items.filter(item => changes.has(item.id)).map(item => ({ ...item, selected: changes.get(item.id) }));
          await store('readwrite', storage => updates.forEach(item => storage.put(item)));
          items = items.map(item => updates.find(update => update.id === item.id) || item);
        });
        pause(); drawSlide();
      } catch { status('未能保存放映选择，请检查浏览器存储权限后重试。', true); }
      finally { selectionBusy = false; selectionUI(); }
    }
    function selectionUI() {
      const count = selected().length;
      $('#gallerySelectionCount').textContent = '已选 ' + count + ' / ' + items.length + ' 件';
      $('#galleryLaunch').disabled = !count || selectionBusy;
      $('#gallerySelectAll').disabled = selectionBusy || !items.length;
      $('#gallerySelectNone').disabled = selectionBusy || !count;
      document.querySelectorAll('[data-selection-id]').forEach(input => {
        input.checked = items.find(item => item.id === input.dataset.selectionId)?.selected !== false;
        input.disabled = selectionBusy;
      });
    }
    function render() {
      $('#galleryTotal').textContent = String(items.length).padStart(2, '0');
      $('#galleryEmpty').hidden = Boolean(items.length);
      $('#galleryCorridor').hidden = !items.length || view !== 'corridor';
      $('#galleryCinema').hidden = !items.length || view !== 'cinema';
      timeline(); selectionUI(); drawSlide();
    }
    function setView(value) {
      view = value; pause();
      document.querySelectorAll('[data-gallery-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.galleryView === view)));
      $('#galleryCorridor').hidden = !items.length || view !== 'corridor';
      $('#galleryCinema').hidden = !items.length || view !== 'cinema';
      drawSlide();
    }
    function pause() {
      playing = false; clearTimeout(timer);
    }
    function schedule() {
      clearTimeout(timer);
      if (!playing || !visible || view !== 'cinema' || document.hidden || selected().length < 2) return;
      timer = setTimeout(() => step(1), 8000);
    }
    function play() {
      if (selected().length < 2) return;
      playing = true; schedule();
    }
    function step(direction) {
      const slides = selected(); if (!slides.length) return;
      const index = Math.max(0, slides.findIndex(item => item.id === currentId));
      currentId = slides[(index + direction + slides.length) % slides.length].id;
      drawSlide();
    }
    function drawSlide() {
      const slides = selected();
      $('#cinemaEmpty').hidden = Boolean(slides.length);
      $('#cinemaContent').hidden = !slides.length;
      if (!slides.length) { currentId = null; pause(); return; }
      let index = slides.findIndex(item => item.id === currentId);
      if (index < 0) index = 0;
      const item = slides[index]; currentId = item.id;
      const image = $('#cinemaImage');
      image.alt = title(item);
      if (image.getAttribute('src') !== item.src) {
        image.src = item.src;
        const frame = $('#cinemaMainFrame'); frame.classList.remove('is-entering'); void frame.offsetWidth; frame.classList.add('is-entering');
      }
      $('#cinemaPreviousImage').src = slides[(index - 1 + slides.length) % slides.length].src;
      $('#cinemaNextImage').src = slides[(index + 1) % slides.length].src;
      $('#cinemaTitle').textContent = headline(item);
      $('#cinemaPrompt').textContent = item.prompt;
      $('#cinemaDate').textContent = date(item.created) + ' / PRIVATE COLLECTION';
      const plate = $('#cinemaPlate');
      if (plate) plate.textContent = 'PLATE ' + String(index + 1).padStart(3, '0');
      const chars = $('#cinemaChars');
      if (chars) chars.textContent = String((item.prompt || '').length) + ' 字';
      const reuseButton = $('#cinemaReuse');
      if (reuseButton) reuseButton.onclick = () => reuse(item.prompt);
      const downloadButton = $('#cinemaDownload');
      if (downloadButton) downloadButton.onclick = event => download(item.src, event.currentTarget);
      $('#cinemaFrameNumber').textContent = 'PLATE ' + String(index + 1).padStart(3, '0');
      $('#cinemaCounter').textContent = String(index + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
      for (const id of ['cinemaPreviousFrame', 'cinemaNextFrame']) $('#' + id).disabled = slides.length < 2;
      if (slides.length < 2) pause();
      schedule();
    }
    document.querySelectorAll('[data-gallery-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.galleryView)));
    $('#galleryLaunch').addEventListener('click', () => { setView('cinema'); play(); });
    $('#cinemaChoose').addEventListener('click', () => setView('corridor'));
    $('#gallerySort').addEventListener('change', () => { pause(); render(); });
    $('#gallerySelectAll').addEventListener('click', () => changeSelection(new Map(items.map(item => [item.id, true]))));
    $('#gallerySelectNone').addEventListener('click', () => changeSelection(new Map(items.map(item => [item.id, false]))));
    $('#cinemaPreviousFrame').addEventListener('click', () => step(-1));
    $('#cinemaNextFrame').addEventListener('click', () => step(1));
    $('#cinemaStage').addEventListener('keydown', event => {
      if (event.target !== event.currentTarget) return;
      if (['ArrowLeft', 'ArrowRight', ' '].includes(event.key)) {
        event.preventDefault();
        if (event.key === ' ') playing ? pause() : play();
        else step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    $('#removeGalleryDialog').addEventListener('close', async event => {
      const id = removalId; removalId = null;
      if (event.target.returnValue !== 'remove' || id === null) return;
      try { await enqueue(async () => { await store('readwrite', storage => storage.delete(id)); pause(); await read(); }); status('作品已移出画廊。'); }
      catch { status('移除失败，请检查浏览器存储权限后重试。', true); }
    });
    return {
      submitButton, init: load,
      setVisible(value) { visible = value; if (value) load(); else pause(); }
    };
  };
})(window);
