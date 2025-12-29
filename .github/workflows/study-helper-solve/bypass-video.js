
// bypass-video.js — Auto up to 5x (safe), UpLearn/Wistia focused
// - Runs as fast as safely possible: 5x when calm, auto-drops to safe rate near questions
// - Deep <video> discovery (shadow DOM aware)
// - Question-safe, step-based advancement + pre-question rewind
// - Background play (visibility spoof + keep-alive)
// - Right-click restored
//
// Hotkeys:
//   Ctrl+Shift+B — toggle bypass ON/OFF
//   Ctrl+Shift+Q — toggle question-aware ON/OFF
//
// Tuning constants (adjust if needed)
const FAST_RATE = 3.75;    // target speed when calm
const SAFE_RATE = 3.5;   // fallback speed when question/overlay activity is detected
const SLOW_RATE = 3;    // stricter slow mode speed
const STEP_FAST = 2.0;    // seconds per step when calm
const STEP_SLOW = 0.5;    // seconds per step in slow mode
const STEP_INTERVAL_MS = 250; // how often we step
const REWIND_BUFFER_SEC = 3.0; // how far to rewind before a question
const MUTATION_SPIKE = 120;    // #mutations/sec that indicates overlay is building
const SLOW_MODE_WINDOW_MS = 2500; // how long to stay in slow mode after spike
const POST_STEP_CHECK_MS = 160;    // check right after step for new overlays

