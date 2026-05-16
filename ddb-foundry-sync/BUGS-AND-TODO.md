# DDB Foundry Sync — Bugs & Outstanding Work

---

## 🐛 Bugs

### BUG-001 · Actor link bleeds across characters
**Status:** ✅ Fixed

---

#### Requirements

**R1 — Source of truth is the Foundry actor**
The link between a DDB character and a Foundry actor must be stored as a flag on the Foundry actor itself (`flags.ddb-sync.characterId`), not in `chrome.storage.local`. Chrome storage must not be the authority on whether a character is linked.

**R2 — Link detection is live, not cached**
When a DDB character sheet loads, the extension queries the open Foundry tab: "does any actor in this world have `flags.ddb-sync.characterId` matching this DDB character ID?" If yes → show as linked. If no → show as unlinked with option to link or create.

**R3 — One character, one world (hard limit)**
A DDB character maps to exactly one Foundry actor in one world. This is an accepted constraint — no multi-world sync.

**R4 — Sync target is the open Foundry tab**
The extension syncs to whichever Foundry instance is running in the browser, regardless of who owns that instance. A player stepping in for an absent group member works naturally — if Foundry is open and the actor is there, it syncs.

**R5 — Unlinked characters show a link option**
If no actor is found with the matching `characterId` flag, the panel offers two options: "Create actor" (new) or "Link to existing" (manually select an actor already in Foundry).

**R6 — Multiple characters work independently**
Opening character A and character B in separate DDB tabs produces independent link states — each queries Foundry for its own `characterId`. No bleed between characters.

---

#### Decisions

**Q1 — Multiple Foundry tabs → RESOLVED**
Detect all open Foundry tabs. If more than one is found, show an error in the panel listing the instances detected and ask the user to close all but one, then refresh. Do not guess — require the user to resolve the ambiguity explicitly.

**Q2 — Link detection → RESOLVED**
When a DDB character sheet opens, the extension automatically queries the open Foundry tab for an actor whose `flags.ddb-sync.characterId` matches the current DDB character ID. No manual link step needed if the actor already exists — it's found automatically. Because the link lives in the Foundry actor flag (not chrome.storage), it works across every browser and every player without any per-user setup.

**Q3 — Chrome storage → RESOLVED**
Cache sync metadata per character: `syncMeta.{characterId}.lastSyncTime`. HP values do not need to be shown in the extension panel — the user is looking at them directly in DDB. Strip HP from the panel display.

**Q4 — Foundry not open → RESOLVED**
Grey out all panel options. Show message: "Open Foundry and log in, then refresh this page."

#### Storage Model (finalised)
```
chrome.storage.local:
  actorCache: {
    "[characterId]": { actorId, actorName }   // written only after Foundry confirms
  }
  syncMeta: {
    "[characterId]": { lastSyncTime }          // UI display only
  }
  // foundryUrl REMOVED entirely
```

#### Tab Detection (replacing foundryUrl)
Auto-detect Foundry by pinging all open tabs via the ddb-sync module. No URL configuration needed. Manifest already has `<all_urls>` so injection into any tab is permitted.

**Files affected:** `background.js`, `content.js`, `ddb-sync.js`, `popup.html`, `popup.js`

---

