// ============================================================
// DDB Foundry Sync — Background Service Worker
// ============================================================
//
// Architecture: injects code directly into the open Foundry tab
// and communicates via window.postMessage. Foundry is auto-detected
// by pinging all open tabs — no URL configuration needed.
//
// Storage keys:
//   actorCache  : { [characterId]: { actorId, actorName } }
//   syncMeta    : { [characterId]: { lastSyncTime } }
//   characterId : currently-viewed DDB character (set on page load)
//   characterName: name of currently-viewed character
//   ddbCharacterData: legacy — still written by content.js but no longer
//                     read by the import flow (CREATE_FOUNDRY_ACTOR /
//                     REIMPORT_CHARACTER fetch fresh at click time as of v0.4.0)
//   importedMonsters: set of imported monster IDs
// ============================================================

const PREFIX      = '[DDB-Sync BG]';
const HP_ENDPOINT = 'character-service.dndbeyond.com/character/v5/life/hp/damage-taken';
const MODULE_ID   = 'ddb-sync';
const MSG_TIMEOUT  = 10_000; // ms to wait for module response
const PING_TIMEOUT = 1_500;  // ms for auto-detection pings (shorter = faster scan)

// ----------------------------------------------------------
// Foundry tab auto-detection
//
// Pings all HTTP/HTTPS tabs in parallel. Returns an array of
// { tab, world } for every tab where the ddb-sync module responds.
// ----------------------------------------------------------
async function findFoundryTabs() {
  const allTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });

  const results = await Promise.all(allTabs.map(async (tab) => {
    try {
      const requestId = `ping_${tab.id}_${Date.now()}`;
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world:  'MAIN',
        func:   foundryBridge,
        args:   [{ source: 'ddb-sync-extension', action: 'ping', requestId }, PING_TIMEOUT]
      });
      if (result?.result?.ok) {
        return { tab, world: result.result.world };
      }
    } catch (_) {
      // Not injectable (chrome:// etc.) or module not present — skip silently
    }
    return null;
  }));

  return results.filter(Boolean);
}

// Send an action to a specific Foundry tab (bypasses auto-detection)
async function sendToFoundryTab(tab, action, payload = {}) {
  const requestId = `${action}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world:  'MAIN',
    func:   foundryBridge,
    args:   [{ source: 'ddb-sync-extension', action, requestId, ...payload }, MSG_TIMEOUT]
  });
  if (result.error) throw new Error(result.error.message ?? result.error);
  const response = result.result;
  if (!response) throw new Error('No response from Foundry module — is ddb-sync installed and active?');
  if (!response.ok) throw new Error(response.error ?? response.reason ?? 'Module returned not-ok');
  return response;
}

// Auto-detect the single Foundry tab and send an action.
// Throws 'NO_FOUNDRY_TAB' or 'MULTIPLE_FOUNDRY_TABS:world1,world2' if tab count != 1.
async function sendToFoundry(action, payload = {}) {
  const foundryTabs = await findFoundryTabs();
  if (foundryTabs.length === 0) throw new Error('NO_FOUNDRY_TAB');
  if (foundryTabs.length > 1)  throw new Error(`MULTIPLE_FOUNDRY_TABS:${foundryTabs.map(f => f.world).join(',')}`);
  return sendToFoundryTab(foundryTabs[0].tab, action, payload);
}

// Look for an actor by characterId or monsterId in a specific tab.
// Returns { uuid, name } if found, null if not found or error.
async function findActorInTab(tab, { characterId, monsterId }) {
  const requestId = `findActor_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  'MAIN',
      func:   foundryBridge,
      args:   [{
        source:      'ddb-sync-extension',
        action:      'findActor',
        requestId,
        characterId: characterId ? String(characterId) : undefined,
        monsterId:   monsterId   ? String(monsterId)   : undefined
      }, MSG_TIMEOUT]
    });
    const r = result?.result;
    return r?.ok ? { uuid: r.uuid, name: r.name } : null;
  } catch (_) {
    return null;
  }
}

// ----------------------------------------------------------
// Actor cache helpers
// ----------------------------------------------------------
async function getCachedActor(characterId) {
  const { actorCache = {} } = await chrome.storage.local.get('actorCache');
  return actorCache[String(characterId)] ?? null;
}

async function setCachedActor(characterId, actorId, actorName) {
  const { actorCache = {} } = await chrome.storage.local.get('actorCache');
  actorCache[String(characterId)] = { actorId, actorName };
  await chrome.storage.local.set({ actorCache });
}

async function clearCachedActor(characterId) {
  const { actorCache = {}, syncMeta = {} } = await chrome.storage.local.get(['actorCache', 'syncMeta']);
  delete actorCache[String(characterId)];
  delete syncMeta[String(characterId)];
  await chrome.storage.local.set({ actorCache, syncMeta });
}

