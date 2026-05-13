// ============================================================
// DDB Foundry Sync — Content Script
// Runs on: https://www.dndbeyond.com/characters/*
// ============================================================

const PREFIX = '[DDB-Sync]';

let _buttonInjected = false;

// linkState drives everything the panel shows.
// Populated by the CHARACTER_PAGE_LOADED response from background.js.
// { state: 'loading' | 'no_foundry' | 'multiple_foundry' | 'linked' | 'unlinked' | 'error'
//   actorName?: string, worlds?: string[], reason?: string }
let linkState = { state: 'loading' };

const DDB_JSON_URL = (id) => `https://www.dndbeyond.com/character/${id}/json`;

// ============================================================
// Data helpers
// ============================================================

function getCharacterId() {
  const match = window.location.pathname.match(/\/characters\/(\d+)/);
  return match ? match[1] : null;
}

async function fetchCharacterData(characterId) {
  const url = DDB_JSON_URL(characterId);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) { console.error(`${PREFIX} Fetch failed: ${res.status}`); return null; }
    return res.json();
  } catch (err) {
    console.error(`${PREFIX} Fetch error:`, err.message);
    return null;
  }
}

function getCharacterName(data) {
  return (data.data ?? data).name ?? 'Unknown';
}

function getNameFromDOM() {
  const titleMatch = document.title.match(/^(.+?)\s*[|–-]/);
  if (titleMatch) return titleMatch[1].trim();
  const heading = document.querySelector('.ddbc-character-name, [class*="characterName"], h1');
  return heading?.textContent?.trim() ?? 'Unknown';
}

// Read all 6 ability score totals directly from DDB's rendered character sheet.
// Returns { str, dex, con, int, wis, cha } with integer values, or null on failure.
function readAbilitiesFromDOM() {
  // Maps both full names ("strength") and abbreviations ("str") to Foundry keys.
  const NAME_TO_KEY = {
    strength: 'str', dexterity: 'dex', constitution: 'con',
    intelligence: 'int', wisdom: 'wis', charisma: 'cha',
    str: 'str', dex: 'dex', con: 'con', int: 'int', wis: 'wis', cha: 'cha',
  };
  const abilities = {};

  // DDB renders ability scores with stable ddbc- child classes.
  // The container class is unreliable, so we pair labels and scores by document order —
  // DDB always renders them STR → DEX → CON → INT → WIS → CHA.
  const labelEls = document.querySelectorAll('.ddbc-ability-summary__label');
  const scoreEls = document.querySelectorAll('.ddbc-ability-summary__secondary');

  labelEls.forEach((labelEl, i) => {
    const scoreEl = scoreEls[i];
    if (!scoreEl) return;
    const key   = NAME_TO_KEY[labelEl.textContent.trim().toLowerCase()];
    const value = parseInt(scoreEl.textContent.trim());
    if (key && !isNaN(value)) {
      abilities[key] = value;
    }
  });

  if (Object.keys(abilities).length !== 6) {
    console.warn(`${PREFIX} DOM ability read incomplete — got ${Object.keys(abilities).length}/6`);
    return null;
  }

  console.log(`${PREFIX} Abilities from DOM:`, abilities);
  return abilities;
}

// Read saving throw proficiency flags from DDB's rendered character sheet.
// Returns { str: 1|0, dex: 1|0, … } or null on failure.
function readSavingThrowsFromDOM() {
  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const saves = {};

  const profEls = document.querySelectorAll('.ddbc-saving-throws-summary__ability-proficiency');

  profEls.forEach((el, i) => {
    const key = ABILITY_KEYS[i];
    if (!key) return;
    saves[key] = el.querySelector('[aria-label="Proficient"]') ? 1 : 0;
  });

  if (Object.keys(saves).length !== 6) {
    console.warn(`${PREFIX} DOM saving throw read incomplete — got ${Object.keys(saves).length}/6`);
    return null;
  }

  console.log(`${PREFIX} Saving throws from DOM:`, saves);
  return saves;
}

// Read initiative bonus from DDB's rendered character sheet.
// Returns the total initiative modifier as an integer, or null on failure.
function readInitiativeFromDOM() {
  const el = document.querySelector('.ct-combat__summary-group--initiative button');
  const val = parseInt(el?.textContent?.trim());
  if (isNaN(val)) {
    console.warn(`${PREFIX} DOM initiative read failed`);
    return null;
  }
  console.log(`${PREFIX} Initiative from DOM: ${val}`);
  return val;
}

