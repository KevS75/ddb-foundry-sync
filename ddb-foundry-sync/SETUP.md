# DDB Foundry Sync — Setup & Testing Guide

## Loading the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** on (top-right corner)
3. Click **Load unpacked**
4. Navigate to this folder (`ddb-foundry-sync`) and select it
5. The extension appears in your toolbar as ⚔️ **DDB Foundry Sync**

To reload after making code changes: hit the refresh icon on the extension card at `chrome://extensions`, then reload the DDB tab.

---

## What to Look At (Phase 1 — Data Exploration)

### Console on the DDB character tab
Open DevTools (`F12`) on a DDB character sheet page. In the **Console** tab you'll see:

- `[DDB-Sync] Character ID: 12345678` — confirms the content script loaded
- A full structured breakdown of your character data grouped by category:
  - Identity (name, race, class, level)
  - ❤️ Hit Points (base, removed, temp, current calculated)
  - 🎲 Ability scores
  - ✨ Spell slots
  - 💀 Death saves
  - 🤕 Conditions
  - 💰 Currency
  - 🎒 Inventory
  - 📦 Full raw payload (expand this to explore everything)
- `[DDB-Sync] MutationObserver watching for HP changes` — the DOM watcher is running

When you **change HP** on the character sheet, watch for:
```
[DDB-Sync] 🔴 HP DOM change detected: { ... }
```

### Console on the background service worker
Go to `chrome://extensions` → click **"Inspect views: service worker"** under the DDB Foundry Sync card.

This console shows all network traffic to DDB's API:
```
[DDB-Sync BG] 🔍 API request: PATCH https://character.dndbeyond.com/...
[DDB-Sync BG] ⚡ Looks like a character save — notifying content script
```

Change your HP on the DDB sheet and watch what URL fires. That's the endpoint we'll hook into.

---

## What We're Looking For

After running this for the first time, we want to confirm:

1. ✅ The character JSON endpoint returns data (the structured log appears)
2. ✅ The HP field path in the JSON (should be `removedHitPoints`)
3. ✅ Which API endpoint fires when HP is edited (PATCH to what URL?)
4. ✅ The MutationObserver catches the DOM update
5. ✅ The background script sees the network save event

Once we have this picture, Phase 2 is wiring the trigger → Foundry push.

---

## Folder Structure

```
ddb-foundry-sync/
  manifest.json   — Extension config and permissions
  content.js      — Runs on DDB character pages, fetches + logs data
  background.js   — Service worker, watches network requests
  popup.html      — Extension toolbar popup UI
  popup.js        — Popup logic
  SETUP.md        — This file
```
