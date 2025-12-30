(() => {
  if (window.__studyHelperSidebarLoaded) return;
  window.__studyHelperSidebarLoaded = true;

  const DEFAULT_GUIDANCE =
    'Solve the everyday-life question shown. Provide steps and a final answer. If it looks like a test or graded assignment, refuse.';

  const root = document.createElement('div');
  root.id = 'study-helper-root';
  root.innerHTML = `
    <div class="shr-container" role="dialog" aria-label="Study Helper">
      <div class="shr-header">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="shr-drag-handle" title="Drag"></div>
          <div class="shr-title">Study Helper</div>
        </div>
        <button class="shr-close" aria-label="Close">×</button>
      </div>
      <div class="shr-body">
        <div class="shr-section-title">Actions</div>
        <div class="shr-controls">
          <button data-mode="summarize">Summarise</button>
          <button data-mode="explain">Explain</button>
          <button data-mode="quiz">Quiz</button>
          <button class="shr-primary" data-mode="solve">Solve (Screenshot)</button>
        </div>
        <div class="shr-section-title">Input / Guidance</div>
        <textarea class="shr-input" placeholder="Paste text to summarise or explain. For Solve, add guidance if needed."></textarea>
        <div class="shr-status" aria-live="polite">
          <span class="shr-status-text">Ready.</span>
          <span class="shr-status-badge">Idle</span>
        </div>
        <div class="shr-section-title">Answer</div>
        <div class="shr-output" tabindex="0"></div>
        <div class="shr-footer">
          <button data-action="copy">Copy output</button>
          <button data-action="save">Save note</button>
          <button data-action="history">History</button>
        </div>
        <div class="shr-history" aria-live="polite">
          <div class="shr-section-title">Recent history</div>
          <div class="shr-history-list"></div>
        </div>
        <div class="shr-resize" title="Resize"></div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(root);

  const container = root.querySelector('.shr-container');
  const closeBtn = root.querySelector('.shr-close');
  const inputEl = root.querySelector('.shr-input');
  const statusEl = root.querySelector('.shr-status');
  const statusTextEl = root.querySelector('.shr-status-text');
  const statusBadgeEl = root.querySelector('.shr-status-badge');
  const outputEl = root.querySelector('.shr-output');
  const historyEl = root.querySelector('.shr-history');
  const historyListEl = root.querySelector('.shr-history-list');
  const controlButtons = Array.from(root.querySelectorAll('.shr-controls button'));
  const footerButtons = Array.from(root.querySelectorAll('.shr-footer button'));

  const cache = new Map();
  let activeRequestId = 0;
  let historyLoaded = false;
  const devMode = (() => {
    try {
      return localStorage.getItem('study_helper_dev') === 'true';
    } catch {
      return false;
    }
  })();

  function setStatus(text, type = 'info') {
    statusTextEl.textContent = text;
    statusEl.style.color = type === 'error' ? '#dc2626' : '#64748b';
    const badge = {
      info: 'Idle',
      loading: 'Solving',
      done: 'Done',
      error: 'Error',
      queued: 'Queued'
    }[type] || 'Idle';
    statusBadgeEl.textContent = badge;
    statusBadgeEl.style.background = type === 'error' ? '#fee2e2' : '#e2e8f0';
    statusBadgeEl.style.color = type === 'error' ? '#991b1b' : '#0f172a';
  }

  function setOutput(text) {
    outputEl.textContent = '';
    if (!text) {
      outputEl.textContent = 'No output yet.';
      return;
    }
    const pre = document.createElement('pre');
    pre.textContent = text;
    outputEl.appendChild(pre);
  }

  function setSkeleton() {
    outputEl.innerHTML = `
      <div class="shr-skeleton" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
  }

  function setLoading(isLoading) {
    [...controlButtons, ...footerButtons].forEach((btn) => (btn.disabled = isLoading));
    if (isLoading) {
      setStatus('Working…', 'loading');
    }
  }

  function pushCache(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (cache.size > 25) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
  }

  function getCacheKey(mode, text) {
    return `${mode}:${text.slice(0, 4000)}`;
  }

  async function saveNote(mode, input, output) {
    if (typeof getNotes !== 'function' || typeof setNotes !== 'function') return;
    const notes = await getNotes();
    notes.unshift({
      mode,
      input,
      output,
      at: new Date().toISOString()
    });
    await setNotes(notes.slice(0, 20));
  }

  async function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    if (typeof getNotes !== 'function') {
      historyListEl.textContent = 'History unavailable.';
      return;
    }
    const notes = await getNotes();
    if (!notes.length) {
      historyListEl.textContent = 'No saved notes yet.';
      return;
    }
    historyListEl.textContent = '';
    notes.slice(0, 8).forEach((note) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shr-history-item';
      item.innerHTML = `
        <strong>${note.mode || 'note'}</strong>
        <span>${(note.input || note.output || '').slice(0, 80)}</span>
      `;
      item.addEventListener('click', () => {
        inputEl.value = note.input || '';
        setOutput(note.output || '');
        setStatus('Loaded from history.', 'done');
      });
      historyListEl.appendChild(item);
    });
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'absolute',
      right: '12px',
      top: '12px',
      background: type === 'error' ? '#fee2e2' : '#ecfeff',
      color: type === 'error' ? '#991b1b' : '#0f172a',
      border: '1px solid rgba(148, 163, 184, 0.4)',
      padding: '6px 10px',
      borderRadius: '10px',
      fontSize: '12px',
      zIndex: 2
    });
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 1800);
  }

  async function runAction(mode) {
    const text = inputEl.value.trim();
    if (!text && mode !== 'solve') {
      setStatus('Add some text to work with.', 'error');
      return;
    }

    const requestId = ++activeRequestId;
    const cacheKey = getCacheKey(mode, mode === 'solve' ? text || DEFAULT_GUIDANCE : text);
    if (cache.has(cacheKey)) {
      setOutput(cache.get(cacheKey));
      setStatus('Loaded from cache.', 'done');
      return;
    }

    setLoading(true);
    setSkeleton();
    if (devMode) console.time(`study-helper:${mode}`);
    try {
      let response;
      if (mode === 'solve') {
        response = await chrome.runtime.sendMessage({
          type: 'SOLVE_SCREEN',
          payload: { guidance: text || DEFAULT_GUIDANCE }
        });
      } else {
        response = await chrome.runtime.sendMessage({
          type: 'STUDY_HELPER_ACT',
          payload: { mode, text }
        });
      }

      if (requestId !== activeRequestId) {
        return;
      }
      if (!response?.ok) {
        throw new Error(response?.error || 'Unknown error from background service.');
      }

      setOutput(response.data);
      setStatus('Done.', 'done');
      await saveNote(mode, text, response.data);
      pushCache(cacheKey, response.data);
      showToast('Saved to history.', 'info');
    } catch (err) {
      setStatus(err?.message || String(err), 'error');
      showToast('Something went wrong.', 'error');
    } finally {
      setLoading(false);
      if (devMode) console.timeEnd(`study-helper:${mode}`);
    }
  }

  controlButtons.forEach((btn) => {
    btn.addEventListener('click', () => runAction(btn.dataset.mode));
  });

  footerButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.action === 'copy') {
        const text = outputEl.innerText.trim();
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          setStatus('Copied output to clipboard.', 'done');
          showToast('Copied.', 'info');
        } catch (err) {
          setStatus('Copy failed. Select the text manually.', 'error');
          showToast('Copy failed.', 'error');
        }
      }
      if (btn.dataset.action === 'save') {
        const text = outputEl.innerText.trim();
        if (!text) return;
        await saveNote('manual', inputEl.value.trim(), text);
        setStatus('Saved note.', 'done');
        showToast('Saved.', 'info');
      }
      if (btn.dataset.action === 'history') {
        historyEl.classList.toggle('is-open');
        if (historyEl.classList.contains('is-open')) {
          await loadHistory();
        }
      }
    });
  });

  closeBtn.addEventListener('click', () => {
    root.remove();
    window.__studyHelperSidebarLoaded = false;
  });

  function makeDraggable(handle, target) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('mousedown', (event) => {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = target.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      target.style.left = `${rect.left}px`;
      target.style.top = `${rect.top}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function onMove(event) {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      target.style.left = `${startLeft + dx}px`;
      target.style.top = `${startTop + dy}px`;
    }

    function onUp() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  function makeResizable(handle, target) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    handle.addEventListener('mousedown', (event) => {
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = target.getBoundingClientRect();
      startWidth = rect.width;
      startHeight = rect.height;
      document.addEventListener('mousemove', onResize);
      document.addEventListener('mouseup', stopResize);
      event.preventDefault();
    });

    function onResize(event) {
      if (!resizing) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      target.style.width = `${Math.max(260, startWidth + dx)}px`;
      target.style.height = `${Math.max(200, startHeight + dy)}px`;
    }

    function stopResize() {
      resizing = false;
      document.removeEventListener('mousemove', onResize);
      document.removeEventListener('mouseup', stopResize);
    }
  }

  makeDraggable(root.querySelector('.shr-drag-handle'), container);
  makeResizable(root.querySelector('.shr-resize'), container);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SHR_HIDE') root.style.display = 'none';
    if (msg?.type === 'SHR_SHOW') root.style.display = '';
  });

  setOutput('No output yet.');
  setStatus('Ready.', 'info');
})();
