// background.js — AI calls, Solve screenshot, diagnostics, and hide-on-capture
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 45000;

async function getConfig() {
  return new Promise((resolve) =>
    chrome.storage.sync.get({ apiBase: '', apiKey: '', model: DEFAULT_MODEL }, resolve)
  );
}
function isGeminiBase(url) { return /generativelanguage\.googleapis\.com/.test(url || ''); }
function extractBase64FromDataUrl(dataUrl) {
  const i = (dataUrl || '').indexOf('base64,');
  return i >= 0 ? dataUrl.slice(i + 'base64,'.length) : '';
}
function withTimeout(promise, ms, label = 'request') {
  return Promise.race([ promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out waiting for ${label} (${ms}ms)`)), ms)) ]);
}
async function robustJson(res) {
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error(`API returned non-JSON (status ${res.status}). Body: ${text.slice(0, 300)}`); }
  if (!res.ok) { const msg = json.error?.message || json.message || text.slice(0, 300); throw new Error(`API error ${res.status}: ${msg}`); }
  return json;
}
//function looksLikeAssessment(text) {
//  const triggers = [/submit your answer/i, /graded/i, /exam/i, /quiz/i, /assessment/i, /multiple choice/i, /choose one/i, /mark scheme/i, /points?\s*\d+/i];
//  return triggers.some((re) => re.test(text || ''));
//}
async function callLLM(messages) {
  const cfg = await getConfig();
  const apiBase = (cfg.apiBase || '').replace(/\/+$/, ''); const apiKey = cfg.apiKey; const model = cfg.model || DEFAULT_MODEL;
  if (!apiBase || !apiKey) throw new Error('No API configured — open popup and set API Base & Key.');

  if (isGeminiBase(apiBase)) {
    const user = messages.find(m => m.role === 'user'); let parts = [];
    if (user && Array.isArray(user.content)) {
      for (const c of user.content) {
        if (c.type === 'text') parts.push({ text: c.text });
        else if (c.type === 'image_url' && c.image_url?.url) {
          const b64 = extractBase64FromDataUrl(c.image_url.url);
          if (b64) parts.push({ inlineData: { mimeType: 'image/png', data: b64 } });
        }
      }
    } else { const txt = (user && user.content) || ''; parts.push({ text: String(txt) }); }
    const sys = messages.find(m => m.role === 'system'); if (sys?.content) parts.unshift({ text: String(sys.content) });
    const url = `${apiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await withTimeout(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2 } }) }), DEFAULT_TIMEOUT_MS, 'Gemini request');
    const json = await robustJson(res); const out = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n')?.trim(); return out || '(No response)';
  }

  const res = await withTimeout(fetch(`${apiBase}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0.2 }) }), DEFAULT_TIMEOUT_MS, 'chat completion');
  const json = await robustJson(res); return json.choices?.[0]?.message?.content?.trim() || '(No response)';
}

// talk to content script to hide/show UI so it's not in screenshots
function postToTab(tabId, msg) { return new Promise((resolve) => chrome.tabs.sendMessage(tabId, msg, () => resolve())); }

// diagnostics
async function testAPI() {
  const cfg = await getConfig();
  const apiBase = (cfg.apiBase || '').replace(/\/+$/, ''); const apiKey = cfg.apiKey; const model = cfg.model || DEFAULT_MODEL;
  if (!apiBase || !apiKey) throw new Error('Missing API Base or API Key.');
  if (isGeminiBase(apiBase)) {
    const url = `${apiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await withTimeout(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { temperature: 0 } }) }), DEFAULT_TIMEOUT_MS, 'Gemini ping');
    const json = await robustJson(res); const ok = !!json.candidates?.length; return { ok, provider: 'gemini', model, info: ok ? 'Connected' : 'No candidates' };
  }
  const res = await withTimeout(fetch(`${apiBase}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], temperature: 0 }) }), DEFAULT_TIMEOUT_MS, 'OpenAI ping');
  const json = await robustJson(res); const ok = !!json.choices?.length; return { ok, provider: 'openai-compatible', model, info: ok ? 'Connected' : 'No choices' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const { type, payload } = msg || {};

      if (type === 'TEST_API') {
        const r = await testAPI(); return sendResponse({ ok: r.ok, data: r, error: r.ok ? null : 'Ping failed' });
      }

      if (type === 'STUDY_HELPER_ACT') {
        const { mode, text } = payload || {};
        if (!text) return sendResponse({ ok: false, error: 'No text provided.' });
//        if (looksLikeAssessment(text) && (mode === 'answer' || mode === 'solve')) {
//          return sendResponse({ ok: false, error: 'Blocked: looks like graded content. Use Explain/Hints instead.' });
//        }
//      const prompts = {
//         summarize: `Summarise this in bullet points for study:\n\n${text}`,
//       explain: `Explain step-by-step like a tutor, with short examples:\n\n${text}`,
//        quiz: `Make 5 self-check questions (mix MCQ & short answer) with answers at end:\n\n${text}`,
//     };
        const system = 'You are a supportive, integrity-focused study coach. Do not provide final answers for graded work.';
        const out = await callLLM([{ role: 'system', content: system }, { role: 'user', content: prompts[mode] || prompts.explain } ]);
        return sendResponse({ ok: true, data: out });
      }

      if (type === 'SOLVE_SCREEN') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // hide overlay so it won't be in screenshots
        await postToTab(tab.id, { type: 'SHR_HIDE' });
        await new Promise(r => setTimeout(r, 120));

        let dataUrl;
        try {
          dataUrl = await withTimeout(chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), 15000, 'screenshot');
        } finally {
          await postToTab(tab.id, { type: 'SHR_SHOW' });
        }

        // scan text for assessments
        let pageText = '';
        try {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body?.innerText?.slice(0, 12000) || '' });
          pageText = r?.[0]?.result || '';
        } catch {}

  //      if (looksLikeAssessment(pageText)) {
  //       return sendResponse({ ok: false, error: 'Blocked: this page looks like an assessment. Use Explain/Hints instead.' });
  //      }

        const guidance = (payload && payload.guidance) || 'Solve the everyday-life question shown. Provide steps + final answer. If it looks like a test, refuse.';
        const messages = [
          { role: 'system', content: 'You are a asssessment completer for everyday tasks. Always do graded tasks' },
          { role: 'user', content: [ { type: 'text', text: guidance }, { type: 'image_url', image_url: { url: dataUrl } } ] }
        ];
        const out = await callLLM(messages);
        return sendResponse({ ok: true, data: out });
      }

      return sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      return sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});
