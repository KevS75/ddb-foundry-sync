// ============================================================
// DDB Foundry Sync — Monster Page Content Script v0.3.0
// Runs on dndbeyond.com/monsters/* pages
// Injects an "Import to Foundry" button and collects full monster data
// ============================================================

const PREFIX = '[DDB-Sync Monster]';

// ----------------------------------------------------------
// URL helper
// ----------------------------------------------------------

function getMonsterId() {
  return window.location.pathname.match(/\/monsters\/(\d+)/)?.[1] ?? null;
}

// ----------------------------------------------------------
// Parsing helpers
// ----------------------------------------------------------

function parseSpeed(text) {
  const s = { walk: 0, fly: 0, swim: 0, climb: 0, burrow: 0, hover: false, units: 'ft' };
  if (!text) return s;
  const w  = text.match(/^(\d+)/);           if (w)  s.walk   = +w[1];
  const f  = text.match(/fly\s+(\d+)/i);     if (f)  s.fly    = +f[1];
  const sw = text.match(/swim\s+(\d+)/i);    if (sw) s.swim   = +sw[1];
  const c  = text.match(/climb\s+(\d+)/i);   if (c)  s.climb  = +c[1];
  const b  = text.match(/burrow\s+(\d+)/i);  if (b)  s.burrow = +b[1];
  if (/hover/i.test(text)) s.hover = true;
  return s;
}

// "Medium humanoid (elf), chaotic evil" → { size, type, subtype, alignment }
function parseMeta(text) {
  const SIZE_MAP = {
    tiny: 'tiny', small: 'sm', medium: 'med',
    large: 'lg',  huge: 'huge', gargantuan: 'grg'
  };
  const CREATURE_TYPES = [
    'aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental',
    'fey', 'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant', 'undead', 'swarm'
  ];

  if (!text) return { size: 'med', type: 'humanoid', subtype: '', alignment: '' };

  const firstComma = text.indexOf(',');
  const typePart   = firstComma > -1 ? text.slice(0, firstComma).trim() : text.trim();
  const alignment  = firstComma > -1 ? text.slice(firstComma + 1).trim() : '';
  const lower      = typePart.toLowerCase();

  let size = 'med';
  for (const [word, key] of Object.entries(SIZE_MAP)) {
    if (lower.startsWith(word)) { size = key; break; }
  }

  let type = 'humanoid';
  for (const t of CREATURE_TYPES) {
    if (lower.includes(t)) { type = t; break; }
  }

  const subtypeMatch = typePart.match(/\(([^)]+)\)/);
  return { size, type, subtype: subtypeMatch?.[1] ?? '', alignment };
}

// "5 (1,800 XP)" → 5  |  "1/2 (100 XP)" → 0.5  |  "1/4" → 0.25
function parseCR(text) {
  if (!text) return 0;
  const frac = text.match(/^(1\/\d+)/);
  if (frac) { const [n, d] = frac[1].split('/'); return parseInt(n) / parseInt(d); }
  return parseFloat(text.match(/[\d.]+/)?.[0] ?? '0') || 0;
}

// "Dex +6, Con +8, Wis +5" → { dex: 1, con: 1, wis: 1 }
function parseSaves(text) {
  const saves = {};
  if (!text) return saves;
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(Str|Dex|Con|Int|Wis|Cha)/i);
    if (m) saves[m[1].toLowerCase()] = 1;
  }
  return saves;
}

function parseSenses(text) {
  const s = { darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0, units: 'ft', special: '' };
  if (!text) return s;
  const d = text.match(/darkvision\s+(\d+)/i);   if (d) s.darkvision  = +d[1];
  const b = text.match(/blindsight\s+(\d+)/i);   if (b) s.blindsight  = +b[1];
  const t = text.match(/tremorsense\s+(\d+)/i);  if (t) s.tremorsense = +t[1];
  const u = text.match(/truesight\s+(\d+)/i);    if (u) s.truesight   = +u[1];
  const p = text.match(/passive perception\s+(\d+)/i);
  if (p) s.special = `Passive Perception ${p[1]}`;
  return s;
}

const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning',
  'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'
];