// Read movement speeds from DDB's speed management panel.
// The panel must be open when this is called — returns null silently if not.
function readSpeedsFromDOM() {
  const SPEED_MAP = {
    walking: 'walk', flying: 'fly', climbing: 'climb',
    burrowing: 'burrow', swimming: 'swim'
  };
  const movement = { units: 'ft' };

  const items = document.querySelectorAll('.ct-speed-manage-pane__speed');
  items.forEach(item => {
    const label  = item.querySelector('.ct-speed-manage-pane__speed-label')?.textContent?.trim().toLowerCase();
    const amount = item.querySelector('.ct-speed-manage-pane__speed-amount');
    const value  = parseInt(amount?.textContent);
    const key    = SPEED_MAP[label];
    if (key && !isNaN(value)) movement[key] = value;
  });

  if (Object.keys(movement).length > 1) {
    console.log(`${PREFIX} Movement speeds from DOM (panel):`, movement);
    return movement;
  }

  // Panel not open — fall back to the always-visible speed box (one speed only)
  const headingEl = document.querySelector('.ct-speed-box__heading');
  const valueEl   = document.querySelector('.ct-speed-box__box-value');
  const speedType = headingEl?.textContent?.trim().toLowerCase();
  const speedVal  = parseInt(valueEl?.textContent);
  const key       = SPEED_MAP[speedType];
  if (key && !isNaN(speedVal)) {
    movement[key] = speedVal;
    console.log(`${PREFIX} Movement speed from DOM (main box — ${speedType} only):`, movement);
    return movement;
  }

  console.warn(`${PREFIX} DOM speed read failed`);
  return null;
}

// Read AC directly from DDB's rendered character sheet.
function readACFromDOM() {
  const find = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const acEl = find([
    '.ct-armor-class-box__value',
    '.ddbc-armor-class-box__value',
    '[class*="armorClass"] [class*="value"]',
    '[class*="armor-class"] [class*="value"]',
  ]);

  const ac = parseInt(acEl?.textContent ?? '');
  if (isNaN(ac) || ac === 0) {
    console.warn(`${PREFIX} DOM AC read failed`);
    return null;
  }

  console.log(`${PREFIX} AC from DOM: ${ac}`);
  return ac;
}

// Read the three HP values directly from DDB's rendered character sheet.
function readHPFromDOM() {
  const find = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const currentEl = find([
    '[data-testid="current-hp"]',
    '[class*="valueButton"][class*="number"]',
    '.ct-health-summary__hp-item--current input',
    '.ct-health-summary__hp-item--current .ct-health-summary__hp-value',
  ]);
  const maxEl = find([
    '[data-testid="max-hp"]',
    '.ct-health-summary__hp-item--max .ct-health-summary__hp-value',
    '.ct-health-summary__hp-item--max',
  ]);
  const tempEl = find([
    '[data-testid="temp-hp"]',
    '.ct-health-summary__hp-item--temp input',
    '.ct-health-summary__hp-item--temp .ct-health-summary__hp-value',
  ]);

  // Use textContent first — current HP is now a <button>, not an <input>,
  // so .value returns "" which breaks the ?? chain.
  const getText = (el) => el?.textContent?.trim() || el?.value || '';
  const current = parseInt(getText(currentEl));
  const max     = parseInt(getText(maxEl));
  const temp    = parseInt(getText(tempEl)) || 0;

  if (isNaN(current) || isNaN(max) || max === 0) {
    console.warn(`${PREFIX} DOM HP read failed (current=${current} max=${max})`);
    return null;
  }

  console.log(`${PREFIX} HP from DOM: current=${current} max=${max} temp=${temp}`);
  return { current, max, temp };
}

// ============================================================
// Styles
// ============================================================

