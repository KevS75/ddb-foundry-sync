# Privacy Policy — DDB Foundry Sync

**Last updated: May 2026**

DDB Foundry Sync is a Chrome browser extension that syncs D&D Beyond character data to a Foundry VTT instance running in another browser tab. This policy explains what data the extension accesses, how it is used, and what it does not do.

---

## What data the extension accesses

### Character sheet content
When you open a D&D Beyond character sheet or monster page, the extension reads character data from the page — including character name, character ID, hit points, armour class, ability scores, movement speeds, and other stat block values. This data is read solely to send it to your Foundry VTT actor.

### Network requests
The extension monitors outgoing network requests made by the D&D Beyond page (for example, requests triggered when you take damage or equip armour) to detect when character values have changed and trigger a sync. The content of these requests is read locally within your browser. No requests are modified or blocked.

### Locally stored data
The extension stores a small amount of data in Chrome's local extension storage (`chrome.storage.local`):
- A mapping of D&D Beyond character IDs to Foundry actor IDs and names, used to avoid re-querying Foundry on every page load
- The timestamp of the last HP sync per character, displayed in the extension popup

This data never leaves your device except as described below.

---

## How data is used

All character data read by the extension is sent directly from your browser to your own Foundry VTT server — the instance you have open in another tab. No intermediary server is involved. The extension communicates with Foundry by injecting a script into the Foundry tab, which passes data to the companion Foundry module (`ddb-sync`) running inside your world.

Data is used exclusively to keep your Foundry VTT actors up to date with your D&D Beyond character sheet. It is not used for any other purpose.

---

## What the extension does not do

- **No third-party data sharing.** Character data is never sent to any server other than your own Foundry VTT instance.
- **No data collection by the developer.** The developer of this extension does not receive, store, or have access to any of your character data or usage information.
- **No analytics or tracking.** The extension contains no analytics libraries, telemetry, or usage tracking of any kind.
- **No advertising.** The extension does not serve advertisements and contains no advertising SDKs.
- **No sale of data.** No user data is sold, licensed, or transferred to any third party for any purpose.
- **No authentication data.** The extension does not read, store, or transmit passwords, tokens, or login credentials. It relies on your existing D&D Beyond browser session.

---

## Open source

The full source code for this extension and its companion Foundry module is publicly available on GitHub. You can review exactly what the extension does at any time.

**GitHub:** [https://github.com/KevS75/ddb-foundry-sync](https://github.com/KevS75/ddb-foundry-sync)

---

## Changes to this policy

If the extension's data practices change in a future version, this policy will be updated and the "Last updated" date above will reflect that change. Significant changes will also be noted in the release notes.

---

## Contact

If you have questions about this privacy policy or the extension's data practices, please open an issue on the GitHub repository linked above.
