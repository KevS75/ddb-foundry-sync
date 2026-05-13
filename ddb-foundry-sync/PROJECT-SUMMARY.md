# DDB Foundry Sync — Project Summary (v0.2.0)

Chrome extension + Foundry module that syncs D&D Beyond character/monster data to Foundry VTT. No external relay server — uses Chrome tab injection and `window.postMessage` to communicate directly with a lightweight Foundry module.

---

## What Was Built

### Part 1 — Chrome Extension (`ddb-foundry-sync/`)
```
manifest.json        — MV3 config, permissions, content script declarations
content.js           — Runs on DDB character pages; injects UI button, watches HP
content-monster.js   — Runs on DDB monster pages; scrapes stats, injects import button
background.js        — Service worker; tab injection, message routing, actor mapping
popup.html / popup.js — Extension popup; Foundry URL config, link status, re-import
```

### Part 2 — Foundry Module (`ddb-sync/`)
```
module.json          — Foundry module manifest (id: ddb-sync, verified: v13)
ddb-sync.js          — Listens for window.postMessage from extension; handles all CRUD
```
Module is installed at Molten Hosting via File Manager → `Data/modules/ddb-sync/`.

---

## Architecture

**No relay server.** The extension injects code into the user's open Foundry tab using `chrome.scripting.executeScript` with `world: 'MAIN'`, giving direct access to the `game` object. Communication is via `window.postMessage`.

```
DDB Character Page (Chrome tab)
  └── content.js
        ├── On load: fetches /character/{id}/json, stores ddbCharacterData + ddbCharacterHP
        ├── Injects "⚒ FOUNDRY SYNC" button into DDB character header
        ├── HP_SAVE_DETECTED → syncHP() → PUSH_HP_TO_FOUNDRY
        └── Sends messages to background.js via chrome.runtime.sendMessage

DDB Monster Page (Chrome tab)
  └── content-monster.js
        ├── Extracts monster ID from URL
        ├── Fetches avatarUrl from monster API (works even for locked monsters)
        ├── Scrapes AC + HP from rendered .mon-stat-block__attribute DOM elements
        └── Injects "⚔ Import to Foundry" button

Background Service Worker (background.js)
  ├── webRequest listener: character-service.dndbeyond.com/character/v5/life/hp/*
  │     └── On HP save: sends HP_SAVE_DETECTED to the DDB content tab
  ├── sendToFoundry(action, payload)
  │     └── Finds open Foundry tab → chrome.scripting.executeScript → foundryBridge()
  │           └── window.postMessage → Foundry module → reply via postMessage → return
  ├── fetchFreshCharacterData(characterId)
  │     └── Injects into DDB tab → fetch /character/{id}/json (same-origin) → return JSON
  └── Message handlers:
        CHARACTER_PAGE_LOADED  → cache ID/name; auto-find linked actor
        CREATE_FOUNDRY_ACTOR   → mapDDBToFoundryActor → sendToFoundry('createActor')
        REIMPORT_CHARACTER     → fetchFreshCharacterData → mapDDBToFoundryActor → sendToFoundry('updateActor')
        IMPORT_MONSTER         → buildMonsterActor → sendToFoundry('createActor' or 'updateActor')
        PUSH_HP_TO_FOUNDRY     → sendToFoundry('updateHP')

Foundry Tab (dont-web-the-cleric.moltenhosting.com)
  └── ddb-sync.js (Foundry module, GM only)
        ├── window.addEventListener('message') → handleMessage()
        └── Actions: ping | findActor | createActor | updateActor | updateHP
              └── reply() → window.postMessage({ source: 'ddb-sync-module', requestId, ... })
```

---

## Message Protocol

### Extension → Foundry (via `sendToFoundry`)
All messages: `{ source: 'ddb-sync-extension', action, requestId, ...payload }`

| Action | Payload | Response |
|--------|---------|----------|
| `ping` | — | `{ ok, world }` |
| `findActor` | `{ characterId? }` or `{ monsterId? }` | `{ ok, uuid, name }` |
| `createActor` | `{ actorData }` | `{ ok, uuid, name }` |
| `updateActor` | `{ uuid, actorData }` | `{ ok, uuid, name }` |
| `updateHP` | `{ actorUuid, hp: { current, max, temp } }` | `{ ok }` |

### Extension ↔ Background (chrome.runtime.sendMessage)
| Type | Direction | Purpose |
|------|-----------|---------|
| `CHARACTER_PAGE_LOADED` | content → bg | New DDB character page detected |
| `HP_SAVE_DETECTED` | bg → content | webRequest caught HP change; trigger sync |
| `CREATE_FOUNDRY_ACTOR` | popup/content → bg | Create actor from cached DDB data |
| `REIMPORT_CHARACTER` | popup → bg | Overwrite existing linked actor |
| `IMPORT_MONSTER` | content-monster → bg | Import monster to Foundry |
| `PUSH_HP_TO_FOUNDRY` | content → bg | Push current HP values to Foundry |

