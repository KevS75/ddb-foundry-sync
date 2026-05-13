// ============================================================
// DDB Foundry Sync — Popup Script
// ============================================================

const el = (id) => document.getElementById(id);

// ----------------------------------------------------------
// Main render
// ----------------------------------------------------------
async function render() {
  const { characterId, characterName, actorCache = {}, syncMeta = {} } =
    await chrome.storage.local.get(['characterId', 'characterName', 'actorCache', 'syncMeta']);

  // Character info
  if (characterName) {
    el('characterName').textContent = characterName;
    el('characterId').textContent   = `DDB ID: ${characterId}`;
  } else {
    el('characterName').textContent = 'No character page open';
    el('characterId').textContent   = '';
  }

  // Link status — read from per-character actor cache
  const dot           = el('linkDot');
  const linkText      = el('linkText');
  const actorIdEl     = el('actorId');
  const createSection = el('createSection');
  const linkedSection = el('linkedSection');
  const btnCreate     = el('btnCreate');

  const cached = characterId ? actorCache[String(characterId)] : null;

  if (cached) {
    dot.className         = 'status-dot linked';
    linkText.textContent  = cached.actorName ?? 'Linked';
    actorIdEl.textContent = `UUID: ${cached.actorId}`;
    createSection.style.display = 'none';
    linkedSection.style.display = 'block';
  } else if (characterId) {
    dot.className         = 'status-dot unlinked';
    linkText.textContent  = 'No Foundry actor linked';
    actorIdEl.textContent = '';
    createSection.style.display = 'block';
    linkedSection.style.display = 'none';
    btnCreate.disabled = false;
  } else {
    dot.className        = 'status-dot';
    linkText.textContent = 'Open a DDB character sheet first';
    createSection.style.display = 'none';
    linkedSection.style.display = 'none';
  }

  // Last sync — per-character
  const meta = characterId ? syncMeta[String(characterId)] : null;
  if (meta?.lastSyncTime) {
    el('lastSync').textContent = new Date(meta.lastSyncTime).toLocaleTimeString();
  } else {
    el('lastSync').textContent = '—';
  }
}

// ----------------------------------------------------------
// Create actor
// ----------------------------------------------------------
el('btnCreate').addEventListener('click', () => {
  const btn    = el('btnCreate');
  const result = el('createResult');

  btn.classList.add('loading');
  btn.disabled = true;
  result.style.display = 'none';

  chrome.runtime.sendMessage({ type: 'CREATE_FOUNDRY_ACTOR' }, (response) => {
    btn.classList.remove('loading');
    if (chrome.runtime.lastError) {
      showResult('error', 'Extension error — check service worker console');
      btn.disabled = false;
      return;
    }
    if (response?.ok) {
      showResult('success', `✓ "${response.actorName}" created in Foundry`);
      setTimeout(render, 800);
    } else {
      showResult('error', response?.reason ?? 'Unknown error');
      btn.disabled = false;
    }
  });
});

function showResult(type, text) {
  const r = el('createResult');
  r.className     = `result ${type}`;
  r.textContent   = text;
  r.style.display = 'block';
}

// ----------------------------------------------------------
// Re-import character
// ----------------------------------------------------------
el('btnReimport').addEventListener('click', () => {
  const btn    = el('btnReimport');
  const result = el('reimportResult');

  btn.classList.add('loading');
  btn.disabled = true;
  result.style.display = 'none';

  chrome.runtime.sendMessage({ type: 'REIMPORT_CHARACTER' }, (response) => {
    btn.classList.remove('loading');
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      showReimportResult('error', 'Extension error — check console');
      return;
    }
    if (response?.ok) {
      showReimportResult('success', `✓ "${response.actorName}" updated`);
    } else {
      showReimportResult('error', response?.reason ?? 'Unknown error');
    }
  });
});

function showReimportResult(type, text) {
  const r = el('reimportResult');
  r.className     = `result ${type}`;
  r.textContent   = text;
  r.style.display = 'block';
}

// ----------------------------------------------------------
// Unlink
// ----------------------------------------------------------
el('btnUnlink').addEventListener('click', async () => {
  const { characterId } = await chrome.storage.local.get('characterId');
  if (!characterId) return;
  chrome.runtime.sendMessage({ type: 'UNLINK_CHARACTER', characterId }, () => render());
});

render();