(function () {
  const ENABLE_KEY = 'study_helper_bypass_video_enabled';
  const QUESTION_AWARE_KEY = 'study_helper_question_aware_enabled';

  let enabled = true;
  let questionAware = true;
  try { enabled = localStorage.getItem(ENABLE_KEY) !== 'false'; } catch {}
  try { questionAware = localStorage.getItem(QUESTION_AWARE_KEY) !== 'false'; } catch {}

  const hostname = (location.hostname || '').toLowerCase();

  // ---------- Utilities ----------
  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', right: '12px', bottom: '12px',
      background: '#222', color: '#fff', padding: '8px 12px',
      borderRadius: '6px', zIndex: 2147483647, opacity: 0.95, fontSize: '13px'
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1300);
  }
  function log(...a){ try{console.debug('[bypass-video]',...a);}catch{} }

  // Deep traversal
  function* deepWalk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      yield node;
      if (node?.shadowRoot) stack.push(node.shadowRoot);
      if (node?.content && node.tagName === 'TEMPLATE') stack.push(node.content);
      if (node?.children) for (let i=node.children.length-1;i>=0;i--) stack.push(node.children[i]);
    }
  }
  function deepQuerySelectorAll(root, predicate) {
    const out = [];
    for (const n of deepWalk(root)) if (n instanceof Element && predicate(n)) out.push(n);
    return out;
  }

  // ---------- Question detection ----------
  const QUESTION_SELECTORS = [
    '[class*="question"]','[id*="question"]','[class*="quiz"]','[id*="quiz"]',
    '[data-testid*="question"]','[data-test*="question"]','[role="dialog"]',
    'form [type="radio"]','form [type="checkbox"]','[class*="checkpoint"]',
    'button[aria-label*="quiz" i]','[aria-label*="question" i]'
  ];
  function queryContains(selector, text) {
    text = text.toLowerCase();
    const els = Array.from(document.querySelectorAll(selector));
    return els.some(el => (el.textContent || '').toLowerCase().includes(text));
  }
  function anyQuestionOnPage() {
    if (!questionAware) return false;
    for (const sel of QUESTION_SELECTORS) { try { if (document.querySelector(sel)) return true; } catch {} }
    if (queryContains('button, [role="button"]', 'submit')) return true;
    if (queryContains('button, [role="button"]', 'check')) return true;
    if (queryContains('button, [role="button"]', 'continue')) return true;
    return false;
  }

  // ---------- Right-click restore ----------
  window.addEventListener('contextmenu', (e)=>{ e.stopPropagation(); }, true);
  setInterval(()=>{
    deepQuerySelectorAll(document, el => el.oncontextmenu != null).forEach(el=>{ try{ el.oncontextmenu = null; } catch{} });
  }, 1000);

  // ---------- Visibility spoof + keep-alive ----------
  (function spoofVisibility(){
    try {
      const dh = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      const dv = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      if (dh?.configurable) Object.defineProperty(document, 'hidden', { configurable:true, get:()=>false });
      if (dv?.configurable) Object.defineProperty(document, 'visibilityState', { configurable:true, get:()=> 'visible' });
      window.addEventListener('visibilitychange', ev=>{ ev.stopImmediatePropagation(); }, true);
    } catch(e){ log('visibility spoof failed', e); }
  })();
  setInterval(()=>{
    if (!enabled) return;
    findAllVideos().forEach(v=>{ try{ v.muted = true; v.play().catch(()=>{}); } catch{} });
  }, 800);

  // ---------- Video discovery ----------
  function looksLikeRealVideo(n){ return n?.tagName === 'VIDEO'; }
  function findAllVideos(){
    const vids = Array.from(document.querySelectorAll('video'));
    const deep = deepQuerySelectorAll(document, looksLikeRealVideo);
    return Array.from(new Set([...vids, ...deep]));
  }

  // ---------- Mutation spike → slow mode ----------
  let recentMutations = 0;
  let slowModeUntil = 0;
  setInterval(()=>{
    if (recentMutations > MUTATION_SPIKE) {
      slowModeUntil = Date.now() + SLOW_MODE_WINDOW_MS;
      log('Slow mode due to mutation spike:', recentMutations);
    }
    recentMutations = 0;
  }, 1000);
  const globalMO = new MutationObserver(muts=>{ recentMutations += muts.length; });
  globalMO.observe(document, { childList:true, attributes:true, subtree:true });
  function inSlowMode(){ return Date.now() < slowModeUntil; }

  // ---------- Rate control (auto up to 5x) ----------
  function currentRate() {
    if (anyQuestionOnPage()) return SAFE_RATE;
    if (inSlowMode()) return SLOW_RATE;
    return FAST_RATE;
  }
  function setSpeedOnVideo(v){
    const rate = currentRate();
    try { v.defaultPlaybackRate = rate; } catch{}
    try { v.playbackRate = rate; } catch{}
  }
  function attachRateLock(v){
    if (v.__rateLockAttached) return;
    v.addEventListener('ratechange', ()=> setSpeedOnVideo(v), true);
    v.__rateLockAttached = true;
  }
  setInterval(()=>{
    if (!enabled) return;
    const rate = currentRate();
    // Hint to custom controllers
    document.querySelectorAll('media-controller, [mediaplaybackrate]').forEach(el=>{
      try { el.setAttribute('mediaplaybackrate', String(rate)); } catch{}
    });
    findAllVideos().forEach(v=>{
      setSpeedOnVideo(v);
      attachRateLock(v);
      try { if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(()=> setSpeedOnVideo(v)); } catch{}
    });
  }, 220);

  // ---------- Pre-question handling ----------
  function pauseAndRewind(v, reason) {
    try { v.pause(); } catch{}
    try { v.currentTime = Math.max(0, v.currentTime - REWIND_BUFFER_SEC); } catch{}
    enabled = false; try { localStorage.setItem(ENABLE_KEY, 'false'); } catch{}
    toast(`${reason} — paused ~${REWIND_BUFFER_SEC}s before.`);
  }

  // ---------- Stepper ----------
  const steppers = new WeakMap();
  function stopStepper(v){
    const id = steppers.get(v);
    if (id) { clearInterval(id); steppers.delete(v); }
    v.removeEventListener('pause', onVideoPause, true);
  }
  function onVideoPause(e){
    const v = e.currentTarget;
    if (!v) return;
    pauseAndRewind(v, 'Checkpoint pause detected');
    stopStepper(v);
  }
  function afterStepCheck(v, prevTime){
    setTimeout(()=>{
      if (!questionAware) return;
      if (anyQuestionOnPage()) {
        try { v.currentTime = Math.max(0, (prevTime||v.currentTime) - REWIND_BUFFER_SEC); } catch{}
        try { v.pause(); } catch{}
        enabled = false; try { localStorage.setItem(ENABLE_KEY, 'false'); } catch{}
        toast(`Question ahead — paused ~${REWIND_BUFFER_SEC}s before.`);
      }
    }, POST_STEP_CHECK_MS);
  }
  function startStepper(v){
    if (steppers.has(v)) return;
    v.addEventListener('pause', onVideoPause, true);

    const tick = () => {
      if (!enabled || anyQuestionOnPage()) { stopStepper(v); return; }

      // Choose step & auto rate
      const slow = inSlowMode();
      const stepAmount = slow ? STEP_SLOW : STEP_FAST;
      setSpeedOnVideo(v);

      const before = v.currentTime;
      try { v.muted = true; v.play().catch(()=>{}); } catch{}

      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) return;
      if (dur - before <= 0.75) { stopStepper(v); return; }

      try {
        const next = Math.min(dur - 0.5, before + stepAmount);
        if (next > before) v.currentTime = next;
      } catch {}

      afterStepCheck(v, before);
    };

    const id = setInterval(tick, STEP_INTERVAL_MS);
    steppers.set(v, id);
    tick();
  }

  // ---------- Init + observers ----------
  function scanExisting(){
    const vids = findAllVideos();
    vids.forEach(v=>{ setSpeedOnVideo(v); attachRateLock(v); startStepper(v); });
    if (questionAware && anyQuestionOnPage()) vids.forEach(v=> pauseAndRewind(v, 'Question detected'));
  }
  const mo = new MutationObserver(muts=>{
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.tagName === 'VIDEO') { setSpeedOnVideo(n); attachRateLock(n); startStepper(n); }
        deepQuerySelectorAll(n, looksLikeRealVideo).forEach(v=>{ setSpeedOnVideo(v); attachRateLock(v); startStepper(v); });
      }
    }
  });
  mo.observe(document, { childList:true, subtree:true });

  if (document.readyState !== 'loading') scanExisting();
  else window.addEventListener('DOMContentLoaded', scanExisting);

  // ---------- Keyboard ----------
  window.addEventListener('keydown', (e)=>{
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
      enabled = !enabled;
      try { localStorage.setItem(ENABLE_KEY, enabled ? 'true' : 'false'); } catch{}
      toast(enabled ? 'Bypass: ON' : 'Bypass: OFF');
      if (enabled) findAllVideos().forEach(v=> startStepper(v)); else findAllVideos().forEach(v=>{ try{ v.pause(); }catch{} });
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'q') {
      questionAware = !questionAware;
      try { localStorage.setItem(QUESTION_AWARE_KEY, questionAware ? 'true' : 'false'); } catch{}
      toast(questionAware ? 'Question-aware: ON' : 'Question-aware: OFF');
    }
  });
})();
