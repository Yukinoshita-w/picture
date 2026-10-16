(function (root) {
  'use strict';
  root.createSizePicker = function ({ select, getCapabilities, onChange }) {
    const $ = selector => document.querySelector(selector);
    const dialog = $('#sizeDialog');
    const ratios = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9'];
    let draft = 'default';
    let mode = 'auto';
    let resolution = 1024;
    let ratio = '1:1';
    let customRatio = false;
    const label = value => value === 'default' ? '由接口决定' : value === 'auto' ? '自动' : value.replace('x', ' × ');
    const supported = value => ModelCapabilities.supportsSize(getCapabilities(), value);
    const tier = value => {
      const longest = Math.max(...value.split('x').map(Number));
      return longest < 1800 ? 1024 : longest <= 2048 ? 2048 : 4096;
    };
    function ratioSize(value, base = resolution) {
      const [width, height] = value.split(':').map(Number);
      if (![width, height].every(side => Number.isInteger(side) && side >= 1 && side <= 100)) return '';
      const standard = getCapabilities().sizes.find(size => {
        if (!ModelCapabilities.isCustomSize(size)) return false;
        const [w, h] = size.split('x').map(Number);
        return w * height === h * width && Math.max(w, h) >= 768 && tier(size) === base;
      });
      if (standard) return standard;
      const scale = base / Math.max(width, height);
      return [width, height].map(side => Math.round(side * scale / 8) * 8).join('x');
    }
    function sync() {
      $('#sizeButtonLabel').textContent = label(select.value || 'default');
      $('#sizeButton').setAttribute('aria-label', '设置图像尺寸，当前：' + label(select.value || 'default'));
    }
    function seed(value) {
      draft = value;
      customRatio = false;
      if (['default', 'auto'].includes(value)) {
        mode = 'auto';
        ratio = '1:1';
        resolution = 1024;
      } else {
        const [width, height] = value.split('x').map(Number);
        resolution = tier(value);
        const matching = ratios.find(item => {
          const [w, h] = item.split(':').map(Number);
          return width * h === height * w;
        });
        ratio = matching || '1:1';
        mode = matching && ratioSize(matching) === value ? 'ratio' : 'custom';
        $('#sizeWidth').value = width;
        $('#sizeHeight').value = height;
      }
    }
    function render() {
      const capabilities = getCapabilities();
      $('#sizeCurrent').textContent = '当前：' + (draft ? label(draft) : '请输入有效尺寸');
      $('#sizeDefault').setAttribute('aria-pressed', String(draft === 'default'));
      dialog.querySelectorAll('[data-size-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sizeMode === mode)));
      $('#sizeAutoPanel').hidden = mode !== 'auto';
      $('#sizeRatioPanel').hidden = mode !== 'ratio';
      $('#sizeCustomPanel').hidden = mode !== 'custom';
      $('#sizeRatioInputs').hidden = !customRatio;
      $('#sizeCustomRatio').setAttribute('aria-expanded', String(customRatio));
      $('#sizeCustomRatio').setAttribute('aria-pressed', String(customRatio));
      dialog.querySelectorAll('[data-resolution]').forEach(button => {
        const value = Number(button.dataset.resolution);
        button.setAttribute('aria-pressed', String(value === resolution));
        button.disabled = !capabilities.customSizes && !capabilities.sizes.some(size => ModelCapabilities.isCustomSize(size) && Math.max(...size.split('x').map(Number)) >= 768 && tier(size) === value);
      });
      dialog.querySelectorAll('[data-ratio]').forEach(button => {
        const size = ratioSize(button.dataset.ratio);
        button.disabled = !supported(size);
        button.title = label(size) + (button.disabled ? ' · 当前配置不支持' : '');
        button.setAttribute('aria-pressed', String(!customRatio && button.dataset.ratio === ratio && draft === size));
      });
      dialog.querySelectorAll('[data-standard-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.standardSize === draft)));
      $('#sizeSupportedPanel').hidden = mode === 'auto' || !$('#sizeSupported').children.length;
      $('#sizeCapabilityHint').hidden = mode === 'auto' || capabilities.customSizes === true;
      let error = '';
      if (!['default', 'auto'].includes(draft) && !ModelCapabilities.isCustomSize(draft)) {
        error = customRatio ? '请输入 1–100 的整数比例，计算后的每边须为 64–8192 像素。' : '宽高须为 64–8192 之间的整数，且为 8 的倍数。';
      } else if (!supported(draft)) error = '当前能力配置不支持此尺寸，请选择接口标准尺寸或由接口决定。';
      $('#sizeError').textContent = error;
      $('#sizeError').hidden = !error;
      $('#applySize').disabled = Boolean(error);
    }
    function button(text, action) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'size-option';
      element.textContent = text;
      element.addEventListener('click', action);
      return element;
    }
    [1024, 2048, 4096].forEach(base => {
      const option = button((base / 1024) + 'K', () => {
        resolution = base;
        draft = ratioSize(ratio);
        render();
      });
      option.dataset.resolution = base;
      $('#sizeResolutions').append(option);
    });
    ratios.forEach(value => {
      const option = button('', () => {
        customRatio = false;
        ratio = value;
        draft = ratioSize(ratio);
        render();
      });
      option.dataset.ratio = value;
      const icon = document.createElement('span');
      icon.className = 'ratio-icon';
      icon.setAttribute('aria-hidden', 'true');
      const [width, height] = value.split(':').map(Number);
      icon.style.width = (18 * width / Math.max(width, height)) + 'px';
      icon.style.height = (18 * height / Math.max(width, height)) + 'px';
      const text = document.createElement('span');
      text.textContent = value;
      option.append(icon, text);
      $('#sizeRatios').append(option);
    });
    $('#sizeButton').addEventListener('click', () => {
      seed(select.value || 'default');
      $('#sizeSupported').replaceChildren(...getCapabilities().sizes.filter(ModelCapabilities.isCustomSize).map(value => {
        const option = button(label(value), () => { seed(value); render(); });
        option.dataset.standardSize = value;
        return option;
      }));
      render();
      dialog.showModal();
    });
    $('#sizeDefault').addEventListener('click', () => { seed('default'); render(); });
    dialog.querySelectorAll('[data-size-mode]').forEach(element => element.addEventListener('click', () => {
      mode = element.dataset.sizeMode;
      if (mode === 'auto') draft = getCapabilities().sizes.includes('auto') ? 'auto' : 'default';
      else if (mode === 'ratio') draft = ratioSize(ratio);
      else {
        if (ModelCapabilities.isCustomSize(draft)) {
          const [w, h] = draft.split('x');
          $('#sizeWidth').value = w;
          $('#sizeHeight').value = h;
        }
        draft = $('#sizeWidth').value + 'x' + $('#sizeHeight').value;
      }
      render();
    }));
    $('#sizeCustomRatio').addEventListener('click', () => {
      customRatio = !customRatio;
      if (customRatio) {
        const [w, h] = ratio.split(':');
        $('#sizeRatioWidth').value = w;
        $('#sizeRatioHeight').value = h;
      }
      render();
      if (customRatio) $('#sizeRatioWidth').focus();
    });
    for (const selector of ['#sizeRatioWidth', '#sizeRatioHeight']) $(selector).addEventListener('input', () => {
      ratio = $('#sizeRatioWidth').value + ':' + $('#sizeRatioHeight').value;
      draft = ratioSize(ratio);
      render();
    });
    for (const selector of ['#sizeWidth', '#sizeHeight']) $(selector).addEventListener('input', () => {
      draft = $('#sizeWidth').value + 'x' + $('#sizeHeight').value;
      render();
    });
    for (const selector of ['#closeSizeDialog', '#cancelSizeDialog']) $(selector).addEventListener('click', () => dialog.close());
    $('#applySize').addEventListener('click', () => {
      if (!supported(draft)) { render(); return; }
      if (![...select.options].some(option => option.value === draft)) select.add(new Option(label(draft), draft));
      select.value = draft;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      dialog.close();
    });
    select.addEventListener('change', () => { sync(); onChange(); });
    return { sync };
  };
})(window);
