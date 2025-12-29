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
        <div class="shr-controls">
          <button data-mode="summarize">Summarise</button>
          <button data-mode="explain">Explain</button>
          <button data-mode="quiz">Quiz</button>
          <button data-mode="solve">Solve (Screenshot)</button>
        </div>
        <label style="font-size:12px;color:#6b7280;">Input / Guidance</label>
        <textarea class="shr-input" placeholder="Paste text to summarise or explain. For Solve, add guidance if needed."></textarea>
        <div class="shr-status" aria-live="polite">Ready.</div>
        <div class="shr-output" tabindex="0"></div>
        <div class="shr-footer">
          <button data-action="copy">Copy output</button>
          <button data-action="save">Save note</button>
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
  const outputEl = root.querySelector('.shr-output');
  const controlButtons = Array.from(root.querySelectorAll('.shr-controls button'));
  const footerButtons = Array.from(root.querySelectorAll('.shr-footer button'));

  function setStatus(text, type = 'info') {
    statusEl.textContent = text;
    statusEl.style.color = type === 'error' ? '#dc2626' : '#6b7280';
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

  function setLoading(isLoading) {
    [...controlButtons, ...footerButtons].forEach((btn) => (btn.disabled = isLoading));
    if (isLoading) {
      setStatus('Working…');
    }
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

  async function runAction(mode) {
    const text = inputEl.value.trim();
    if (!text && mode !== 'solve') {
      setStatus('Add some text to work with.', 'error');
      return;
    }

    setLoading(true);
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

      if (!response?.ok) {
        throw new Error(response?.error || 'Unknown error from background service.');
      }

      setOutput(response.data);
      setStatus('Done.');
      await saveNote(mode, text, response.data);
    } catch (err) {
      setStatus(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
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
          setStatus('Copied output to clipboard.');
        } catch (err) {
          setStatus('Copy failed. Select the text manually.', 'error');
        }
      }
      if (btn.dataset.action === 'save') {
        const text = outputEl.innerText.trim();
        if (!text) return;
        await saveNote('manual', inputEl.value.trim(), text);
        setStatus('Saved note.');
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
})();
