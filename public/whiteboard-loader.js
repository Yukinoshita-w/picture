(function () {
  'use strict';
  let pending;
  let instance;
  let active = false;
  async function load() {
    if (!pending) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '/whiteboard.vendor.css';
      const styles = new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = () => reject(new Error('白板样式加载失败'));
      });
      document.head.append(link);
      pending = Promise.all([import('/whiteboard.bundle.js'), styles]).then(([module]) => module.createWhiteboard({ gallery: window.ArtGallery }))
        .then(value => { instance = value; return value; })
        .catch(error => { pending = null; link.remove(); throw error; });
    }
    return pending;
  }
  window.GalleryWhiteboard = {
    get editor() { return instance; },
    async setVisible(value) {
      active = value;
      if (!value) { instance?.setVisible(false); return; }
      const panel = document.getElementById('galleryBoard');
      panel.setAttribute('aria-busy', 'true');
      try { const editor = await load(); await editor.setVisible(active); }
      catch (error) {
        const status = document.getElementById('wbStatus');
        status.hidden = false; status.dataset.error = 'true';
        status.textContent = '白板加载失败：' + error.message + '。请检查本地服务，并重新进入自由白板。';
      } finally { panel.setAttribute('aria-busy', 'false'); }
    }
  };
})();
