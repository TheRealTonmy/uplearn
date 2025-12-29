// content.js
// -------------------------------------------------------------
// Features:
// 1) Auto-Advance: repeatedly clicks "Submit" then "Continue".
// 2) Anti-Pause: keeps videos playing when tab is in background
//    by faking page visibility/focus and re-playing videos.
// -------------------------------------------------------------

/** ======= Config ======= **/
const CHECK_INTERVAL_MS = 1500;       // how often to look for buttons
const CLICK_COOLDOWN_MS = 800;        // minimal delay between clicks
const MAX_CLICK_RETRIES = 2;          // retry clicks if blocked by UI
const DEBUG = false;                  // set true to see logs

// Expand these if your site uses special classes or attributes
const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button[aria-label="Submit"]',
  '[data-test="submit"], [data-testid="submit"]',
  '.submit, .btn-submit, .Button--submit',
  '.u-btn-submit', '.u-btn-check'
];
const CONTINUE_BUTTON_SELECTORS = [
  'button[aria-label="Continue"]',
  '[data-test="continue"], [data-testid="continue"]',
  '.continue, .btn-continue, .Button--continue',
  '.u-btn-continue'
];
// If buttons are plain text without special attributes/classes:
const SUBMIT_TEXT_REGEX = /(submit|check|confirm|finish|turn[ -]?in)/i;
const CONTINUE_TEXT_REGEX = /(continue|next|proceed|go on)/i;

// Anti-pause tuning
const VIDEO_POLL_MS = 1200;           // how often to ensure videos keep playing
const MUTE_VIDEOS_WHEN_FORCED = true; // set false if you want sound on (risk of autoplay block)
const DESIRED_PLAYBACK_RATE = null;   // e.g. 1.0, 1.25; or null to leave unchanged

/** ======= State ======= **/
let autoAdvanceTimer = 0;
let lastClickAt = 0;
let lastSubmitEl = null;
let lastContinueEl = null;
let observer = null;

let antiPauseArmed = false;
let videoKeeperTimer = 0;

/** ======= Utilities ======= **/
function dlog(...args) { if (DEBUG) console.log('[AutoAdvance]', ...args); }

function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const visible = (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.left <= (window.innerWidth || document.documentElement.clientWidth)
  );
  const style = window.getComputedStyle(el);
  return visible && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
}

function includesText(el, regex) {
  if (!el) return false;
  const text = (el.getAttribute('aria-label') || '') + ' ' +
               (el.getAttribute('title') || '') + ' ' +
               (el.innerText || '') + ' ' +
               (el.value || '');
  return regex.test(text.trim());
}

function clickElement(el) {
  if (!el) return;
  try {
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    el.click();
  } catch (e) {
    dlog('Direct click failed, fallback', e);
    try { el.click(); } catch {}
  }
}

function requestFormSubmitFrom(el) {
  const form = el?.closest?.('form');
  if (form) {
    try { form.requestSubmit ? form.requestSubmit() : form.submit(); }
    catch (e) { dlog('Form submit fallback failed', e); }
  }
}

/** ======= Button Finders ======= **/
function findBySelectors(selectors) {
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    for (const n of nodes) {
      if (isElementVisible(n)) return n;
    }
  }
  return null;
}
function findByText(regex) {
  const candidates = document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], a, [role="button"]'
  );
  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    if (includesText(el, regex)) return el;
  }
  return null;
}
function findSubmitButton() {
  return findBySelectors(SUBMIT_BUTTON_SELECTORS) || findByText(SUBMIT_TEXT_REGEX);
}
function findContinueButton() {
  return findBySelectors(CONTINUE_BUTTON_SELECTORS) || findByText(CONTINUE_TEXT_REGEX);
}

/** ======= Core loop ======= **/
async function checkAndAdvance() {
  const now = Date.now();
  if (now - lastClickAt < CLICK_COOLDOWN_MS) return;

  // Prefer Submit; else Continue
  let submit = findSubmitButton();
  if (submit) {
    lastSubmitEl = submit;
    await tryClickWithRetries(submit);
    lastClickAt = Date.now();
    dlog('Clicked Submit');
    requestFormSubmitFrom(submit); // in case site needs real form submit
    return;
  }

  let cont = findContinueButton();
  if (cont) {
    lastContinueEl = cont;
    await tryClickWithRetries(cont);
    lastClickAt = Date.now();
    dlog('Clicked Continue');
  }
}

