# DDB Foundry Sync

Sync your D&D Beyond characters and monsters to Foundry VTT in real-time — no relay server, no config headaches.

A Chrome extension watches your D&D Beyond tabs and pushes HP, AC, ability scores, movement, initiative, and more directly into your Foundry actors the moment things change on your sheet. A lightweight Foundry module receives the updates and applies them via Foundry's internal API.

---

## What It Does

- **HP sync** — current, max, and temp HP update in Foundry the moment you take damage or heal on DDB
- **AC sync** — updates when you equip/unequip armour or set a manual override
- **Full character import** — creates a new Foundry actor from your DDB sheet (ability scores, saving throws, movement speeds, initiative, portrait)
- **Re-import** — overwrites an existing linked actor with fresh data from DDB
- **Monster import** — scrapes a DDB monster page and creates an NPC actor in Foundry
- **Per-character linking** — each character finds its own actor independently; multiple players can use the extension simultaneously

---

## Requirements

- Chrome (or any Chromium browser)
- Foundry VTT v11 or later (verified on v13)
- The dnd5e system in Foundry
- A D&D Beyond account with your characters

---

## Installation

### Part 1 — Foundry Module

Your GM needs to do this once.

1. In Foundry, go to **Add-on Modules → Install Module**
2. Paste this manifest URL into the bottom field:
   ```
   https://raw.githubusercontent.com/KevS75/ddb-foundry-sync/main/ddb-sync/module.json
   ```
3. Click **Install**, then **Enable** the module in your world

### Part 2 — Chrome Extension

Each player does this on their own machine.

1. Download the latest release: [**ddb-foundry-sync.zip**](https://github.com/KevS75/ddb-foundry-sync/releases/latest/download/ddb-foundry-sync.zip)
2. Unzip the file anywhere on your computer (e.g. `Documents/ddb-foundry-sync`)
3. Open Chrome and go to `chrome://extensions`
4. Toggle **Developer mode** on (top-right)
5. Click **Load unpacked** and select the unzipped `ddb-foundry-sync` folder
6. The ⚔ **DDB Foundry Sync** icon appears in your toolbar

> **Updating the extension:** Download the new release zip, replace the folder contents, then go to `chrome://extensions` and click the refresh icon on the DDB Foundry Sync card.

---

## Usage

1. Open your Foundry world in one Chrome tab
2. Open your D&D Beyond character sheet in another tab
3. The **⚒ FOUNDRY SYNC** button appears in the DDB character header
4. Click it to link your character to a Foundry actor (or create a new one)
5. From that point on, HP and AC changes sync automatically

For monsters: navigate to any DDB monster page and click the **⚔ Import to Foundry** button.

---

## Architecture

No relay server. The extension injects into your open Foundry tab using `chrome.scripting.executeScript` and communicates via `window.postMessage`. The Foundry module listens for these messages and performs actor CRUD using Foundry's internal API.

```
DDB tab (content.js)
  └── watches HP/AC changes, injects sync button
        └── background.js (service worker)
              └── injects into Foundry tab → window.postMessage
                    └── ddb-sync.js (Foundry module)
                          └── creates/updates actors
```

---

## Foundry Module

The `ddb-sync/` folder contains the Foundry module. If you prefer to install it manually (e.g. for a self-hosted Foundry instance), copy the `ddb-sync` folder into your Foundry `Data/modules/` directory and enable it in the module manager.

---

## Troubleshooting

**Sync button doesn't appear on DDB**
- Reload the DDB character page
- Check that the extension is enabled at `chrome://extensions`

**"No Foundry tab found" error**
- Make sure your Foundry world is open in a Chrome tab (not just the setup screen)
- If you have multiple Foundry tabs open, close all but one

**HP not updating in Foundry**
- Check the service worker console: `chrome://extensions` → DDB Foundry Sync → Service Worker → Inspect
- Make sure the Foundry module is enabled in your world

---

## Project Status

Active development. Current version: **0.2.0**

See [BUGS-AND-TODO.md](ddb-foundry-sync/BUGS-AND-TODO.md) for known issues and upcoming features.
