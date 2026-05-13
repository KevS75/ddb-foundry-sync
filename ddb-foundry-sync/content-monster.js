// ============================================================
// DDB Foundry Sync — Monster Page Content Script
// Runs on dndbeyond.com/monsters/* pages
// Injects an "Import to Foundry" button and collects monster data
// ============================================================

const PREFIX = '[DDB-Sync Monster]';

// ----------------------------------------------------------
// Data collection
// ----------------------------------------------------------

function getMonsterId() {
  return window.location.pathname.match(/\/monsters\/(\d+)/)?.[1] ?? null;
}

// Scrape AC and HP from the rendered stat block.
// The monster-service API returns 0s for locked sourcebook monsters,
// but the page always renders the full stat block.
function scrapeStatBlock() {
  const sb = document.querySelector('.mon-stat-block');
  if (!sb) return null;

  const name = sb.querySelector('.mon-stat-block__name')?.textContent?.trim();

  function getAttrValue(label) {
    const attrs = sb.querySelectorAll('.mon-stat-block__attribute');
    for (const attr of attrs) {
      const attrLabel = attr.querySelector('.mon-stat-block__attribute-label')?.textContent?.trim();
      if (attrLabel !== label) continue;
      // Value may be in either of two class names depending on DDB version
      return attr.querySelector(
        '.mon-stat-block__attribute-data-value, .mon-stat-block__attribute-value'
      )?.textContent?.trim() ?? '';
    }
    return '';
  }

  // AC: "12 (15 with mage armor)" — we want the first number
  const acText = getAttrValue('Armor Class');
  const ac = parseInt(acText.match(/\d+/)?.[0] ?? '10');

  // HP: "104 (16d8 + 32)" — we want the first number (average)
  const hpText = getAttrValue('Hit Points');
  const hp = parseInt(hpText.match(/\d+/)?.[0] ?? '1');

  return { name, ac, hp };
}

// Fetch avatar URL from the monster API.
// Stats may be locked for paid sourcebook monsters, but the
// avatar URL is always returned.
async function fetchAvatarUrl(monsterId) {
  try {
    const res = await fetch(
      `https://monster-service.dndbeyond.com/v1/monster/${monsterId}`,
      { credentials: 'include', headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return '';
    const json = await res.json();
    return json.data?.avatarUrl ?? '';
  } catch {
    return '';
  }
}

// ----------------------------------------------------------
// Button injection
// ----------------------------------------------------------

function injectButton(alreadyImported) {
  if (document.getElementById('ddb-sync-import-btn')) return;

  const target = document.querySelector('.mon-stat-block__name, .mon-stat-block__header, h1');
  if (!target) return;

  const btn = document.createElement('button');
  btn.id = 'ddb-sync-import-btn';
  btn.style.cssText = `
    display:inline-flex; align-items:center; gap:6px;
    margin:10px 0; padding:7px 16px;
    background:${alreadyImported ? '#37474f' : '#6d2b8f'};
    color:#fff; border:none; border-radius:4px;
    font-size:13px; font-weight:600; cursor:pointer; font-family:inherit;
    transition: background 0.15s;
  `;
  btn.textContent = alreadyImported ? '↺ Re-import to Foundry' : '⚔ Import to Foundry';
  btn.title = alreadyImported
    ? 'This monster has been imported before — clicking will overwrite the existing Foundry actor'
    : 'Create a Foundry VTT actor from this monster';

  btn.addEventListener('click', handleImport);

  // Insert after the name/header
  const insertTarget = target.closest('.mon-stat-block') ?? target;
  insertTarget.insertAdjacentElement('beforebegin', btn);
}

// ----------------------------------------------------------
// Import handler
// ----------------------------------------------------------

async function handleImport() {
  const btn = document.getElementById('ddb-sync-import-btn');
  const originalText = btn.textContent;
  btn.textContent = '⏳ Importing…';
  btn.disabled = true;
  btn.style.background = '#455a64';

  try {
    const monsterId = getMonsterId();
    if (!monsterId) throw new Error('Could not find monster ID in URL');

    const scraped = scrapeStatBlock();
    if (!scraped?.name) throw new Error('Could not read stat block — is the page fully loaded?');

    const avatarUrl = await fetchAvatarUrl(monsterId);

    console.log(`${PREFIX} Importing: ${scraped.name} | AC ${scraped.ac} | HP ${scraped.hp}`);

    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_MONSTER',
      monster: {
        monsterId,
        name:      scraped.name,
        avatarUrl,
        ac:        scraped.ac,
        hp:        scraped.hp,
        sourceUrl: window.location.href
      }
    });

    if (response?.ok) {
      btn.textContent    = '✓ Imported!';
      btn.style.background = '#2e7d32';
      btn.title = `Imported as "${response.actorName}"`;
      // Mark as imported in storage so button updates on next visit
      const existing = await chrome.storage.local.get(['importedMonsters']);
      const map = existing.importedMonsters ?? {};
      map[monsterId] = { name: scraped.name, uuid: response.uuid };
      await chrome.storage.local.set({ importedMonsters: map });
    } else {
      throw new Error(response?.reason ?? 'Import failed — check extension console');
    }
  } catch (err) {
    console.error(`${PREFIX}`, err);
    btn.textContent    = '✗ Failed';
    btn.style.background = '#b71c1c';
    btn.title = err.message;
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '#6d2b8f';
    }, 3000);
  }
}

// ----------------------------------------------------------
// Init — wait for stat block (DDB renders it async)
// ----------------------------------------------------------

async function init(retries = 30) {
  const sb = document.querySelector('.mon-stat-block');
  if (!sb) {
    if (retries > 0) setTimeout(() => init(retries - 1), 500);
    return;
  }

  const monsterId = getMonsterId();
  if (!monsterId) return;

  // Check if already imported
  const stored = await chrome.storage.local.get(['importedMonsters']);
  const alreadyImported = !!(stored.importedMonsters?.[monsterId]);

  injectButton(alreadyImported);
  console.log(`${PREFIX} Button injected for monster ${monsterId}`);
}

init();