async function tryClickWithRetries(el) {
  for (let i = 0; i <= MAX_CLICK_RETRIES; i++) {
    clickElement(el);
    await sleep(150);
    // consider success if element disappears or becomes disabled/hidden
    if (!document.contains(el) || el.disabled || !isElementVisible(el)) break;
    await sleep(200);
  }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

/** ======= Observer (react to SPA changes quickly) ======= **/
function startDomObserver() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    let changed = false;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) { changed = true; break; }
      if (m.type === 'attributes' && (m.attributeName === 'class' || m.attributeName === 'style')) { changed = true; break; }
    }
    if (changed) {
      clearTimeout(startDomObserver._deb);
      startDomObserver._deb = setTimeout(checkAndAdvance, 120);
    }
  });
  observer.observe(document.documentElement, { childList: true, attributes: true, subtree: true });
}
function stopDomObserver() {
  if (!observer) return;
  observer.disconnect(); observer = null;
}

/** ======= Anti-Pause (force visibility/focus + keep videos playing) ======= **/
// Fake document.visibilityState / document.hidden / document.hasFocus to look "active".
function armAntiPause() {
  if (antiPauseArmed) return;
  antiPauseArmed = true;

  try {
    // Patch document.hidden and vendor-prefixed
    const setFalse = (obj, prop) => {
      try {
        Object.defineProperty(obj, prop, { get: () => false, configurable: true });
      } catch {}
    };
    setFalse(document, 'hidden');
    setFalse(document, 'webkitHidden');
    // visibilityState -> "visible"
    try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    } catch {}

    // hasFocus -> true
    try {
      document.hasFocus = () => true;
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
    } catch {}

    // Block visibility/blur/pagehide/freeze events from reaching site handlers
    const blocker = (e) => {
      try { e.stopImmediatePropagation(); e.stopPropagation(); } catch {}
      // For visibilitychange, also force values to "visible"
      try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      } catch {}
    };

    window.addEventListener('visibilitychange', blocker, true);
    window.addEventListener('webkitvisibilitychange', blocker, true);
    window.addEventListener('blur', blocker, true);
    window.addEventListener('pagehide', blocker, true);
    window.addEventListener('freeze', blocker, true);

    // Periodically dispatch a fake "visibilitychange" stating we're visible
    setInterval(() => {
      try {
        const evt = new Event('visibilitychange', { bubbles: true, cancelable: true });
        document.dispatchEvent(evt);
      } catch {}
    }, 3000);
  } catch (e) {
    dlog('Anti-pause patch error', e);
  }

  // Keep videos playing
  if (!videoKeeperTimer) {
    videoKeeperTimer = setInterval(() => {
      const vids = document.querySelectorAll('video');
      vids.forEach(v => {
        // If site muted you in background, keep it muted (or enforce if desired)
        if (MUTE_VIDEOS_WHEN_FORCED && !v.muted) {
          try { v.muted = true; } catch {}
        }
        // Keep playback rate (optional)
        if (typeof DESIRED_PLAYBACK_RATE === 'number' && v.playbackRate !== DESIRED_PLAYBACK_RATE) {
          try { v.playbackRate = DESIRED_PLAYBACK_RATE; } catch {}
        }
        // If paused, try to play
        if (v.paused) {
          v.play().catch(() => {
            // As a fallback, toggle muted true and try again (bypasses autoplay policies)
            try { v.muted = true; } catch {}
            v.play().catch(() => {});
          });
        }
      });
    }, VIDEO_POLL_MS);
  }
}

function disarmAntiPause() {
  antiPauseArmed = false;
  if (videoKeeperTimer) { clearInterval(videoKeeperTimer); videoKeeperTimer = 0; }
  // We intentionally do not unpatch visibility/focus to avoid site quirks when toggling.
}

