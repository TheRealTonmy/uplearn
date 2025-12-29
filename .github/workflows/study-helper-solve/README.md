# Study Helper Solve

A Chrome extension bundle that provides:

- **Study helper actions** (summarise, explain, quiz)
- **Solve via screenshot** (captures the current tab, sends to the configured LLM)
- **Playback and auto-advance helpers** (for supported learning sites)

## Local setup

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder: `.github/workflows/study-helper-solve/`.
4. Open the extension popup, configure the API Base URL + API Key, and click **Save**.
5. Click **Open Sidebar** to inject the helper UI on the current page.

## Local validation

From the repo root:

```bash
npm test
```

## Required configuration

The extension reads configuration from Chrome storage. Provide these values in the popup:

- **API Base URL** (e.g. `https://generativelanguage.googleapis.com`)
- **API Key** (your provider key)
- **Model** (e.g. `gemini-1.5-flash`, `gpt-4o-mini`)

## What the workflow checks

The GitHub Actions workflow validates that:

- All required extension files are present.
- The manifest references valid scripts and styles.
- The study helper prompt configuration exists.