---

## Key Technical Details

### Foundry Instance
- **URL**: `https://dont-web-the-cleric.moltenhosting.com` (Molten Hosting, cloud)
- **Version**: Foundry V13
- **System**: dnd5e

### DDB Endpoints
- **Character JSON**: `https://www.dndbeyond.com/character/{id}/json` (`credentials: 'include'`)
- **Monster API**: `https://monster-service.dndbeyond.com/v1/monster/{id}` (returns `avatarUrl` even for locked monsters; stats must be DOM-scraped)
- **HP save hook**: `character-service.dndbeyond.com/character/v5/life/hp/damage-taken`
- Character ID from URL: `/characters/(\d+)`

### DDB → Foundry Actor Mapping (`mapDDBToFoundryActor` in background.js)

**Character actors** (`type: 'character'`):
- Abilities: `char.stats[]` (base) + `char.bonusStats[]` + `char.overrideStats[]`
- HP max: `char.overrideHitPoints ?? (baseHitPoints + bonusHitPoints + conMod × totalLevel)`
- HP current: `hpMax - removedHitPoints`
- `system.attributes.hp.override` set to force Foundry to use our HP value
- Portrait: `char.decorations.avatarUrl`
- Flags: `flags['ddb-sync'].characterId` for actor lookup/linking
- ⚠️ **Known issue**: DDB stores racial bonuses and ASIs in `char.modifiers`, not `bonusStats`. Raw `stats[]` are base-only. This causes wrong CON/HP on re-import if `ddbCharacterHP` (stored by content.js on page load) is not available.

**NPC actors** (`type: 'npc'`):
- `system.attributes.ac: { flat, calc: 'flat' }` — bypasses Foundry AC calculation
- `system.attributes.hp: { value, max }` — flat values scraped from DOM
- Flags: `flags['ddb-sync'].monsterId` for lookup

### Storage Keys (`chrome.storage.local`)
| Key | Value |
|-----|-------|
| `foundryUrl` | Base URL of Foundry instance (e.g. `https://dont-web-the-cleric.moltenhosting.com`) |
| `characterId` | DDB character ID (from URL) |
| `characterName` | Character name |
| `foundryActorId` | Linked Foundry actor UUID |
| `foundryActorName` | Linked actor name (for display) |
| `ddbCharacterData` | Full DDB character JSON (cached) |
| `ddbCharacterHP` | Pre-computed `{ current, max, temp }` from content.js — used by re-import |
| `lastSyncTime` | Timestamp of last HP sync |
| `lastSyncHP` | `{ current, max }` of last HP sync |
| `importedMonsters` | Map of `{ monsterId: true }` for "already imported" UI state |

### Button Injection (content.js)
- Target: before `.ct-character-header-desktop__group--share`
- Fallbacks: `--short-rest` group → `.ct-character-header-desktop`
- Retry: every 500ms, max 40 attempts (20s), silent
- `_buttonInjected` flag prevents re-injection loops

---

## Setup

1. **Foundry module**: Upload `ddb-sync/` folder to Molten File Manager → `Data/modules/ddb-sync/`. Enable in Foundry module manager.
2. **Chrome extension**: `chrome://extensions` → Developer mode → Load unpacked → select `ddb-foundry-sync/` folder
3. **Configure**: Open extension popup → ⚙ → enter `https://dont-web-the-cleric.moltenhosting.com` → Save
4. Open a DDB character page — "⚒ FOUNDRY SYNC" button appears in the header

---

## Debugging

### See character JSON structure
Open **DDB character tab** DevTools Console → look for `[DDB-Sync] ===== CHARACTER DATA =====`. The `📦 Full payload` group contains the raw JSON object. Expand `modifiers` to see racial bonuses, ASIs, etc.

### See re-import data flow
Open **service worker** DevTools: `chrome://extensions` → DDB Foundry Sync → Service Worker → Inspect.  
Click re-import — look for `[DDB-Sync BG] Re-import data check` lines showing exactly what data is being used.

### Reload extension
`chrome://extensions` → click ↺ on the DDB Foundry Sync card.

---

## Known Issues / Next Steps

### Active Bug
- **HP re-import gets wrong values** (`conMod=2 level=15` instead of correct values): DDB's `char.stats[]` are base-only; racial bonuses and ASIs live in `char.modifiers` (not yet processed). Current workaround: `ddbCharacterHP` stored by content.js on page load is used instead of recalculation — but this requires the DDB tab to have been loaded/refreshed before re-importing.

### Feature Gaps
- Spell slots not synced
- Conditions/death saves not synced
- Multi-character support (storage is single-character)
- One-way sync only (DDB → Foundry)
- Full `modifiers` processing for accurate ability score calculation
