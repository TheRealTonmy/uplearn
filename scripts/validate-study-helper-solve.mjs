import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const baseDir = path.join(root, '.github', 'workflows', 'study-helper-solve');

async function ensureFile(relPath) {
  const filePath = path.join(baseDir, relPath);
  try {
    await access(filePath, fsConstants.F_OK);
  } catch (err) {
    throw new Error(`Missing required file: ${relPath}`);
  }
}

async function main() {
  const manifestPath = path.join(baseDir, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected manifest_version 3, got ${manifest.manifest_version}`);
  }

  if (!manifest.name || !manifest.version) {
    throw new Error('Manifest must include name and version.');
  }

  if (!manifest.background?.service_worker) {
    throw new Error('Manifest must define background.service_worker.');
  }

  const requiredFiles = new Set([
    'background.js',
    'bypass-video.js',
    'content.js',
    'manifest.json',
    'popup.html',
    'popup.js',
    'sidebar.css',
    'sidebar.js',
    'storage.js'
  ]);

  for (const file of requiredFiles) {
    await ensureFile(file);
  }

  const contentScripts = manifest.content_scripts?.[0];
  if (!contentScripts) {
    throw new Error('Manifest must include content_scripts.');
  }

  for (const jsFile of contentScripts.js || []) {
    await ensureFile(jsFile);
  }

  for (const cssFile of contentScripts.css || []) {
    await ensureFile(cssFile);
  }

  const popupFile = manifest.action?.default_popup;
  if (popupFile) {
    await ensureFile(popupFile);
  }

  await ensureFile(manifest.background.service_worker);

  const backgroundSource = await readFile(path.join(baseDir, 'background.js'), 'utf8');
  if (!/const\s+prompts\s*=/.test(backgroundSource)) {
    throw new Error('background.js must define prompts for study helper actions.');
  }

  console.log('Study Helper Solve validation passed.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
