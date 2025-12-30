const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get({ apiBase: '', apiKey: '', model: 'gpt-4o-mini' }, (cfg) => {
    $('apiBase').value = cfg.apiBase; $('apiKey').value = cfg.apiKey; $('model').value = cfg.model;
  });
});

$('save').addEventListener('click', () => {
  chrome.storage.sync.set({
    apiBase: $('apiBase').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim()
  }, () => { $('testResult').textContent = 'Saved ✔'; $('testResult').className = 'ok'; });
});

$('clear').addEventListener('click', () => {
  chrome.storage.sync.set({ apiBase: '', apiKey: '', model: 'gpt-4o-mini' }, () => {
    $('apiBase').value = ''; $('apiKey').value = ''; $('model').value = 'gpt-4o-mini';
    $('testResult').textContent = 'Cleared. Fill details and Save.'; $('testResult').className = 'muted';
  });
});

$('inject').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js', 'storage.js', 'sidebar.js']
  });
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['sidebar.css'] });
});

$('test').addEventListener('click', async () => {
  $('testResult').textContent = 'Testing…'; $('testResult').className = 'muted';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST_API' });
    if (r?.ok) {
      $('testResult').textContent = `Connected to ${r.data.provider} (${r.data.model}) — ${r.data.info}`;
      $('testResult').className = 'ok';
    } else {
      $('testResult').textContent = `Failed: ${r?.error || 'Unknown error'}`;
      $('testResult').className = 'bad';
    }
  } catch (e) {
    $('testResult').textContent = `Error: ${e?.message || String(e)}`;
    $('testResult').className = 'bad';
  }
});