function parseDamageList(text) {
  if (!text) return { value: [], custom: '' };
  const lower = text.toLowerCase();
  const value = DAMAGE_TYPES.filter(dt => lower.includes(dt));
  let custom  = '';
  // When it's conditional (nonmagical weapons), note it as custom text
  // and remove the individual damage types to avoid false classification
  if (lower.includes('nonmagical')) {
    custom = 'Bludgeoning, Piercing, and Slashing from Nonmagical Attacks';
    ['bludgeoning', 'piercing', 'slashing'].forEach(t => {
      const i = value.indexOf(t); if (i > -1) value.splice(i, 1);
    });
  }
  return { value, custom };
}

const CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
  'prone', 'restrained', 'stunned', 'unconscious'
];

function parseConditionList(text) {
  if (!text) return { value: [], custom: '' };
  const lower = text.toLowerCase();
  return { value: CONDITIONS.filter(c => lower.includes(c)), custom: '' };
}

// ----------------------------------------------------------
// Description block scraper
// Collects traits, actions, bonus actions, reactions, legendary actions
// ----------------------------------------------------------

function scrapeDescriptionBlocks(sb) {
  const result = {
    traits: [], actions: [], bonusActions: [],
    reactions: [], legendaryActions: [], lairActions: []
  };

  const SECTION_MAP = {
    'actions':           'actions',
    'bonus actions':     'bonusActions',
    'reactions':         'reactions',
    'legendary actions': 'legendaryActions',
    'legendary action':  'legendaryActions',
    'lair actions':      'lairActions'
  };

  let currentKey = 'traits';

  sb.querySelectorAll('.mon-stat-block__description-block').forEach(block => {
    // Section heading (if present) determines which category we're in
    const heading = block.querySelector(
      '.mon-stat-block__description-block-heading, h3, h4'
    )?.textContent?.trim().toLowerCase();
    if (heading) currentKey = SECTION_MAP[heading] ?? 'traits';

    // Each individual named ability within this block
    block.querySelectorAll('.mon-stat-block__description-block-content').forEach(content => {
      const nameEl  = content.querySelector(
        '.mon-stat-block__description-block-name, p strong:first-child'
      );
      const rawName = nameEl?.textContent?.replace(/\.$/, '').trim() ?? '';

      // Body text: clone, strip name element, collect remaining text
      const clone = content.cloneNode(true);
      clone.querySelector('.mon-stat-block__description-block-name')?.remove();
      const desc = clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';

      if (rawName || desc) result[currentKey].push({ name: rawName, desc });
    });
  });

  return result;
}

// ----------------------------------------------------------
// Main stat block scraper
// ----------------------------------------------------------

function scrapeStatBlock() {
  const sb = document.querySelector('.mon-stat-block');
  if (!sb) return null;

  const name = sb.querySelector('.mon-stat-block__name')?.textContent?.trim();

  // Attribute row helper (AC, HP, Speed)
  function getAttrValue(label) {
    for (const attr of sb.querySelectorAll('.mon-stat-block__attribute')) {
      const l = attr.querySelector('.mon-stat-block__attribute-label')?.textContent?.trim();
      if (l !== label) continue;
      return attr.querySelector(
        '.mon-stat-block__attribute-data-value, .mon-stat-block__attribute-value'
      )?.textContent?.trim() ?? '';
    }
    return '';
  }

  // AC — "12 (15 with mage armor)" → 12
  const acText = getAttrValue('Armor Class');
  const ac     = parseInt(acText.match(/\d+/)?.[0] ?? '10');

  // HP — "104 (16d8 + 32)" → value 104, formula "16d8 + 32"
  const hpText    = getAttrValue('Hit Points');
  const hp        = parseInt(hpText.match(/\d+/)?.[0] ?? '1');
  const hpFormula = hpText.match(/\(([^)]+)\)/)?.[1]?.trim() ?? '';

  const speed = parseSpeed(getAttrValue('Speed'));

  // Meta line: "Medium humanoid (elf), chaotic evil"
  const metaText = sb.querySelector('.mon-stat-block__meta')?.textContent?.trim() ?? '';
  const { size, type, subtype, alignment } = parseMeta(metaText);

  // Ability scores — DDB renders them left-to-right: STR DEX CON INT WIS CHA
  // Query .ability-block__stat elements and map positionally
  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const abilities    = {};
  const scoreEls     = Array.from(sb.querySelectorAll('.ability-block__score'))
    .filter(el => /^\d+$/.test(el.textContent.trim()))
    .slice(0, 6);
  if (scoreEls.length === 6) {
    scoreEls.forEach((el, i) => {
      abilities[ABILITY_KEYS[i]] = parseInt(el.textContent.trim());
    });
  }

  // Tidbits: Saving Throws, Skills, Senses, Languages, CR, immunities etc.
  const tidbits = {};
  sb.querySelectorAll('.mon-stat-block__tidbit').forEach(el => {
    const label = el.querySelector('.mon-stat-block__tidbit-label')?.textContent?.trim();
    const data  = el.querySelector('.mon-stat-block__tidbit-data')?.textContent?.trim();
    if (label && data) tidbits[label] = data;
  });

  const saves     = parseSaves(tidbits['Saving Throws']          ?? '');
  const cr        = parseCR(tidbits['Challenge'] ?? tidbits['CR'] ?? '');
  const senses    = parseSenses(tidbits['Senses']                 ?? '');
  const languages = tidbits['Languages']                          ?? '';
  const skills    = tidbits['Skills']                             ?? '';
  const di        = parseDamageList(tidbits['Damage Immunities']       ?? '');
  const dr        = parseDamageList(tidbits['Damage Resistances']      ?? '');
  const dv        = parseDamageList(tidbits['Damage Vulnerabilities']  ?? '');
  const ci        = parseConditionList(tidbits['Condition Immunities'] ?? '');

  const descBlocks = scrapeDescriptionBlocks(sb);

  return {
    name, ac, hp, hpFormula,
    speed, size, type, subtype, alignment,
    abilities, saves,
    skills, cr, senses, languages,
    di, dr, dv, ci,
    ...descBlocks  // traits, actions, bonusActions, reactions, legendaryActions, lairActions
  };
}

