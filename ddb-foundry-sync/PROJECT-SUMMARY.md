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
popup.html / popup.js — Extension popup; link status, re-import, actor management
```

### Part 2 — Foundry Module (`ddb-sync/`)
```
module.json          — Foundry module manifest (id: ddb-sync, verified: v13)
ddb-sync.js          — Listens for window.postMessage from extension; handles all CRUD
```
Module is distributed via GitHub manifest URL — players install directly from Foundry's module manager.

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
| `actorCache` | `{ [characterId]: { actorId, actorName } }` — per-character actor link cache, written only after Foundry confirms |
| `syncMeta` | `{ [characterId]: { lastSyncTime } }` — per-character UI metadata |
| `characterId` | DDB character ID (from URL) |
| `characterName` | Character name |
| `ddbCharacterData` | Full DDB character JSON (cached) |
| `importedMonsters` | Map of `{ monsterId: true }` for "already imported" UI state |

**Removed keys** (no longer used): `foundryUrl`, `foundryActorId`, `foundryActorName`, `lastSyncHP`, `ddbCharacterHP`

### Button Injection (content.js)
- Target: before `.ct-character-header-desktop__group--share`
- Fallbacks: `--short-rest` group → `.ct-character-header-desktop`
- Retry: every 500ms, max 40 attempts (20s), silent
- `_buttonInjected` flag prevents re-injection loops

---

## Setup

### Foundry Module (GM — once per world)
1. Foundry → **Add-on Modules → Install Module**
2. Paste manifest URL: `https://raw.githubusercontent.com/KevS75/ddb-foundry-sync/main/ddb-sync/module.json`
3. Click **Install**, then enable the module in your world

### Chrome Extension (each player)
1. Download `ddb-foundry-sync.zip` from the [latest release](https://github.com/KevS75/ddb-foundry-sync/releases/latest)
2. Unzip anywhere on your machine
3. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped folder
4. Open a DDB character page — "⚒ FOUNDRY SYNC" appears in the character header

No URL configuration needed — the extension auto-detects the open Foundry tab.

---

## Distribution

- **Repository**: https://github.com/KevS75/ddb-foundry-sync
- **Manifest URL** (Foundry install): `https://raw.githubusercontent.com/KevS75/ddb-foundry-sync/main/ddb-sync/module.json`
- **Releases**: https://github.com/KevS75/ddb-foundry-sync/releases

### Releasing a new version
1. Bump `version` in both `ddb-sync/module.json` and `ddb-foundry-sync/manifest.json`
2. Commit: `git commit -am "v0.x.x — description"`
3. Tag and push: `git tag v0.x.x && git push && git push --tags`

GitHub Actions automatically builds `ddb-sync.zip` (Foundry module) and `ddb-foundry-sync.zip` (Chrome extension) and attaches them to the release. Foundry will detect the new version via the manifest URL and prompt players to update.

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

See [BUGS-AND-TODO.md](BUGS-AND-TODO.md) for the full tracker. Summary:

### Active Bugs
- **BUG-004** (Open): JS error in `content.js` console.group logging block at lines 531/573. Low priority — logging only, core sync unaffected.

### Feature Gaps
- Skills / skill proficiencies not yet synced (next up)
- Spell slots not synced
- Conditions/death saves not synced
- Multi-character support (storage is single-character)
- One-way sync only (DDB → Foundry)
- Full `modifiers` processing for accurate ability score calculation (workaround: DOM values used instead)
- TODO-001 (Parked): Granular sync toggles (e.g. skip token on re-import) — likely in Foundry module settings
