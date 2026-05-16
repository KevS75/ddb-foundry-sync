# Changelog — DDB Foundry Sync

All notable changes to this project will be documented here.
Format: `MAJOR.MINOR.PATCH` — see [PROJECT-SUMMARY.md](PROJECT-SUMMARY.md) for versioning rules.

---

## [0.3.1] — 2026-05-16

### Monster Importer — Full Stats & Rich Descriptions
- **Portrait upload**: monster portrait is now fetched and uploaded to Foundry's `ddb-portraits/` folder (same flow as character import); NPC sheet `img` and token texture both reference the local file
- **Full stat import**: ability scores (STR–CHA), saving throw proficiencies, speed (walk/fly/swim/climb/burrow/hover), senses (darkvision etc.), damage immunities/resistances/vulnerabilities, condition immunities, creature type/subtype/size, CR, alignment — all mapped to the dnd5e NPC system schema
- **Rich biography**: all traits, actions, bonus actions, reactions, and legendary actions are written as formatted HTML in the NPC biography tab; damage dice are converted to clickable Foundry inline rolls (e.g. `21 ([[/roll 6d6]])`), avoiding the need to create individual Item entries
- Token size is now set automatically from creature size (Tiny=0.5, Large=2, Huge=3, Gargantuan=4)
- NPCs default to hostile disposition (−1) on placed tokens
- Fixed ability score selector (`ability-block__score`) after live DOM inspection confirmed the correct class name
- Fixed character caching

---

## [0.2.0] — 2026-05-02 — Initial Release

### Chrome Extension
- Content script on DDB character pages — injects **⚒ FOUNDRY SYNC** button into character header
- Content script on DDB monster pages — injects **⚔ Import to Foundry** button, scrapes AC + HP from stat block DOM
- Background service worker — auto-detects open Foundry tab via ping (no URL config needed)
- Full character actor creation and re-import: ability scores, HP, AC, saving throw proficiencies, initiative, movement, portrait upload
- Live HP sync — watches `character-service.dndbeyond.com` HP endpoint; pushes to Foundry on every save
- Live AC sync — watches inventory equip/unequip and custom value endpoints
- Monster import — creates or overwrites NPC actor with name, AC, HP, avatar URL, and `monsterId` flag
- Extension popup — shows link state, last sync time, re-import and unlink controls

### Foundry Module (`ddb-sync`)
- Lightweight module (GM-only) — listens for `window.postMessage` from extension
- Handles: `ping`, `findActor`, `createActor`, `updateActor`, `updateHP`, `updateAC`, `unlinkActor`
- Portrait upload via `FilePicker.upload` into `ddb-portraits/` folder
- Placed token texture patching on actor update
- Distributed via GitHub manifest URL — installable directly from Foundry module manager

### Bug Fixes (resolved before release)
- **BUG-001** Actor link bleeding across characters — link now stored as Foundry actor flag, not chrome.storage
- **BUG-002** Max HP wrong on live sync + written to wrong Foundry field (`.max` vs `.override`)
- **BUG-003** Confirmed temp HP gain fires the HP endpoint — no extra handling needed