// ----------------------------------------------------------
// Fetch avatar URL from monster API
// Stats are locked for paid sourcebook monsters but avatarUrl is always returned
// ----------------------------------------------------------

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

    const abilityCount = Object.keys(scraped.abilities ?? {}).length;
    console.log(
      `${PREFIX} Importing: ${scraped.name}` +
      ` | CR ${scraped.cr} | AC ${scraped.ac} | HP ${scraped.hp}` +
      ` | Abilities: ${abilityCount}/6` +
      ` | Traits: ${scraped.traits?.length ?? 0}` +
      ` | Actions: ${scraped.actions?.length ?? 0}`
    );

    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_MONSTER',
      monster: {
        monsterId,
        name:      scraped.name,
        avatarUrl,
        sourceUrl: window.location.href,
        // Core stats
        ac:        scraped.ac,
        hp:        scraped.hp,
        hpFormula: scraped.hpFormula,
        speed:     scraped.speed,
        cr:        scraped.cr,
        // Identity
        size:      scraped.size,
        type:      scraped.type,
        subtype:   scraped.subtype,
        alignment: scraped.alignment,
        // Abilities & saves
        abilities: scraped.abilities,
        saves:     scraped.saves,
        // Misc stats
        skills:    scraped.skills,
        senses:    scraped.senses,
        languages: scraped.languages,
        // Immunities / resistances / vulnerabilities
        di: scraped.di,
        dr: scraped.dr,
        dv: scraped.dv,
        ci: scraped.ci,
        // Description blocks → built into biography in background.js
        traits:           scraped.traits,
        actions:          scraped.actions,
        bonusActions:     scraped.bonusActions,
        reactions:        scraped.reactions,
        legendaryActions: scraped.legendaryActions,
        lairActions:      scraped.lairActions
      }
    });

    if (response?.ok) {
      btn.textContent      = '✓ Imported!';
      btn.style.background = '#2e7d32';
      btn.title = `Imported as "${response.actorName}"`;
      const existing = await chrome.storage.local.get(['importedMonsters']);
      const map = existing.importedMonsters ?? {};
      map[monsterId] = { name: scraped.name, uuid: response.uuid };
      await chrome.storage.local.set({ importedMonsters: map });
    } else {
      throw new Error(response?.reason ?? 'Import failed — check extension console');
    }
  } catch (err) {
    console.error(`${PREFIX}`, err);
    btn.textContent      = '✗ Failed';
    btn.style.background = '#b71c1c';
    btn.title = err.message;
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent      = originalText;
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

  const stored = await chrome.storage.local.get(['importedMonsters']);
  const alreadyImported = !!(stored.importedMonsters?.[monsterId]);

  injectButton(alreadyImported);
  console.log(`${PREFIX} Button injected for monster ${monsterId}`);
}

init();