### BUG-002 · Max HP wrong on live HP sync + writes to wrong Foundry field
**Status:** ✅ Fixed  
**Symptom:** HP sync was sending the wrong max HP to Foundry (e.g. 121 instead of 181) AND writing it to `.max` instead of `.override`.  
**Root cause (wrong value):** `extractHP()` in `content.js` used only `char.stats[2].value` (raw base CON), ignoring racial/ASI bonuses in `char.bonusStats[]` and `char.overrideStats[]`. Fix: `extractHP()` now mirrors the `bonusStats`/`overrideStats` logic already used in `mapDDBToFoundryActor`.  
**Root cause (wrong field):** `handleUpdateHP` in `ddb-sync.js` set `.max` (Foundry's derived value, can be recalculated) instead of `.override` (the "Maximum Override" field that locks the value in).  
**Files:** `ddb-foundry-sync/content.js`, `ddb-sync/ddb-sync.js`

---

### BUG-003 · Gaining new temp HP doesn't trigger HP sync
**Status:** ✅ Closed — not a bug  
**Finding:** Confirmed that adding temp HP in DDB also fires the `damage-taken` endpoint. The existing watcher catches it, and `extractHP()` reads `temporaryHitPoints` from the character JSON and passes it through to `system.attributes.hp.temp` in Foundry. Full coverage with no extra work needed.

---

---

### BUG-007 · Players cannot move their tokens in combat after character import
**Status:** Open  
**Reported by:** Paul and Kev  
**Symptom:** After importing their characters via the extension, Paul and Kev can see their tokens on the map but cannot move them during combat. Other import functionality works fine.  
**Suspected causes (to investigate):**
- Actor ownership not set — imported actors may be created with GM-only ownership, leaving player users with no Owner permission on their own actor. Foundry requires "Owner" level permission on an actor for the player to control its token.
- Token disposition or `actorLink` flag — if the token is not linked to the actor, or is set up as a wildcard token, permission inheritance may break.
- `createActor` in `ddb-sync.js` may not be setting `ownership` correctly — check whether the player's Foundry user ID is being passed and applied during actor creation.  
**Fix direction:** When creating (or re-importing) an actor, the import flow should set `ownership: { [foundryUserId]: 3 }` (3 = Owner) for the player who owns that character. May need to pass the player's Foundry user ID as part of the import payload, or have the Foundry module look up the current user and assign ownership automatically.  
**Files to check:** `ddb-sync/ddb-sync.js` (`createActor` / `updateActor` handlers), `ddb-foundry-sync/background.js` (import payload construction)

---

### BUG-006 · "No character data available" error when player tries to link character
**Status:** Likely fixed by TODO-006 (v0.4.0) — needs confirmation from Pezz  
**Reported by:** Pezz (Toledo Jailbreaker)  
**Symptom:** When Pezz opened the extension popup on his DDB character sheet and attempted to link his character to Foundry, he got an error saying "no character data available" — even though the character sheet was fully loaded and it was definitely his character.  
**Suspected causes (to investigate):**
- `ddbCharacterData` not yet populated in `content.js` by the time the popup queries it — could be a race condition where the popup opens before the page's character data is fetched/parsed
- The character page URL didn't match the expected DDB character URL pattern, so `content.js` didn't inject or run
- `characterId` was missing or undefined when the popup tried to initiate the link flow  
**Reproduction:** Have Pezz open his DDB sheet, click the extension, try to link — note exact timing and whether the page was freshly loaded vs navigated to.  
**Files to check:** `ddb-foundry-sync/content.js` (character data fetch + message handler), `ddb-foundry-sync/popup.js` (link flow initiation)

---

### BUG-004 · JS error in content.js around character data logging
**Status:** Open  
**Symptom:** Stack trace error thrown at content.js:531 and content.js:573, both anonymous functions inside the main async IIFE. Error appears in the character data `console.group` logging block after `fetchCharacterData`.  
**Impact:** Low — logging only, core sync functionality unaffected.  
**Fix needed:** Investigate and clean up the console.group block in the main IIFE. Likely an unclosed group or an error thrown inside the logging chain.  
**Files:** `ddb-foundry-sync/content.js`

---

## 📋 To-Do / Enhancements

### TODO-006 · Fetch character JSON on demand at click time instead of caching on page load
**Status:** ✅ Done — v0.4.0  
**Resolution:** Service-worker `fetch` with `credentials: 'include'` confirmed (May 2026 console test) to send DDB session cookies and return the full character JSON (~286 KB, flat shape — no `.data` wrapper). `fetchFreshCharacterData` rewritten to fetch directly without tab injection. `CREATE_FOUNDRY_ACTOR` and `REIMPORT_CHARACTER` now fetch fresh at click time and no longer read `ddbCharacterData` from `chrome.storage.local`.  
**Likely also fixed:** BUG-006 (Pezz "no character data available" — race condition on page load is no longer reachable for the import flow). Needs confirmation in play.  
**Follow-up cleanup (separate pass):** `content.js` still writes `ddbCharacterData` to storage on page load — now dead weight for imports, can be pruned once Branch A is proven in real play.  
**Files changed:** `ddb-foundry-sync/background.js` (`fetchFreshCharacterData`, `CREATE_FOUNDRY_ACTOR`, `REIMPORT_CHARACTER`), `ddb-foundry-sync/manifest.json` (0.3.0 → 0.4.0)

---

### TODO-002 · Monster importer — portrait download & local upload
**Status:** ✅ Done — v0.3.0  
**Description:** Monster import currently passes the raw DDB avatar URL to Foundry and leaves it as an external link. It should mirror the character import flow: fetch the portrait as a data URL in the background worker, upload it to Foundry via `FilePicker.upload` into `ddb-portraits/`, and store the resulting local path on both `img` and `prototypeToken.texture.src`.  
**Files:** `ddb-foundry-sync/background.js` (`buildMonsterActor` + `IMPORT_MONSTER` handler), `ddb-sync/ddb-sync.js`

---

### TODO-003 · Monster importer — full stat import (AC, HP, ability scores, saves)
**Status:** ✅ Done — v0.3.0  
**Description:** The current scraper only reads AC and HP from the DOM stat block. Extend `scrapeStatBlock()` in `content-monster.js` to also capture: the six ability scores, saving throw proficiencies, speed, CR, size, type, alignment, skills, damage immunities/resistances/vulnerabilities, condition immunities, senses, and languages. Pass all of these through the `IMPORT_MONSTER` message and map them into the full dnd5e NPC `system` schema in `buildMonsterActor`.  
**Files:** `ddb-foundry-sync/content-monster.js`, `ddb-foundry-sync/background.js`

---

### TODO-004 · Monster importer — rich text ability descriptions with clickable rolls
**Status:** ✅ Done — v0.3.0  
**Description:** Explore writing all monster traits, actions, reactions, legendary actions, and spells as formatted HTML in the NPC's biography/description field rather than creating individual Item entries. Each ability should render as a named block with its full descriptive text. Damage rolls and attack rolls should use Foundry inline roll syntax (e.g. `[[/roll 2d6+4]]` or `[[/damage 2d6+4 fire]]`) so they are clickable in the Foundry sheet. Goal: a fully readable, playable monster sheet without requiring Item creation, which is complex to map reliably from DDB data.  
**Notes:** Assess whether Foundry's NPC biography field renders inline rolls at all — may need to write to a dedicated notes journal or use a different field. Also consider whether this approach conflicts with any future Item-based import.  
**Files:** `ddb-foundry-sync/content-monster.js`, `ddb-foundry-sync/background.js`, `ddb-sync/ddb-sync.js`

---

### TODO-005 · Monster importer — spell names as DDB links in biography
**Status:** Parked — needs design decision  
**Description:** When a monster biography lists spells by name (e.g. in innate spellcasting traits or spell lists), explore making those spell names clickable links back to their DDB spell page (`https://www.dndbeyond.com/spells/<slug>`). Would require mapping spell names to DDB slugs, either by scraping the monster page's spell links or maintaining a lookup table. Value is marginal if the GM has DDB open anyway — parking until there's a clear use case.  
**Notes:** An alternative approach would be to link spells to their Foundry compendium entry if the GM has the right compendium installed — likely more useful at the table.

---

### TODO-001 · Granular sync settings
**Status:** Parked  
**Description:** Introduce per-feature toggles so users can control exactly what gets synced. Examples: skip token image on re-import, disable AC sync, disable HP sync, etc.  
**Likely home:** Foundry module settings (Game Settings → Module Settings → DDB Sync) so they persist per-world and are GM-controlled.  
**Notes:** Design should consider which settings are per-world (Foundry side) vs per-user (extension popup side).