// ----------------------------------------------------------
// Inject and message the Foundry module via window.postMessage.
// This function is serialised and injected into the Foundry page —
// it must be self-contained (no references to outer scope).
// ----------------------------------------------------------
function foundryBridge(message, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);

    function handler(event) {
      const d = event.data;
      if (!d || d.source !== 'ddb-sync-module') return;
      if (d.requestId !== message.requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(d);
    }

    window.addEventListener('message', handler);
    window.postMessage(message, '*');
  });
}

// ----------------------------------------------------------
// Portrait helpers
// ----------------------------------------------------------
async function fetchPortraitAsDataUrl(url) {
  try {
    const resp        = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const buffer      = await resp.arrayBuffer();
    const bytes       = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
    console.log(`${PREFIX} 🖼️ Portrait fetched (${Math.round(buffer.byteLength / 1024)} KB)`);
    return dataUrl;
  } catch (err) {
    console.warn(`${PREFIX} 🖼️ Portrait fetch failed: ${err.message}`);
    return null;
  }
}

// Injected into the Foundry tab to upload a portrait via FilePicker.
// Must be self-contained.
async function foundryUploadPortrait(dataUrl, characterName, folderName) {
  try {
    try { await FilePicker.createDirectory('data', folderName, {}); } catch (_) {}
    const [header, b64] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?);/)[1] ?? 'image/jpeg';
    const binary   = atob(b64);
    const arr      = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    const blob     = new Blob([arr], { type: mimeType });
    const ext      = (mimeType.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
    const safeName = characterName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = `${safeName}.${ext}`;
    const file     = new File([blob], filename, { type: mimeType });
    const result   = await FilePicker.upload('data', folderName, file, { notify: false });
    console.log('[DDB-Sync] 🖼️ Portrait uploaded →', result?.path);
    return result?.path ?? null;
  } catch (err) {
    console.error('[DDB-Sync] 🖼️ Portrait upload failed:', err.message);
    return null;
  }
}

async function uploadPortraitToFoundry(portraitDataUrl, characterName) {
  if (!portraitDataUrl) return null;
  const foundryTabs = await findFoundryTabs();
  if (foundryTabs.length !== 1) return null; // Can't upload without exactly one Foundry tab
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: foundryTabs[0].tab.id },
      world:  'MAIN',
      func:   foundryUploadPortrait,
      args:   [portraitDataUrl, characterName, 'ddb-portraits']
    });
    const path = result?.result ?? null;
    if (path) console.log(`${PREFIX} 🖼️ Portrait stored at ${path}`);
    return path;
  } catch (err) {
    console.warn(`${PREFIX} 🖼️ Portrait upload failed: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------------
// Fetch fresh character JSON directly from the service worker.
// Host permissions on dndbeyond.com let DDB session cookies flow
// with credentials:'include' — no tab injection needed.
// (Confirmed via service-worker console test, May 2026.)
//
// Returns { data, reason }:
//   - on success: { data: <character JSON>, reason: null }
//   - on failure: { data: null, reason: <user-facing message> }
//
// Failure modes observed in the wild:
//   - 404: DDB has no exportable JSON for this character. Not always
//     propagation lag — older characters can 404 while newer ones
//     work, so we don't assume "wait and retry" will help.
//   - 500: DDB threw an unhandled exception serializing the character
//     (e.g. character "Null"). Usually a corrupted item/class option.
//   - 401/403: session cookies didn't flow or aren't valid.
// ----------------------------------------------------------
async function fetchFreshCharacterData(characterId) {
  let resp;
  try {
    resp = await fetch(
      `https://www.dndbeyond.com/character/${characterId}/json`,
      { credentials: 'include' }
    );
  } catch (err) {
    console.warn(`${PREFIX} Fresh fetch network error: ${err.message}`);
    return { data: null, reason: `Network error fetching character JSON: ${err.message}` };
  }

  if (resp.status === 404) {
    console.warn(`${PREFIX} Fresh fetch 404 for character ${characterId}`);
    return {
      data: null,
      reason: 'DDB has no exportable JSON for this character (404). Try opening the character sheet in DDB and making a small change (e.g. equip/unequip an item) to force a re-export, then try again. Some characters persistently 404 — let Kev know if this one does.'
    };
  }
  if (resp.status === 500) {
    console.warn(`${PREFIX} Fresh fetch 500 for character ${characterId}`);
    return {
      data: null,
      reason: 'DDB couldn\'t export this character (500 server error) — its data is likely corrupted. Try removing recently-added items or homebrew content, duplicating the character, or contacting DDB support.'
    };
  }
  if (resp.status === 401 || resp.status === 403) {
    console.warn(`${PREFIX} Fresh fetch ${resp.status} for character ${characterId}`);
    return {
      data: null,
      reason: 'DDB rejected the request (auth) — make sure you\'re logged in to DDB in this browser.'
    };
  }
  if (!resp.ok) {
    console.warn(`${PREFIX} Fresh fetch HTTP ${resp.status} for character ${characterId}`);
    return {
      data: null,
      reason: `DDB returned HTTP ${resp.status} when fetching character JSON.`
    };
  }

  let json;
  try {
    json = await resp.json();
  } catch (err) {
    console.warn(`${PREFIX} Fresh fetch JSON parse error: ${err.message}`);
    return { data: null, reason: 'DDB returned a response that wasn\'t valid JSON.' };
  }
  // Endpoint returns the character object flat (no .data wrapper).
  // mapDDBToFoundryActor handles both shapes via `ddbData.data ?? ddbData`.
  const name = json?.name ?? json?.data?.name;
  if (!name) {
    console.warn(`${PREFIX} Fresh fetch returned 200 but no character data`);
    return {
      data: null,
      reason: 'DDB returned an empty response — are you logged in to DDB?'
    };
  }
  console.log(`${PREFIX} ✅ Fresh character JSON fetched (${name})`);
  return { data: json, reason: null };
}