/** ======= Loop control ======= **/
function startAutoAdvance() {
  if (autoAdvanceTimer) return;
  startDomObserver();
  autoAdvanceTimer = window.setInterval(checkAndAdvance, CHECK_INTERVAL_MS);
  dlog('Auto-Advance started');
  setBadge(true);
  armAntiPause(); // ensure anti-pause is on while auto-advancing
}

function stopAutoAdvance() {
  if (!autoAdvanceTimer) return;
  clearInterval(autoAdvanceTimer);
  autoAdvanceTimer = 0;
  stopDomObserver();
  dlog('Auto-Advance stopped');
  setBadge(false);
  // Leave anti-pause armed to keep video running if you want; comment next line to keep it on.
  // disarmAntiPause();
}

/** ======= UI (floating toggle) ======= **/
let panel, toggleEl, submitLbl, contLbl;

function ensureUI() {
  if (panel) return;

  panel = document.createElement('div');
  panel.id = 'auto-advance-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    zIndex: 999999999,
    bottom: '16px',
    right: '16px',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    fontSize: '12px',
    background: 'rgba(20,20,20,.85)',
    color: '#fff',
    borderRadius: '12px',
    padding: '10px 12px',
    boxShadow: '0 6px 18px rgba(0,0,0,.3)',
    backdropFilter: 'saturate(140%) blur(6px)',
    userSelect: 'none',
    cursor: 'default'
  });

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <strong style="font-weight:700;">Auto-Advance</strong>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input id="aa-toggle" type="checkbox" />
        <span id="aa-toggle-label">Off</span>
      </label>
      <span style="opacity:.7;">(press <kbd style="background:#333;border-radius:4px;padding:1px 4px;">Alt</kbd>+<kbd style="background:#333;border-radius:4px;padding:1px 4px;">A</kbd>)</span>
    </div>
    <div style="margin-top:6px;display:flex;gap:10px;opacity:.9;">
      <span id="aa-submit" title="Last Submit">Submit: —</span>
      <span id="aa-cont" title="Last Continue">Continue: —</span>
    </div>
  `;

  document.documentElement.appendChild(panel);
  toggleEl = panel.querySelector('#aa-toggle');
  submitLbl = panel.querySelector('#aa-submit');
  contLbl = panel.querySelector('#aa-cont');

  toggleEl.addEventListener('change', () => {
    if (toggleEl.checked) startAutoAdvance();
    else stopAutoAdvance();
    panel.querySelector('#aa-toggle-label').textContent = toggleEl.checked ? 'On' : 'Off';
  });

  // draggable
  makeDraggable(panel);
}

function makeDraggable(el) {
  let isDown = false, sx = 0, sy = 0, startLeft = 0, startTop = 0;
  el.addEventListener('mousedown', (e) => {
    if (e.target && (e.target.id === 'aa-toggle')) return; // don't drag on checkbox
    isDown = true;
    sx = e.clientX; sy = e.clientY;
    const rect = el.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    if (!isDown) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    el.style.left = `${startLeft + dx}px`;
    el.style.top  = `${startTop + dy}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function onUp() {
    isDown = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

function setBadge(active) {
  if (!panel) return;
  panel.style.outline = active ? '2px solid #22c55e' : 'none';
}

/** ======= Status pings ======= **/
function updateStatus() {
  if (submitLbl) submitLbl.textContent = 'Submit: ' + (lastSubmitEl ? 'seen' : '—');
  if (contLbl) contLbl.textContent = 'Continue: ' + (lastContinueEl ? 'seen' : '—');
}

/** ======= Hotkey ======= **/
function bindHotkey() {
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyA') {
      e.preventDefault();
      ensureUI();
      toggleEl.checked = !toggleEl.checked;
      toggleEl.dispatchEvent(new Event('change', {bubbles: true}));
    }
  }, {capture: true});
}

/** ======= Init ======= **/
(function init() {
  ensureUI();
  bindHotkey();
  // Update small status line every few seconds (optional)
  setInterval(updateStatus, 2000);

  // Arm anti-pause immediately so videos keep going even before toggling
  armAntiPause();

  dlog('content.js initialized');
})();
