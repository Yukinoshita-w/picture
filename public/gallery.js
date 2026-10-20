(function (root) {
  'use strict';
  root.createArtGallery = function ({ safeImageSource, preview, download, reuse, notify, composeSeries }) {
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
    // Series albums are collapsed by default; this keeps the expanded state across the
    // frequent re-renders triggered by selection changes.
    const expandedSeries = new Set();
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
    // Series frames carry their own short label, so the gallery never falls back to the
    // long compiled prompt when a shot title exists.
    const headline = item => {
      if (item.shotTitle) return clip(String(item.shotTitle).replace(/\s+/g, ' ').trim(), 64);
      const text = String(item.prompt || '无题作品').replace(/\s+/g, ' ').trim();
      const sentence = text.split(/[。！？]/)[0] || text;
      return clip(sentence, 64);
    };
    const title = item => clip(String(item.shotTitle || item.prompt || '无题作品').replace(/\s+/g, ' ').trim(), 28);
    const seriesName = item => clip(String(item.seriesTitle || '未命名系列').replace(/\s+/g, ' ').trim(), 32);
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
      // Other pages (series) show "already collected" state from this same list.
      document.dispatchEvent(new CustomEvent('artgallery:change'));
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
    // One record shape for every source. Series frames keep enough context to be grouped
    // into an album and to show the originating frame in the cinema.
    function record(item, src) {
      const order = Number(item.shotOrder);
      return {
        id: item.id,
        src,
        prompt: String(item.prompt || ''),
        created: item.created || Date.now(),
        addedAt: Date.now(),
        selected: true,
        seriesId: String(item.seriesId || ''),
        seriesTitle: String(item.seriesTitle || '').slice(0, 60),
        shotCode: String(item.shotCode || '').slice(0, 12),
        shotTitle: String(item.shotTitle || '').slice(0, 40),
        shotOrder: Number.isFinite(order) ? order : 0
      };
    }
    // Returns false when the artwork is already in the gallery, so batch imports can count
    // the skipped items without treating them as failures.
    async function persist(item) {
      if (!item || !item.id) throw new Error('作品缺少标识');
      if (!safeImageSource(item.src)) throw new Error('图片来源无效');
      const existing = await store('readonly', storage => storage.get(item.id));
      if (existing) return false;
      const src = await permanentSource(item.src);
      // A regenerated frame gets a new asset id; replace its earlier copy so the album
      // keeps one entry per shot instead of stacking obsolete versions.
      if (item.seriesId && item.shotCode) {
        const siblings = await store('readonly', storage => storage.getAll());
        const stale = siblings.filter(art => art.seriesId === item.seriesId && art.shotCode === item.shotCode);
        if (stale.length) await store('readwrite', storage => stale.forEach(art => storage.delete(art.id)));
      }
      await store('readwrite', storage => storage.put(record(item, src)));
      return true;
    }
    async function submit(item) {
      if (submitting.has(item.id)) return;
      submitting.add(item.id);
      submissionState();
      try {
        let added = false;
        await enqueue(async () => {
          added = await persist(item);
          if (added) await read();
        });
        if (!added) return;
        notify('已提交至作品画廊，可在顶部“作品画廊”中查看。', 'success');
        status('作品已入藏，可在作品走廊中挑选放映。');
      } catch (error) {
        notify('提交画廊失败：' + (error.name === 'QuotaExceededError' ? '浏览器存储空间不足，请先下载或整理作品。' : error.message || '请检查浏览器存储权限后重试。'), 'error');
      } finally { submitting.delete(item.id); submissionState(); }
    }
    // Batch path used by the series workspace: one transaction per artwork, one re-render
    // at the end, and a report the caller can turn into a single status line.
    async function submitMany(list) {
      const report = { added: 0, skipped: 0, failed: 0, reasons: [] };
      for (const item of Array.isArray(list) ? list : []) {
        if (!item || !item.id) { report.failed += 1; continue; }
        if (submitting.has(item.id)) { report.skipped += 1; continue; }
        submitting.add(item.id);
        try {
          let added = false;
          await enqueue(async () => { added = await persist(item); });
          if (added) report.added += 1;
          else report.skipped += 1;
        } catch (error) {
          report.failed += 1;
          if (report.reasons.length < 3) report.reasons.push(error.name === 'QuotaExceededError' ? '浏览器存储空间不足' : error.message || '保存失败');
        } finally { submitting.delete(item.id); }
      }
      if (report.added) {
        try { await enqueue(read); }
        catch { status('作品已保存，但画廊刷新失败，请重新进入画廊。', true); }
      } else submissionState();
      return report;
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
    // ---------------------------------------------------------------- series albums

    // One album per series, placed in the shelf above the chronological wall. A 24-frame
    // series therefore costs one card instead of 24 tiles; the contact sheet only appears
    // after an explicit expand.
    function seriesGroups() {
      const map = new Map();
      for (const item of sorted()) {
        if (!item.seriesId) continue;
        let group = map.get(item.seriesId);
        if (!group) {
          group = { id: item.seriesId, title: item.seriesTitle || '未命名系列', items: [] };
          map.set(item.seriesId, group);
        }
        group.items.push(item);
        if (item.seriesTitle) group.title = item.seriesTitle;
      }
      const groups = [...map.values()];
      for (const group of groups) {
        group.items.sort((a, b) => (a.shotOrder || 0) - (b.shotOrder || 0) || a.created - b.created);
        group.cover = group.items[0];
        group.latest = Math.max(...group.items.map(item => item.created));
      }
      const direction = $('#gallerySort').value === 'oldest' ? 1 : -1;
      return groups.sort((a, b) => direction * (a.latest - b.latest));
    }

    function askRemove(item) {
      removalId = item.id;
      const text = $('#removeGalleryText');
      if (text) {
        text.textContent = item.seriesId
          ? '确定把这一帧移出画廊吗？系列与已生成的图片不受影响。'
          : '确定将这幅作品移出画廊吗？最近生成记录和已下载的文件不受影响。';
      }
      $('#removeGalleryDialog').returnValue = 'cancel';
      $('#removeGalleryDialog').showModal();
    }

    function frameTile(item) {
      const figure = document.createElement('figure'); figure.className = 'gallery-frame'; figure.dataset.artworkId = item.id;
      const open = makeButton('', () => preview(item.src, item.prompt), 'gallery-frame-open');
      open.setAttribute('aria-label', '欣赏作品：' + title(item));
      open.append(artworkImage(item));
      const choice = document.createElement('label'); choice.className = 'gallery-frame-choice';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected !== false;
      checkbox.dataset.selectionId = item.id;
      checkbox.setAttribute('aria-label', '加入放映：' + title(item));
      checkbox.addEventListener('change', () => changeSelection(new Map([[item.id, checkbox.checked]])));
      choice.append(checkbox);
      const caption = document.createElement('figcaption'); caption.className = 'gallery-frame-caption';
      const code = document.createElement('span'); code.className = 'gallery-frame-code'; code.textContent = item.shotCode || 'FRAME';
      const name = document.createElement('span'); name.className = 'gallery-frame-title'; name.textContent = title(item);
      const remove = makeButton('移出', () => askRemove(item), 'gallery-frame-remove');
      caption.append(code, name, remove);
      figure.append(open, choice, caption);
      return figure;
    }

    function albumCard(group) {
      const card = document.createElement('article'); card.className = 'gallery-album'; card.dataset.seriesId = group.id;
      const open = expandedSeries.has(group.id);
      card.classList.toggle('is-open', open);

      const cover = document.createElement('div'); cover.className = 'gallery-album-cover';
      cover.tabIndex = 0;
      cover.setAttribute('role', 'button');
      cover.setAttribute('aria-label', '欣赏系列封面：' + (group.title || '未命名系列'));
      const openCover = () => preview(group.cover.src, group.cover.prompt);
      cover.addEventListener('click', openCover);
      cover.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCover(); } });
      cover.append(artworkImage(group.cover, 'gallery-album-cover-main'));
      const count = document.createElement('span'); count.className = 'gallery-album-count';
      count.textContent = String(group.items.length).padStart(2, '0');
      cover.append(count);

      const info = document.createElement('div'); info.className = 'gallery-album-info';
      const eyebrow = document.createElement('span'); eyebrow.className = 'section-label'; eyebrow.textContent = 'Series Set';
      const name = document.createElement('h3'); name.textContent = group.title || '未命名系列';
      const meta = document.createElement('p'); meta.textContent = group.items.length + ' 帧 · ' + date(group.latest) + ' 更新';
      const actions = document.createElement('div'); actions.className = 'gallery-album-actions';
      const choiceLabel = document.createElement('label'); choiceLabel.className = 'gallery-album-choice';
      const choice = document.createElement('input'); choice.type = 'checkbox'; choice.dataset.seriesChoice = group.id;
      choice.setAttribute('aria-label', '整组加入放映：' + seriesName(group.cover));
      choice.addEventListener('change', () => {
        changeSelection(new Map(group.items.map(item => [item.id, choice.checked])));
      });
      choiceLabel.append(choice, '整组加入放映');

      const sheet = document.createElement('div'); sheet.className = 'gallery-album-sheet'; sheet.hidden = !open;
      sheet.append(...group.items.map(frameTile));

      const toggle = makeButton('', () => {
        const next = !expandedSeries.has(group.id);
        if (next) expandedSeries.add(group.id); else expandedSeries.delete(group.id);
        card.classList.toggle('is-open', next);
        sheet.hidden = !next;
        toggle.textContent = next ? '收起' : '展开 ' + group.items.length + ' 帧';
        toggle.setAttribute('aria-expanded', String(next));
      }, 'gallery-album-toggle');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '收起' : '展开 ' + group.items.length + ' 帧';
      actions.append(choiceLabel, toggle);
      info.append(eyebrow, name, meta, actions);
      card.append(cover, info, sheet);
      return card;
    }

    function seriesShelf(groups) {
      const section = document.createElement('section'); section.className = 'gallery-series';
      const heading = document.createElement('div'); heading.className = 'gallery-series-heading';
      const label = document.createElement('span'); label.className = 'section-label'; label.textContent = 'Series Sets';
      const titleNode = document.createElement('h2'); titleNode.textContent = '系列集';
      const hint = document.createElement('p'); hint.textContent = '一个系列收成一本。展开才看单帧，不必让整面墙被同一组画面占满。';
      const total = document.createElement('span'); total.className = 'gallery-series-total';
      total.textContent = String(groups.length).padStart(2, '0') + ' 组 · ' + groups.reduce((sum, group) => sum + group.items.length, 0) + ' 帧';
      const summary = document.createElement('div'); summary.className = 'gallery-series-summary';
      summary.append(label, titleNode, hint);
      heading.append(summary, total);
      const grid = document.createElement('div'); grid.className = 'gallery-series-grid';
      grid.append(...groups.map(albumCard));
      section.append(heading, grid);
      return section;
    }

    function timeline() {
      const fragment = document.createDocumentFragment();
      const albums = seriesGroups();
      if (albums.length) fragment.append(seriesShelf(albums));
      const groups = new Map();
      // Series frames live in their album, not on the day wall, so the shelf replaces a
      // potentially huge block of same-looking tiles.
      sorted().filter(item => !item.seriesId).forEach(item => {
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
          actions.append(makeButton('复用提示词', () => reuse(item.prompt)), makeButton('下载 ↗', event => download(item.src, event.currentTarget)), makeButton('移出画廊', () => askRemove(item)));
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
      const compose = $('#galleryCompose');
      if (compose) compose.disabled = !count || selectionBusy || typeof composeSeries !== 'function';
      $('#gallerySelectAll').disabled = selectionBusy || !items.length;
      $('#gallerySelectNone').disabled = selectionBusy || !count;
      document.querySelectorAll('[data-selection-id]').forEach(input => {
        input.checked = items.find(item => item.id === input.dataset.selectionId)?.selected !== false;
        input.disabled = selectionBusy;
      });
      // An album checkbox is checked only when every frame in it is selected.
      const albumMembers = new Map();
      for (const item of items) {
        if (!item.seriesId) continue;
        if (!albumMembers.has(item.seriesId)) albumMembers.set(item.seriesId, []);
        albumMembers.get(item.seriesId).push(item);
      }
      document.querySelectorAll('[data-series-choice]').forEach(input => {
        const members = albumMembers.get(input.dataset.seriesChoice) || [];
        const chosen = members.filter(item => item.selected !== false).length;
        input.checked = members.length > 0 && chosen === members.length;
        input.indeterminate = chosen > 0 && chosen < members.length;
        input.disabled = selectionBusy || !members.length;
      });
    }
    function render() {
      $('#galleryTotal').textContent = String(items.length).padStart(2, '0');
      $('#galleryEmpty').hidden = Boolean(items.length);
      // The chronological heading and its sort control only make sense once standalone
      // works exist; an all-series gallery is browsed through the shelf instead.
      const corridorToolbar = document.querySelector('.corridor-toolbar');
      if (corridorToolbar) corridorToolbar.hidden = !items.some(item => !item.seriesId);
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
      const seriesLine = $('#cinemaSeries');
      if (seriesLine) {
        seriesLine.textContent = item.seriesId
          ? seriesName(item) + (item.shotCode ? ' · ' + item.shotCode : '')
          : '';
        seriesLine.hidden = !seriesLine.textContent;
      }
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
    // Hand the selected artworks to the series workspace as existing frames.
    $('#galleryCompose')?.addEventListener('click', () => {
      if (typeof composeSeries !== 'function') return;
      const chosen = selected();
      if (!chosen.length) return;
      composeSeries(chosen.map(item => ({ id: item.id, src: item.src, prompt: item.prompt, created: item.created })));
    });
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
      setVisible(value) { visible = value; if (value) load(); else pause(); },
      // Used by the series workspace: batch import, membership checks and a manual refresh.
      submit, submitMany,
      contains: id => items.some(item => item.id === id),
      seriesCount: id => items.filter(item => item.seriesId === id).length,
      refresh: load
    };
  };
})(window);