// ----------------------------------------------------------
// Read HP and AC directly from the DDB character sheet DOM.
// Single injection — reads both values in one pass.
// Used as fallback when re-import is triggered from the popup
// (content.js handles it directly when triggered from the panel).
// ----------------------------------------------------------
async function readStatsFromDDBTab(characterId) {
  const tabs = await chrome.tabs.query({ url: `*://www.dndbeyond.com/characters/${characterId}*` });
  if (!tabs[0]) {
    console.log(`${PREFIX} DDB tab not open — HP/AC will fall back to JSON calculation`);
    return null;
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world:  'MAIN',
      func:   () => {
        const find = (selectors) => {
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return null;
        };
        // HP
        const currentEl = find(['[data-testid="current-hp"]', '[class*="valueButton"][class*="number"]', '.ct-health-summary__hp-item--current input', '.ct-health-summary__hp-item--current .ct-health-summary__hp-value']);
        const maxEl     = find(['[data-testid="max-hp"]', '.ct-health-summary__hp-item--max .ct-health-summary__hp-value', '.ct-health-summary__hp-item--max']);
        const tempEl    = find(['[data-testid="temp-hp"]', '.ct-health-summary__hp-item--temp input', '.ct-health-summary__hp-item--temp .ct-health-summary__hp-value']);
        const getText   = (el) => el?.textContent?.trim() || el?.value || '';
        const current   = parseInt(getText(currentEl));
        const max       = parseInt(getText(maxEl));
        const temp      = parseInt(getText(tempEl)) || 0;
        const hp = (!isNaN(current) && !isNaN(max) && max > 0) ? { current, max, temp } : null;
        // AC
        const acEl = find(['.ct-armor-class-box__value', '.ddbc-armor-class-box__value', '[class*="armorClass"] [class*="value"]', '[class*="armor-class"] [class*="value"]']);
        const acVal = parseInt(acEl?.textContent ?? '');
        const ac = (!isNaN(acVal) && acVal > 0) ? acVal : null;
        // Ability scores — read displayed totals (includes racial/ASI/feat bonuses)
        const NAME_TO_KEY = { strength:'str',dexterity:'dex',constitution:'con',intelligence:'int',wisdom:'wis',charisma:'cha',str:'str',dex:'dex',con:'con',int:'int',wis:'wis',cha:'cha' };
        const abilitiesRaw = {};
        const abilityLabelEls = document.querySelectorAll('.ddbc-ability-summary__label');
        const abilityScoreEls = document.querySelectorAll('.ddbc-ability-summary__secondary');
        abilityLabelEls.forEach((labelEl, i) => {
          const scoreEl = abilityScoreEls[i];
          if (!scoreEl) return;
          const key   = NAME_TO_KEY[labelEl.textContent.trim().toLowerCase()];
          const value = parseInt(scoreEl.textContent.trim());
          if (key && !isNaN(value)) abilitiesRaw[key] = value;
        });
        const abilities = Object.keys(abilitiesRaw).length === 6 ? abilitiesRaw : null;
        // Saving throw proficiency flags
        const SAVE_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
        const savesRaw = {};
        document.querySelectorAll('.ddbc-saving-throws-summary__ability-proficiency').forEach((el, i) => {
          const key = SAVE_KEYS[i];
          if (key) savesRaw[key] = el.querySelector('[aria-label="Proficient"]') ? 1 : 0;
        });
        const saves = Object.keys(savesRaw).length === 6 ? savesRaw : null;
        // Movement speeds (only available if speed panel is open)
        const SPEED_MAP = { walking:'walk', flying:'fly', climbing:'climb', burrowing:'burrow', swimming:'swim' };
        const movementRaw = { units: 'ft' };
        document.querySelectorAll('.ct-speed-manage-pane__speed').forEach(item => {
          const label = item.querySelector('.ct-speed-manage-pane__speed-label')?.textContent?.trim().toLowerCase();
          const value = parseInt(item.querySelector('.ct-speed-manage-pane__speed-amount')?.textContent);
          const key   = SPEED_MAP[label];
          if (key && !isNaN(value)) movementRaw[key] = value;
        });
        let movement = Object.keys(movementRaw).length > 1 ? movementRaw : null;
        if (!movement) {
          const headingEl = document.querySelector('.ct-speed-box__heading');
          const valueEl   = document.querySelector('.ct-speed-box__box-value');
          const speedType = headingEl?.textContent?.trim().toLowerCase();
          const speedVal  = parseInt(valueEl?.textContent);
          const key       = SPEED_MAP[speedType];
          if (key && !isNaN(speedVal)) movement = { units: 'ft', [key]: speedVal };
        }
        // Initiative
        const initEl  = document.querySelector('.ct-combat__summary-group--initiative button');
        const initVal = parseInt(initEl?.textContent?.trim());
        const initiative = !isNaN(initVal) ? initVal : null;
        return { hp, ac, abilities, saves, movement, initiative };
      }
    });
    const stats = result?.result ?? null;
    if (stats?.hp)        console.log(`${PREFIX} HP from DDB DOM: ${stats.hp.current}/${stats.hp.max} temp=${stats.hp.temp}`);
    if (stats?.ac)        console.log(`${PREFIX} AC from DDB DOM: ${stats.ac}`);
    if (stats?.abilities) console.log(`${PREFIX} Abilities from DDB DOM:`, stats.abilities);
    if (stats?.saves)      console.log(`${PREFIX} Saving throws from DDB DOM:`, stats.saves);
    if (stats?.movement)   console.log(`${PREFIX} Movement from DDB DOM:`, stats.movement);
    if (stats?.initiative !== null && stats?.initiative !== undefined) console.log(`${PREFIX} Initiative from DDB DOM: ${stats.initiative}`);
    return stats;
  } catch (err) {
    console.warn(`${PREFIX} readStatsFromDDBTab failed: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------------
// Monster actor builder — helpers
// ----------------------------------------------------------

// Convert "21 (6d6)" and "13 (2d8 + 4)" patterns to Foundry inline rolls.
// Keeps the average value visible and makes the dice formula clickable.
function convertDiceToInlineRolls(text) {
  if (!text) return '';
  return text.replace(
    /(\d+) \((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)/g,
    (_, avg, formula) => `${avg} ([[/roll ${formula.replace(/\s+/g, '')}]])`
  );
}

function formatCR(cr) {
  if (cr === 0.125) return '1/8';
  if (cr === 0.25)  return '1/4';
  if (cr === 0.5)   return '1/2';
  return String(cr ?? 0);
}

// Token grid size by creature size category
function tokenSizeForCreature(size) {
  const map = { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4 };
  return map[size] ?? 1;
}

// Build the NPC biography as Foundry-enriched HTML.
// All traits, actions, reactions and legendary actions are written as
// formatted paragraphs with clickable [[/roll]] inline dice buttons.
// This avoids needing to create individual Item entries for abilities.
function buildMonsterBiography(monster) {
  const parts = [];

  // Summary info line
  const info = [];
  if (monster.cr !== undefined) info.push(`<strong>CR:</strong> ${formatCR(monster.cr)}`);
  if (monster.skills)           info.push(`<strong>Skills:</strong> ${monster.skills}`);
  if (monster.languages)        info.push(`<strong>Languages:</strong> ${monster.languages}`);
  if (info.length) parts.push(`<p><em>${info.join(' &nbsp;|&nbsp; ')}</em></p>`);

  function renderSection(label, list) {
    if (!list?.length) return '';
    let html = `<h3>${label}</h3>`;
    for (const { name, desc } of list) {
      const converted = convertDiceToInlineRolls(desc);
      html += name
        ? `<p><strong>${name}.</strong> ${converted}</p>`
        : `<p>${converted}</p>`;
    }
    return html;
  }

  parts.push(renderSection('Traits',            monster.traits));
  parts.push(renderSection('Actions',           monster.actions));
  parts.push(renderSection('Bonus Actions',     monster.bonusActions));
  parts.push(renderSection('Reactions',         monster.reactions));
  parts.push(renderSection('Legendary Actions', monster.legendaryActions));
  parts.push(renderSection('Lair Actions',      monster.lairActions));

  return parts.filter(Boolean).join('\n');
}

// ----------------------------------------------------------
// Monster actor builder
// ----------------------------------------------------------
function buildMonsterActor(monster) {
  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

  // Build abilities object with save proficiency flags
  const abilities = {};
  ABILITY_KEYS.forEach(key => {
    abilities[key] = {
      value:      monster.abilities?.[key] ?? 10,
      proficient: monster.saves?.[key]     ?? 0
    };
  });

  const biographyValue = buildMonsterBiography(monster);
  const tokenSize      = tokenSizeForCreature(monster.size);

  return {
    name: monster.name,
    type: 'npc',
    img:  monster.avatarUrl || 'icons/svg/mystery-man.svg',
    flags: {
      [MODULE_ID]: {
        monsterId:  String(monster.monsterId),
        sourceUrl:  monster.sourceUrl,
        importedAt: new Date().toISOString()
      }
    },
    system: {
      abilities,
      attributes: {
        ac:       { flat: monster.ac ?? 10, calc: 'flat' },
        hp:       { value: monster.hp ?? 0, max: monster.hp ?? 0, formula: monster.hpFormula ?? '' },
        movement: monster.speed  ?? { walk: 0, units: 'ft' },
        senses:   monster.senses ?? { units: 'ft' }
      },
      details: {
        biography: { value: biographyValue, public: '' },
        alignment: monster.alignment ?? '',
        cr:        monster.cr        ?? 0,
        type: {
          value:   monster.type    ?? 'humanoid',
          subtype: monster.subtype ?? '',
          swarm:   '',
          custom:  ''
        }
      },
      traits: {
        size: monster.size ?? 'med',
        di:   monster.di   ?? { value: [], custom: '' },
        dr:   monster.dr   ?? { value: [], custom: '' },
        dv:   monster.dv   ?? { value: [], custom: '' },
        ci:   monster.ci   ?? { value: [], custom: '' },
        languages: { value: [], custom: monster.languages ?? '' }
      }
    },
    prototypeToken: {
      name:        monster.name,
      texture:     { src: monster.avatarUrl || 'icons/svg/mystery-man.svg' },
      actorLink:   false,
      disposition: -1,    // hostile by default for NPCs
      displayName: 20,
      displayBars: 20,
      bar1:        { attribute: 'attributes.hp' },
      vision:      false,
      width:       tokenSize,
      height:      tokenSize
    }
  };
}

// ----------------------------------------------------------
// Message handlers
// ----------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ---- Character page loaded ----
  // Queries Foundry to determine link state for this character.
  // Returns { state, actorId?, actorName?, worlds? } to content.js.
  if (message.type === 'CHARACTER_PAGE_LOADED') {
    const { characterId, characterName } = message;
    chrome.storage.local.set({ characterId, characterName });
    console.log(`${PREFIX} Character page: ${characterName} (${characterId})`);

    (async () => {
      try {
        const foundryTabs = await findFoundryTabs();
        console.log(`${PREFIX} Foundry tabs found: ${foundryTabs.length}`);

        if (foundryTabs.length === 0) {
          sendResponse({ state: 'no_foundry' });
          return;
        }
        if (foundryTabs.length > 1) {
          const worlds = foundryTabs.map(f => f.world);
          console.warn(`${PREFIX} Multiple Foundry tabs: ${worlds.join(', ')}`);
          sendResponse({ state: 'multiple_foundry', worlds });
          return;
        }

        const { tab } = foundryTabs[0];
        const actor = await findActorInTab(tab, { characterId });

        if (actor) {
          await setCachedActor(characterId, actor.uuid, actor.name);
          console.log(`${PREFIX} Linked actor found: ${actor.name} (${actor.uuid})`);
          sendResponse({ state: 'linked', actorId: actor.uuid, actorName: actor.name });
        } else {
          console.log(`${PREFIX} No linked actor found for character ${characterId}`);
          sendResponse({ state: 'unlinked' });
        }

      } catch (err) {
        console.error(`${PREFIX} CHARACTER_PAGE_LOADED error:`, err.message);
        sendResponse({ state: 'error', reason: err.message });
      }
    })();

    return true; // Keep message channel open for async response
  }

  // ---- One-click actor creation ----
  // Fetches character JSON fresh at click time — no reliance on chrome.storage cache.
  if (message.type === 'CREATE_FOUNDRY_ACTOR') {
    (async () => {
      const { characterId } = await chrome.storage.local.get('characterId');
      if (!characterId) {
        sendResponse({ ok: false, reason: 'No character ID — open a DDB character sheet first.' });
        return;
      }
      try {
        await sendToFoundry('ping');

        const fetchResult = await fetchFreshCharacterData(characterId);
        if (!fetchResult.data) {
          sendResponse({ ok: false, reason: fetchResult.reason });
          return;
        }
        const characterData = fetchResult.data;

        const domStats = await readStatsFromDDBTab(characterId);
        const actorData = mapDDBToFoundryActor(
          characterData, characterId,
          domStats?.hp ?? null, domStats?.ac ?? null,
          domStats?.abilities ?? null, domStats?.saves ?? null,
          domStats?.initiative ?? null, domStats?.movement ?? null
        );
        console.log(`${PREFIX} Creating actor: ${actorData.name}`);

        if (actorData.img?.startsWith('http')) {
          const dataUrl   = await fetchPortraitAsDataUrl(actorData.img);
          const localPath = await uploadPortraitToFoundry(dataUrl, actorData.name);
          if (localPath) {
            actorData.img = localPath;
            if (actorData.prototypeToken?.texture) actorData.prototypeToken.texture.src = localPath;
          }
        }

        const created = await sendToFoundry('createActor', { actorData });
        await setCachedActor(characterId, created.uuid, created.name);

        console.log(`${PREFIX} ✅ Actor created: ${created.name} (${created.uuid})`);
        sendResponse({ ok: true, actorId: created.uuid, actorName: created.name });

      } catch (err) {
        console.error(`${PREFIX} Actor creation failed:`, err.message);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // ---- Monster import ----
  if (message.type === 'IMPORT_MONSTER') {
    const { monster } = message;
    (async () => {
      try {
        await sendToFoundry('ping');

        // Upload portrait to Foundry (mirrors character import flow)
        let portraitPath = monster.avatarUrl || '';
        if (monster.avatarUrl?.startsWith('http')) {
          console.log(`${PREFIX} 🖼️ Fetching monster portrait…`);
          const dataUrl = await fetchPortraitAsDataUrl(monster.avatarUrl);
          const uploaded = await uploadPortraitToFoundry(dataUrl, monster.name);
          if (uploaded) {
            portraitPath = uploaded;
            console.log(`${PREFIX} 🖼️ Portrait stored at: ${portraitPath}`);
          } else {
            console.warn(`${PREFIX} 🖼️ Portrait upload failed — using external URL as fallback`);
          }
        }

        const actorData = buildMonsterActor({ ...monster, avatarUrl: portraitPath });

        // Check if already imported — overwrite if so
        const foundryTabs = await findFoundryTabs();
        if (foundryTabs.length !== 1) throw new Error('Exactly one Foundry tab required for import');
        const { tab } = foundryTabs[0];
        const existing = await findActorInTab(tab, { monsterId: monster.monsterId });

        let result;
        if (existing) {
          console.log(`${PREFIX} Overwriting existing actor: ${existing.name} (${existing.uuid})`);
          result = await sendToFoundryTab(tab, 'updateActor', { uuid: existing.uuid, actorData });
        } else {
          result = await sendToFoundryTab(tab, 'createActor', { actorData });
        }

        console.log(`${PREFIX} ✅ Monster ${existing ? 'updated' : 'created'}: ${result.name} (${result.uuid})`);
        sendResponse({ ok: true, uuid: result.uuid, actorName: result.name });
      } catch (err) {
        console.error(`${PREFIX} Monster import failed:`, err.message);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // ---- Character re-import (overwrites linked actor) ----
  // Fetches character JSON fresh at click time — no reliance on chrome.storage cache.
  if (message.type === 'REIMPORT_CHARACTER') {
    (async () => {
      const { characterId } = await chrome.storage.local.get('characterId');
      if (!characterId) {
        sendResponse({ ok: false, reason: 'No character ID — open a DDB character sheet first.' });
        return;
      }

      const cached = await getCachedActor(characterId);
      if (!cached) {
        sendResponse({ ok: false, reason: 'No linked actor — create one first.' });
        return;
      }

      try {
        await sendToFoundry('ping');

        const fetchResult = await fetchFreshCharacterData(characterId);
        if (!fetchResult.data) {
          sendResponse({ ok: false, reason: fetchResult.reason });
          return;
        }
        const characterData = fetchResult.data;

        // HP, AC, and abilities: use DOM values sent by content.js (panel trigger).
        // Fall back to injecting into DDB tab only if triggered from the popup.
        let hp         = message.hp         ?? null;
        let ac         = message.ac         ?? null;
        let abilities  = message.abilities  ?? null;
        let saves      = message.saves      ?? null;
        let initiative = message.initiative ?? null;
        let movement   = message.movement   ?? null; // optional
        if (!hp || ac === null || !abilities || !saves || initiative === null) {
          const domStats = await readStatsFromDDBTab(characterId);
          hp         = hp         ?? domStats?.hp         ?? null;
          ac         = ac         ?? domStats?.ac         ?? null;
          abilities  = abilities  ?? domStats?.abilities  ?? null;
          saves      = saves      ?? domStats?.saves      ?? null;
          initiative = initiative ?? domStats?.initiative ?? null;
          movement   = movement   ?? domStats?.movement   ?? null;
        }
        const actorData = mapDDBToFoundryActor(characterData, characterId, hp, ac, abilities, saves, initiative, movement);

        if (actorData.img?.startsWith('http')) {
          const dataUrl   = await fetchPortraitAsDataUrl(actorData.img);
          const localPath = await uploadPortraitToFoundry(dataUrl, actorData.name);
          if (localPath) {
            actorData.img = localPath;
            if (actorData.prototypeToken?.texture) actorData.prototypeToken.texture.src = localPath;
          }
        }

        const result = await sendToFoundry('updateActor', { uuid: cached.actorId, actorData });
        console.log(`${PREFIX} ✅ Character re-imported: ${result.name}`);
        sendResponse({ ok: true, actorName: result.name });
      } catch (err) {
        console.error(`${PREFIX} Re-import failed:`, err.message);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // ---- HP sync ----
  if (message.type === 'PUSH_HP_TO_FOUNDRY') {
    const { characterId, hp } = message;
    console.log(`${PREFIX} 💉 HP push for character ${characterId}: ${hp.current}/${hp.max} temp=${hp.temp}`);

    (async () => {
      // Try cache first for performance
      let cached = await getCachedActor(characterId);

      // Cache miss — do a live Foundry lookup
      if (!cached) {
        console.log(`${PREFIX} Actor not in cache — querying Foundry`);
        try {
          const foundryTabs = await findFoundryTabs();
          if (foundryTabs.length === 1) {
            const actor = await findActorInTab(foundryTabs[0].tab, { characterId });
            if (actor) {
              await setCachedActor(characterId, actor.uuid, actor.name);
              cached = { actorId: actor.uuid, actorName: actor.name };
            }
          }
        } catch (_) {}
      }

      if (!cached) {
        console.warn(`${PREFIX} HP sync skipped — no actor found for character ${characterId}`);
        sendResponse({ ok: false, reason: 'No linked actor found — refresh the DDB tab' });
        return;
      }

      try {
        await sendToFoundry('updateHP', { actorUuid: cached.actorId, hp });

        // Update sync metadata
        const { syncMeta = {} } = await chrome.storage.local.get('syncMeta');
        syncMeta[String(characterId)] = { lastSyncTime: Date.now() };
        await chrome.storage.local.set({ syncMeta });

        console.log(`${PREFIX} ✅ HP synced → ${hp.current}/${hp.max} temp=${hp.temp}`);
        sendResponse({ ok: true });
      } catch (err) {
        console.error(`${PREFIX} HP sync failed:`, err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ---- AC sync ----
  if (message.type === 'PUSH_AC_TO_FOUNDRY') {
    const { characterId, ac } = message;
    console.log(`${PREFIX} 🛡️ AC push for character ${characterId}: ${ac}`);

    (async () => {
      let cached = await getCachedActor(characterId);
      if (!cached) {
        try {
          const foundryTabs = await findFoundryTabs();
          if (foundryTabs.length === 1) {
            const actor = await findActorInTab(foundryTabs[0].tab, { characterId });
            if (actor) {
              await setCachedActor(characterId, actor.uuid, actor.name);
              cached = { actorId: actor.uuid, actorName: actor.name };
            }
          }
        } catch (_) {}
      }
      if (!cached) {
        sendResponse({ ok: false, reason: 'No linked actor found' });
        return;
      }
      try {
        await sendToFoundry('updateAC', { actorUuid: cached.actorId, ac });
        console.log(`${PREFIX} ✅ AC synced → ${ac}`);
        sendResponse({ ok: true });
      } catch (err) {
        console.error(`${PREFIX} AC sync failed:`, err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ---- Unlink character from its Foundry actor ----
  if (message.type === 'UNLINK_CHARACTER') {
    const { characterId } = message;

    (async () => {
      const cached = await getCachedActor(characterId);
      if (cached) {
        try {
          await sendToFoundry('unlinkActor', { uuid: cached.actorId });
        } catch (err) {
          console.warn(`${PREFIX} Could not remove flag from actor (may already be deleted): ${err.message}`);
          // Continue with cache clear regardless
        }
      }
      await clearCachedActor(characterId);
      console.log(`${PREFIX} ✅ Character ${characterId} unlinked`);
      sendResponse({ ok: true });
    })();
    return true;
  }

});

// ----------------------------------------------------------
// DDB HP endpoint watcher
// ----------------------------------------------------------
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.url.includes(HP_ENDPOINT)) return;
    if (details.statusCode < 200 || details.statusCode > 299) return;

    console.log(`${PREFIX} ⚡ HP save detected`);

    if (details.tabId > 0) {
      chrome.tabs.sendMessage(details.tabId, { type: 'HP_SAVE_DETECTED' }).catch(() => {});
    }
  },
  { urls: ['*://character-service.dndbeyond.com/character/v5/life/hp/*'] }
);

// ----------------------------------------------------------
// DDB AC endpoint watcher
// Fires when armour is equipped/unequipped or AC is manually overridden
// ----------------------------------------------------------
const AC_ENDPOINTS = [
  'character-service.dndbeyond.com/character/v5/inventory/item/equipped',
  'character-service.dndbeyond.com/character/v5/custom/value',
];

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!AC_ENDPOINTS.some(ep => details.url.includes(ep))) return;
    if (details.statusCode < 200 || details.statusCode > 299) return;

    console.log(`${PREFIX} ⚡ AC change detected`);

    if (details.tabId > 0) {
      chrome.tabs.sendMessage(details.tabId, { type: 'AC_CHANGE_DETECTED' }).catch(() => {});
    }
  },
  { urls: [
    '*://character-service.dndbeyond.com/character/v5/inventory/*',
    '*://character-service.dndbeyond.com/character/v5/custom/*'
  ]}
);

// Broad DDB API logger
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!['POST', 'PUT', 'PATCH'].includes(details.method)) return;
    console.log(`${PREFIX} 📡 ${details.method} ${details.url} [${details.statusCode}]`);
  },
  { urls: ['*://character-service.dndbeyond.com/*'] }
);

// ----------------------------------------------------------
// DDB → Foundry dnd5e actor mapper
// ----------------------------------------------------------
// hpOverride: { current, max, temp } read from DDB DOM — use this when available.
// acOverride: flat AC value read from DDB DOM — use this when available.
// Both fall back to JSON-based calculation only if the DDB tab isn't open.
function mapDDBToFoundryActor(ddbData, ddbCharacterId, hpOverride = null, acOverride = null, abilitiesOverride = null, savesOverride = null, initiativeOverride = null, movementOverride = null) {
  const char = ddbData.data ?? ddbData;

  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const abilities    = {};

  if (abilitiesOverride) {
    // Source of truth: DDB DOM values — includes racial/ASI/feat bonuses, no calculation needed
    ABILITY_KEYS.forEach(key => {
      if (abilitiesOverride[key] !== undefined) {
        abilities[key] = { value: abilitiesOverride[key] };
      }
    });
    console.log(`${PREFIX} Abilities from DOM override:`, abilitiesOverride);
  } else {
    // Fallback: derive from JSON (DDB tab not open — misses modifiers)
    char.stats?.forEach((stat, i) => {
      const key = ABILITY_KEYS[i];
      if (!key) return;
      const base     = stat.value ?? 10;
      const bonus    = char.bonusStats?.find(s => s.id === stat.id)?.value ?? 0;
      const override = char.overrideStats?.find(s => s.id === stat.id)?.value;
      abilities[key] = { value: override ?? (base + bonus) };
    });
    console.log(`${PREFIX} Abilities calculated from JSON (DDB tab not open — may be missing modifiers)`);
  }

  // Merge saving throw proficiency flags into abilities
  if (savesOverride) {
    ABILITY_KEYS.forEach(key => {
      if (abilities[key] && savesOverride[key] !== undefined) {
        abilities[key].proficient = savesOverride[key];
      }
    });
    console.log(`${PREFIX} Saving throw proficiencies from DOM override:`, savesOverride);
  }

  const totalLevel = char.classes?.reduce((sum, c) => sum + (c.level ?? 0), 0) ?? 0;

  let hpMax, hpCurrent, hpTemp;
  if (hpOverride) {
    // Source of truth: DDB DOM values — no calculation
    hpMax     = hpOverride.max;
    hpCurrent = hpOverride.current;
    hpTemp    = hpOverride.temp ?? 0;
    console.log(`${PREFIX} HP from DOM override: ${hpCurrent}/${hpMax} temp=${hpTemp}`);
  } else {
    // Fallback: derive from JSON (DDB tab not open)
    const conScore = abilities.con?.value ?? 10;
    const conMod   = Math.floor((conScore - 10) / 2);
    const baseHP   = char.baseHitPoints ?? 0;
    const bonusHP  = char.bonusHitPoints ?? 0;
    hpMax     = char.overrideHitPoints ?? (baseHP + bonusHP + conMod * totalLevel);
    hpCurrent = Math.max(0, hpMax - (char.removedHitPoints ?? 0));
    hpTemp    = char.temporaryHitPoints ?? 0;
    console.log(`${PREFIX} HP calculated (DDB tab not open): ${hpCurrent}/${hpMax} temp=${hpTemp}`);
  }

  // Movement comes from DOM only (panel = all speeds; main box = walking only)
  const resolvedMovement = movementOverride;

  const img = char.avatarUrl
           || char.decorations?.avatarUrl
           || char.decorations?.frameAvatarUrl
           || char.decorations?.smallBackdropAvatarUrl
           || 'icons/svg/mystery-man.svg';

  console.log(`${PREFIX} 🖼️ avatarUrl: "${char.avatarUrl ?? 'null'}" | resolved → "${img}"`);

  return {
    name: char.name,
    type: 'character',
    img,
    flags: {
      [MODULE_ID]: {
        characterId: String(ddbCharacterId),
        syncedAt:    new Date().toISOString()
      }
    },
    system: {
      abilities,
      attributes: {
        ...(acOverride !== null    && { ac:       { flat: acOverride, calc: 'flat' } }),
        ...(resolvedMovement      && { movement: resolvedMovement }),
        ...(initiativeOverride !== null && (() => {
          const dexScore = abilities.dex?.value ?? 10;
          const dexMod   = Math.floor((dexScore - 10) / 2);
          const initBonus = initiativeOverride - dexMod;
          console.log(`${PREFIX} Initiative: DDB total=${initiativeOverride}, DEX mod=${dexMod}, bonus to set=${initBonus}`);
          return { init: { bonus: initBonus } };
        })()),
        hp: {
          value:    hpCurrent,
          min:      0,
          max:      hpMax,
          temp:     hpTemp,
          override: hpMax
        }
      },
      details: {
        race:       char.race?.fullName ?? '',
        background: char.background?.definition?.name ?? '',
        level:      totalLevel,
        xp:         { value: char.currentXp ?? 0 }
      },
      currency: {
        pp: char.currencies?.pp ?? 0,
        gp: char.currencies?.gp ?? 0,
        ep: char.currencies?.ep ?? 0,
        sp: char.currencies?.sp ?? 0,
        cp: char.currencies?.cp ?? 0
      }
    },
    prototypeToken: {
      name:        char.name,
      texture:     { src: img },
      actorLink:   true,
      disposition: 1,
      displayName: 20,
      displayBars: 20,
      bar1:        { attribute: 'attributes.hp' },
      vision:      true,
      width:       1,
      height:      1
    }
  };
}

console.log(`${PREFIX} Service worker started`);