const STYLES = `
  #ddb-foundry-wrapper {
    display: inline-flex;
    align-items: center;
    position: relative;
    margin: 0 3px;
  }

  #ddb-foundry-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    height: 36px;
    border-radius: 4px;
    border: 2px solid #b5936a;
    background: #1a1a2e;
    color: #b5936a;
    font-family: 'Roboto Condensed', 'Roboto', sans-serif;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  #ddb-foundry-btn:hover { background: #2a2a4e; border-color: #d4a96a; color: #d4a96a; }
  #ddb-foundry-btn.linked { border-color: #4caf50; color: #4caf50; }
  #ddb-foundry-btn.linked:hover { background: #1a2e1a; border-color: #81c784; color: #81c784; }
  #ddb-foundry-btn.error { border-color: #f44336; color: #f44336; }
  #ddb-foundry-btn .btn-icon { font-size: 15px; line-height: 1; }
  #ddb-foundry-btn .btn-pulse {
    width: 7px; height: 7px; border-radius: 50%;
    background: #4caf50; box-shadow: 0 0 6px #4caf50;
    animation: ddb-pulse 2s infinite;
  }
  @keyframes ddb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  #ddb-foundry-panel {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 9999;
    width: 260px;
    background: #1a1a2e;
    border: 1px solid #3a3a5c;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    overflow: hidden;
    font-family: 'Roboto', sans-serif;
    font-size: 13px;
    color: #e0e0e0;
  }
  #ddb-foundry-panel .panel-header {
    background: #0f0f20;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
    border-bottom: 1px solid #2a2a4a;
  }
  #ddb-foundry-panel .panel-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  #ddb-foundry-panel .panel-row { display: flex; justify-content: space-between; align-items: center; }
  #ddb-foundry-panel .panel-label { font-size: 10px; color: #777; text-transform: uppercase; letter-spacing: 0.05em; }
  #ddb-foundry-panel .panel-value { font-size: 13px; font-weight: 600; color: #e0e0e0; }
  #ddb-foundry-panel .panel-value.linked { color: #4caf50; }
  #ddb-foundry-panel .panel-value.warn { color: #ff9800; }
  #ddb-foundry-panel .panel-notice {
    font-size: 11px; color: #aaa; line-height: 1.5;
    padding: 6px 8px; background: #0f0f20; border-radius: 4px;
  }
  #ddb-foundry-panel .panel-notice.error { color: #e57373; background: #2a1010; }
  #ddb-foundry-panel .action-btn {
    width: 100%; padding: 9px; border-radius: 4px; border: none;
    font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; cursor: pointer; transition: background 0.15s; margin-top: 4px;
  }
  #ddb-foundry-panel .action-btn.primary { background: #c41e3a; color: #fff; }
  #ddb-foundry-panel .action-btn.primary:hover { background: #a01830; }
  #ddb-foundry-panel .action-btn.primary:disabled { background: #444; color: #888; cursor: not-allowed; }
  #ddb-foundry-panel .action-btn.secondary {
    background: transparent; border: 1px solid #333; color: #666; font-size: 11px;
  }
  #ddb-foundry-panel .action-btn.secondary:hover { color: #f44336; border-color: #f44336; }
  #ddb-foundry-panel .panel-msg { font-size: 11px; padding: 7px 10px; border-radius: 4px; display: none; }
  #ddb-foundry-panel .panel-msg.success { background: #1b3a1f; color: #81c784; border: 1px solid #2e5c33; display: block; }
  #ddb-foundry-panel .panel-msg.error   { background: #3a1b1b; color: #e57373; border: 1px solid #5c2e2e; display: block; }
`;

