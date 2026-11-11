(() => {
  const dialog = document.querySelector('.screenshot-preview');
  const preview = dialog.querySelector('img');
  const caption = dialog.querySelector('.screenshot-preview__caption');
  const zoom = dialog.querySelector('.screenshot-preview__zoom');
  const setZoom = (enabled) => {
    dialog.classList.toggle('screenshot-preview--original', enabled);
    zoom.setAttribute('aria-pressed', String(enabled));
    zoom.textContent = enabled ? '适合屏幕' : '原图尺寸';
    dialog.scrollTop = 0;
    dialog.scrollLeft = 0;
  };

  document.querySelectorAll('.image-button').forEach((button) => {
    button.addEventListener('click', () => {
      const image = button.querySelector('img');
      const figure = button.closest('figure');
      preview.src = image.currentSrc || image.src;
      preview.alt = image.alt;
      caption.textContent = figure?.querySelector('figcaption strong')?.textContent || image.alt;
      setZoom(false);
      dialog.showModal();
    });
  });
  dialog.querySelector('.screenshot-preview__close').addEventListener('click', () => dialog.close());
  zoom.addEventListener('click', () => setZoom(zoom.getAttribute('aria-pressed') !== 'true'));
  preview.addEventListener('click', () => setZoom(zoom.getAttribute('aria-pressed') !== 'true'));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    preview.removeAttribute('src');
    setZoom(false);
  });

  // Direct links into a feature must reveal its closed disclosure first.
  const revealHash = () => {
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); }
    catch { return; }
    if (!target) return;
    for (let element = target; element; element = element.parentElement) {
      if (element.tagName === 'DETAILS') element.open = true;
    }
  };
  revealHash();
  window.addEventListener('hashchange', revealHash);
})();
