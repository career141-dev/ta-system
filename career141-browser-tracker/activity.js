(() => {
  // Aggregate event counts only: never inspect targets, input values or text.
  let clicks = 0, scrolls = 0;
  let movement = new Set();
  let lastScroll = 0;
  const visible = () => document.visibilityState === 'visible' && document.hasFocus();
  document.addEventListener('click', event => {
    if (event.isTrusted && visible()) clicks++;
  }, { passive: true, capture: true });
  document.addEventListener('scroll', event => {
    if (event.isTrusted && visible() && Date.now() - lastScroll > 250) {
      scrolls++;
      lastScroll = Date.now();
    }
  }, { passive: true, capture: true });
  document.addEventListener('mousemove', event => {
    if (event.isTrusted && visible()) movement.add(Math.floor(Date.now() / 1000));
  }, { passive: true });
  async function flush() {
    const payload = { type: 'activity', clicks, scrolls, movementSeconds: movement.size };
    clicks = scrolls = 0;
    movement.clear();
    if (!visible()) return;
    try { await chrome.runtime.sendMessage(payload); } catch { /* Reload after extension updates. */ }
  }
  setInterval(flush, 15000);
})();
