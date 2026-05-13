# DDB Foundry Sync — Use Cases

## Players & Setup
- **Kev** — GM, runs his own Foundry instance
- **Steve** — GM, runs his own Foundry instance
- **Other players** — install the extension, connect to either Kev's or Steve's Foundry depending on which campaign they're in

## Proposed Storage Architecture
- `foundryUrl` (popup setting) — used only to detect which browser tab is the Foundry tab
- `flags.ddb-sync.characterId` on the Foundry actor — **source of truth** for the character↔actor link
- `actorCache.{characterId}` in chrome.storage — **performance cache only**, populated after Foundry confirms the link; used to avoid a round-trip on every HP sync
- `syncMeta.{characterId}.lastSyncTime` in chrome.storage — UI display cache

**Key rule:** chrome.storage is never consulted to determine *whether* a character is linked. Only Foundry actor flags determine that. Storage is only used to speed up HP sync once a link is confirmed on page load.

---

## Use Cases

### UC-01 · Player opens their character, Foundry is open
1. DDB sheet loads → extension queries open Foundry tab for actor with `characterId` flag
2. Actor found → `actorCache.{characterId}` written with actorId + actorName
3. Panel shows linked state
4. HP change fires → extension reads `actorCache.{characterId}` → pushes to Foundry
**Result:** ✅ Works

---

### UC-02 · Player opens a second character in another tab
1. Second DDB sheet loads → extension queries Foundry for that character's ID
2. Found or not found → cache updated for that characterId only
3. First character's cache entry is untouched
**Result:** ✅ Works — no bleed between characters

---

### UC-03 · Player is in one campaign only (hard limit enforced)
One character maps to one Foundry actor in one world. If a character has no actor in the currently open Foundry tab, it shows as unlinked. Player creates or links the actor once; the flag on the actor is the permanent record.
**Result:** ✅ Works

---

### UC-04 · Player steps in for an absent group member
Player B opens Player A's DDB character sheet (shared access or GM view).
1. Extension queries open Foundry tab for that characterId
2. Actor found (it has the flag from when it was originally created) → linked automatically
3. HP changes sync normally
**Result:** ✅ Works — link follows the actor flag, not the user

---

### UC-05 · New player, first time — no actor exists yet
1. Extension queries Foundry → no actor found with that characterId
2. Panel shows unlinked state with "Create Actor" option
3. Player clicks Create → actor created with `flags.ddb-sync.characterId` set → cache populated
**Result:** ✅ Works

---

### UC-06 · Character already has an actor but player has never linked via this extension
1. Extension queries Foundry → actor found only if it has the `characterId` flag set
2. If actor was created manually (not via this extension), flag won't be present → shows unlinked
3. Panel offers "Link to existing" → player selects actor → flag written to that actor → cache populated
**Result:** ✅ Works — flag must be present; manual actors need a one-time link step

---

### UC-07 · Multiple Foundry tabs open (e.g. both Kev's and Steve's)
1. Extension detects multiple tabs matching `foundryUrl` pattern
2. Panel shows error: lists the detected Foundry instances by world name, asks user to close all but one and refresh
3. No sync attempted until resolved
**Result:** ✅ Handled explicitly — user must resolve ambiguity

---

### UC-08 · Foundry tab not open
1. Extension queries for Foundry tab → none found
2. Panel shows greyed-out state: "Open Foundry and log in, then refresh this page"
3. If HP save fires while Foundry is closed → cache lookup finds actorId → push attempt fails gracefully → error logged, no crash
**Result:** ✅ Graceful failure

---

### UC-09 · Actor deleted from Foundry
1. Cache has stale actorId from previous session
2. On next DDB page load → extension queries Foundry → actor not found → cache entry cleared → shows unlinked
3. HP sync might fail once if HP fires before page load completes, but recovers on refresh
**Result:** ✅ Self-healing on next page load

---

### UC-10 · Same character open in two DDB tabs simultaneously
1. Both tabs fire `CHARACTER_PAGE_LOADED` → both query Foundry → both find the same actor → both write the same cache entry
2. HP change on either tab → both push the same values → idempotent, no conflict
**Result:** ✅ Harmless

---

### UC-11 · GM opens a player's character sheet to inspect it
Same as UC-04 — the extension queries Foundry for that characterId. If the actor exists and has the flag, it shows as linked. GM could theoretically push HP — this is intentional (covering for absent players).
**Result:** ✅ Works — no special handling needed

---

### UC-12 · Player switches campaigns (closes one Foundry, opens another)
1. Player closes Kev's Foundry tab, opens Steve's
2. Opens DDB character sheet → extension queries Steve's Foundry for that characterId
3. If actor exists there → linked, cache updated with new actorId
4. If not → unlinked, create/link options shown
5. Old actorId from Kev's Foundry is overwritten in cache — no stale data used
**Result:** ✅ Works — page load always queries the currently open Foundry tab

---

## Resolved Questions

**OQ-01 — Link detection is fully automatic** ✅
On DDB page load, the extension queries the open Foundry tab for an actor with a matching `characterId` flag. No picker or manual link step needed. Outcomes:
- Actor found with matching flag → linked, begin HP monitoring
- No actor found → offer Create/Import. After creation the actor gets the flag and the actorId is cached for that characterId.
This works identically no matter how many times the character is opened or by whom.

**OQ-02 — `foundryUrl` setting removed** ✅
The manifest already has `<all_urls>` host permission, so the extension can inject into any tab. Foundry is auto-detected by pinging all open tabs — whichever responds to the ddb-sync module ping IS the Foundry tab. The popup `foundryUrl` setting is removed entirely.
Risk of keeping it: if the stored URL is wrong (e.g. Kev's URL stored but Steve's Foundry is open), `chrome.tabs.query` returns nothing and the extension silently fails to find Foundry at all — even though it's right there on screen.
New tab-detection flow:
1. Query all open tabs
2. Attempt a `ping` via the ddb-sync module on each
3. Tabs that respond are Foundry instances
4. One responding → use it
5. Multiple responding → UC-07 (show error, ask user to close all but one)
6. None responding → UC-08 (greyed panel)