function injectStyles() {
  if (document.getElementById('ddb-foundry-styles')) return;
  const style = document.createElement('style');
  style.id = 'ddb-foundry-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// ============================================================
// Panel builder — driven by linkState
// ============================================================

let panelOpen = false;

// Reference to the current click-outside handler — removed on re-init to avoid accumulation
let clickOutsideHandler = null;

function buildPanel(characterId) {
  const panel = document.createElement('div');
  panel.id = 'ddb-foundry-panel';

  switch (linkState.state) {

    case 'loading':
      panel.innerHTML = `
        <div class="panel-header">⚒ DDB Foundry Sync</div>
        <div class="panel-body">
          <div class="panel-notice">Checking Foundry…</div>
        </div>`;
      break;

    case 'no_foundry':
      panel.innerHTML = `
        <div class="panel-header">⚒ DDB Foundry Sync</div>
        <div class="panel-body">
          <div class="panel-notice">Open Foundry and log in, then refresh this page.</div>
        </div>`;
      break;

    case 'multiple_foundry': {
      const worldList = (linkState.worlds ?? []).map(w => `• ${w}`).join('<br>');
      panel.innerHTML = `
        <div class="panel-header">⚒ DDB Foundry Sync</div>
        <div class="panel-body">
          <div class="panel-notice error">
            Multiple Foundry tabs detected:<br>${worldList}<br><br>
            Close all but one, then refresh this page.
          </div>
        </div>`;
      break;
    }

    case 'linked': {
      panel.innerHTML = `
        <div class="panel-header">⚒ Foundry Sync Active</div>
        <div class="panel-body">
          <div class="panel-row">
            <span class="panel-label">Actor</span>
            <span class="panel-value linked">${linkState.actorName ?? 'Linked'}</span>
          </div>
          <div class="panel-row">
            <span class="panel-label">Last sync</span>
            <span class="panel-value" id="fp-last-sync">—</span>
          </div>
          <div class="panel-msg" id="fp-reimport-msg"></div>
          <button class="action-btn primary" id="fp-reimport">↺ Re-import from DDB</button>
          <button class="action-btn secondary" id="fp-unlink">Unlink actor</button>
        </div>`;

      // Populate last sync time from per-character metadata
      chrome.storage.local.get('syncMeta').then(({ syncMeta = {} }) => {
        const meta = syncMeta[String(characterId)];
        if (meta?.lastSyncTime) {
          const el = panel.querySelector('#fp-last-sync');
          if (el) el.textContent = new Date(meta.lastSyncTime).toLocaleTimeString();
        }
      });

      panel.querySelector('#fp-reimport').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const msg = panel.querySelector('#fp-reimport-msg');
        btn.disabled = true;
        btn.textContent = '↺ Importing…';
        msg.className = 'panel-msg';

        // Read HP, AC, ability scores, saving throw proficiencies, initiative, and speeds from DOM
        const hp         = readHPFromDOM();
        const ac         = readACFromDOM();
        const abilities  = readAbilitiesFromDOM();
        const saves      = readSavingThrowsFromDOM();
        const initiative = readInitiativeFromDOM();
        const movement   = readSpeedsFromDOM(); // null if speed panel not open — optional

        chrome.runtime.sendMessage({ type: 'REIMPORT_CHARACTER', hp, ac, abilities, saves, initiative, movement }, (res) => {
          btn.disabled = false;
          btn.textContent = '↺ Re-import from DDB';
          if (res?.ok) {
            msg.className = 'panel-msg success';
            msg.textContent = `✓ "${res.actorName}" updated`;
            setTimeout(() => { msg.className = 'panel-msg'; }, 3000);
          } else {
            msg.className = 'panel-msg error';
            msg.textContent = res?.reason ?? 'Import failed';
          }
        });
      });

      panel.querySelector('#fp-unlink').addEventListener('click', async () => {
        chrome.runtime.sendMessage({ type: 'UNLINK_CHARACTER', characterId }, () => {
          linkState = { state: 'unlinked' };
          closePanel();
          renderButton();
        });
      });

      break;
    }

    case 'unlinked': {
      panel.innerHTML = `
        <div class="panel-header">⚒ DDB Foundry Sync</div>
        <div class="panel-body">
          <div class="panel-row">
            <span class="panel-label">Foundry Actor</span>
            <span class="panel-value warn">Not linked</span>
          </div>
          <div class="panel-msg" id="fp-msg"></div>
          <button class="action-btn primary" id="fp-create">✦ Create Actor in Foundry</button>
        </div>`;

      panel.querySelector('#fp-create').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const msg = panel.querySelector('#fp-msg');
        btn.disabled = true;
        btn.textContent = 'Creating…';
        msg.className = 'panel-msg';

        chrome.runtime.sendMessage({ type: 'CREATE_FOUNDRY_ACTOR' }, (res) => {
          if (res?.ok) {
            linkState = { state: 'linked', actorId: res.actorId, actorName: res.actorName };
            msg.className = 'panel-msg success';
            msg.textContent = `✓ "${res.actorName}" created`;
            setTimeout(() => { closePanel(); renderButton(); }, 1200);
          } else {
            msg.className = 'panel-msg error';
            msg.textContent = res?.reason ?? 'Failed — check service worker console';
            btn.disabled = false;
            btn.textContent = '✦ Create Actor in Foundry';
          }
        });
      });

      break;
    }

    default:
      panel.innerHTML = `
        <div class="panel-header">⚒ DDB Foundry Sync</div>
        <div class="panel-body">
          <div class="panel-notice error">${linkState.reason ?? 'Unknown error'}</div>
        </div>`;
  }

  return panel;
}

function closePanel() {
  document.getElementById('ddb-foundry-panel')?.remove();
  panelOpen = false;
}

function renderButton() {
  injectStyles();

  const isLinked = linkState.state === 'linked';
  const isError  = linkState.state === 'multiple_foundry' || linkState.state === 'error';

  if (_buttonInjected && document.getElementById('ddb-foundry-wrapper')) {
    const oldBtn = document.getElementById('ddb-foundry-btn');
    if (oldBtn) {
      oldBtn.className = isLinked ? 'linked' : isError ? 'error' : '';
      oldBtn.innerHTML = isLinked
        ? `<span class="btn-icon">⚒</span> FOUNDRY <div class="btn-pulse"></div>`
        : `<span class="btn-icon">⚒</span> FOUNDRY SYNC`;
    }
    return true;
  }

  document.getElementById('ddb-foundry-wrapper')?.remove();

  const wrapper = document.createElement('div');
  wrapper.id = 'ddb-foundry-wrapper';

  const btn = document.createElement('button');
  btn.id = 'ddb-foundry-btn';
  btn.className = isLinked ? 'linked' : isError ? 'error' : '';
  btn.innerHTML = isLinked
    ? `<span class="btn-icon">⚒</span> FOUNDRY <div class="btn-pulse"></div>`
    : `<span class="btn-icon">⚒</span> FOUNDRY SYNC`;

  const characterId = getCharacterId();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (panelOpen) {
      closePanel();
    } else {
      panelOpen = true;
      wrapper.appendChild(buildPanel(characterId));
    }
  });

  wrapper.addEventListener('click',     (e) => e.stopPropagation());
  wrapper.addEventListener('mousedown', (e) => e.stopPropagation());

  clickOutsideHandler = (e) => {
    if (!wrapper.contains(e.target)) closePanel();
  };
  document.addEventListener('click', clickOutsideHandler);

  wrapper.appendChild(btn);

  const inserted = findInsertionPoint(wrapper);
  if (!inserted) return false;

  _buttonInjected = true;
  console.log(`${PREFIX} Foundry button injected`);
  return true;
}

function findInsertionPoint(wrapper) {
  const shareGroup = document.querySelector('.ct-character-header-desktop__group--share');
  if (shareGroup) {
    shareGroup.parentNode.insertBefore(wrapper, shareGroup);
    console.log(`${PREFIX} Inserted before Share group`);
    return true;
  }
  const shortRestGroup = document.querySelector('.ct-character-header-desktop__group--short-rest');
  if (shortRestGroup) {
    shortRestGroup.parentNode.insertBefore(wrapper, shortRestGroup);
    console.log(`${PREFIX} Inserted before Short Rest group`);
    return true;
  }
  const header = document.querySelector('.ct-character-header-desktop');
  if (header) {
    header.appendChild(wrapper);
    console.log(`${PREFIX} Appended to character header desktop`);
    return true;
  }
  return false;
}

function injectWhenReady() {
  let attempts = 0;
  const MAX_ATTEMPTS = 40;

  function tryInject() {
    attempts++;
    renderButton().then ? renderButton().then(ok => {
      if (ok) return;
      if (attempts >= MAX_ATTEMPTS) {
        console.warn(`${PREFIX} Could not find header insertion point after ${MAX_ATTEMPTS} attempts`);
        return;
      }
      setTimeout(tryInject, 500);
    }) : (() => {
      const ok = renderButton();
      if (!ok && attempts < MAX_ATTEMPTS) setTimeout(tryInject, 500);
    })();
  }

  tryInject();
}

// ============================================================
// HP Sync
// ============================================================

async function syncAC(characterId) {
  if (linkState.state !== 'linked') return;

  const ac = readACFromDOM();
  if (ac === null) {
    console.warn(`${PREFIX} Could not read AC from DOM — sync aborted`);
    return;
  }

  chrome.runtime.sendMessage({ type: 'PUSH_AC_TO_FOUNDRY', characterId, ac }, (res) => {
    if (res?.ok) {
      console.log(`${PREFIX} ✅ AC synced: ${ac}`);
    } else {
      console.warn(`${PREFIX} ⚠️ AC sync failed:`, res);
    }
  });
}

async function syncHP(characterId) {
  if (linkState.state !== 'linked') {
    console.warn(`${PREFIX} HP sync skipped — not linked (state: ${linkState.state})`);
    return;
  }

  const hp = readHPFromDOM();
  if (!hp) {
    console.warn(`${PREFIX} Could not read HP from DOM — sync aborted`);
    return;
  }

  chrome.runtime.sendMessage({ type: 'PUSH_HP_TO_FOUNDRY', characterId, hp }, (res) => {
    if (res?.ok) {
      console.log(`${PREFIX} ✅ Foundry synced: ${hp.current}/${hp.max} temp=${hp.temp}`);
      // Refresh last-sync time in panel if open
      if (panelOpen) {
        const el = document.getElementById('fp-last-sync');
        if (el) el.textContent = new Date().toLocaleTimeString();
      }
    } else {
      console.warn(`${PREFIX} ⚠️ Sync failed:`, res);
    }
  });
}

// ============================================================
// Message listener
// ============================================================

// Tracks the character currently displayed — updated by init() on each navigation
let currentCharacterId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HP_SAVE_DETECTED') {
    console.log(`${PREFIX} 📡 HP save — syncing`);
    if (currentCharacterId) syncHP(currentCharacterId);
    sendResponse({ received: true });
  }
  if (message.type === 'AC_CHANGE_DETECTED') {
    console.log(`${PREFIX} 📡 AC change — syncing`);
    if (currentCharacterId) syncAC(currentCharacterId);
    sendResponse({ received: true });
  }
});

// ============================================================
// Main — init + SPA navigation support
// ============================================================

async function init(characterId) {
  currentCharacterId = characterId;

  // Reset UI state for this character
  linkState = { state: 'loading' };
  _buttonInjected = false;
  panelOpen = false;
  document.getElementById('ddb-foundry-wrapper')?.remove();

  // Remove stale click-outside handler from previous character
  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler);
    clickOutsideHandler = null;
  }

  console.log(`${PREFIX} Character ID: ${characterId}`);

  // Inject button immediately — shows 'loading' state while Foundry is queried
  injectWhenReady();

  // Notify background and await link state
  const domName = getNameFromDOM();
  chrome.runtime.sendMessage(
    { type: 'CHARACTER_PAGE_LOADED', characterId, characterName: domName },
    (response) => {
      if (currentCharacterId !== characterId) return; // navigated away — discard
      linkState = response ?? { state: 'error', reason: 'No response from background' };
      console.log(`${PREFIX} Link state: ${linkState.state}`, linkState.actorName ?? '');
      renderButton();
      // If panel is already open (user clicked fast), rebuild it
      if (panelOpen) {
        closePanel();
        panelOpen = true;
        document.getElementById('ddb-foundry-wrapper')?.appendChild(buildPanel(characterId));
      }
    }
  );

  // Fetch full character data for re-import / panel data
  const data = await fetchCharacterData(characterId);
  if (currentCharacterId !== characterId) return; // navigated away — discard
  if (data) {
    const apiName = getCharacterName(data);
    await chrome.storage.local.set({ ddbCharacterData: data, characterName: apiName });
    console.group(`${PREFIX} ===== CHARACTER DATA =====`);
    const char = data.data ?? data;
    console.group('📋 Identity');
    console.log('Name:', char.name, '| Race:', char.race?.fullName,
      '| Classes:', char.classes?.map(c=>`${c.definition?.name} ${c.level}`).join(', '));
    console.groupEnd();
    console.group('📦 Full payload'); console.log(char); console.groupEnd();
    console.groupEnd();
  }
}

function watchForUrlChanges() {
  const origPush    = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  history.pushState = function (...args) {
    origPush(...args);
    handleUrlChange();
  };
  history.replaceState = function (...args) {
    origReplace(...args);
    handleUrlChange();
  };

  window.addEventListener('popstate', handleUrlChange);
}

function handleUrlChange() {
  // Small delay — let Next.js finish updating the URL before we read it
  setTimeout(() => {
    const newId = getCharacterId();
    if (!newId || newId === currentCharacterId) return;

    console.log(`${PREFIX} SPA navigation → character ${newId} (was ${currentCharacterId})`);

    // Immediately clear stale character data so a pending import can't use it
    chrome.storage.local.remove(['ddbCharacterData']);

    init(newId);
  }, 150);
}

// Entry point
const _initialCharacterId = getCharacterId();
if (_initialCharacterId) {
  watchForUrlChanges();
  init(_initialCharacterId);
} else {
  console.warn(`${PREFIX} No character ID in URL`);
}
