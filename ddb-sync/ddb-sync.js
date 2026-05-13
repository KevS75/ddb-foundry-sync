// ============================================================
// DDB Foundry Sync — Foundry Module
// Communicates with the DDB Foundry Sync Chrome extension via
// window.postMessage. The extension injects code into this page
// and messages are passed through the shared window context.
//
// Messages IN  (from extension): source = 'ddb-sync-extension'
// Messages OUT (to extension):   source = 'ddb-sync-module'
// ============================================================

const MODULE_ID = 'ddb-sync';
const PREFIX    = '[DDB-Sync]';

Hooks.once('ready', () => {
  if (!game.user.isGM) {
    console.log(`${PREFIX} Not GM — module inactive`);
    return;
  }

  window.addEventListener('message', handleMessage);
  console.log(`${PREFIX} Ready — listening for extension messages`);
});


// ----------------------------------------------------------
// Message router
// ----------------------------------------------------------
async function handleMessage(event) {
  const msg = event.data;
  if (!msg || msg.source !== 'ddb-sync-extension') return;

  console.log(`${PREFIX} Received:`, msg.action, msg);

  try {
    switch (msg.action) {

      case 'ping':
        reply(msg.requestId, { ok: true, world: game.world.id });
        break;

      case 'findActor':
        await handleFindActor(msg);
        break;

      case 'createActor':
        await handleCreateActor(msg);
        break;

      case 'updateActor':
        await handleUpdateActor(msg);
        break;

      case 'updateHP':
        await handleUpdateHP(msg);
        break;

      case 'updateAC':
        await handleUpdateAC(msg);
        break;

      case 'unlinkActor':
        await handleUnlinkActor(msg);
        break;

      default:
        console.warn(`${PREFIX} Unknown action: ${msg.action}`);
        reply(msg.requestId, { ok: false, error: `Unknown action: ${msg.action}` });
    }
  } catch (err) {
    console.error(`${PREFIX} Error handling ${msg.action}:`, err);
    reply(msg.requestId, { ok: false, error: err.message });
  }
}

// ----------------------------------------------------------
// Handlers
// ----------------------------------------------------------

// Find an existing actor by characterId or monsterId flag
async function handleFindActor(msg) {
  const { characterId, monsterId, requestId } = msg;

  let actor = null;

  if (characterId) {
    actor = game.actors.find(a =>
      a.flags?.[MODULE_ID]?.characterId === String(characterId)
    );
  } else if (monsterId) {
    actor = game.actors.find(a =>
      a.flags?.[MODULE_ID]?.monsterId === String(monsterId)
    );
  }

  if (actor) {
    reply(requestId, { ok: true, uuid: actor.uuid, name: actor.name });
  } else {
    reply(requestId, { ok: false, reason: 'not found' });
  }
}

// Create a new actor from provided data
async function handleCreateActor(msg) {
  const { actorData, requestId } = msg;
  console.log(`${PREFIX} Creating actor: ${actorData.name}`);

  const actor = await Actor.create(actorData);
  if (!actor) {
    reply(requestId, { ok: false, error: 'Actor.create returned null' });
    return;
  }

  console.log(`${PREFIX} ✅ Actor created: ${actor.name} (${actor.uuid})`);
  reply(requestId, { ok: true, uuid: actor.uuid, name: actor.name });
}

// Update an existing actor — used for re-import / overwrite
async function handleUpdateActor(msg) {
  const { uuid, actorData, requestId } = msg;

  const actor = await fromUuid(uuid);
  if (!actor) {
    reply(requestId, { ok: false, error: `Actor not found: ${uuid}` });
    return;
  }

  // Build update payload — by the time this arrives, img is already a local
  // Foundry path (uploaded by the extension before sending this message).
  const updatePayload = {};
  if (actorData.name)           updatePayload.name           = actorData.name;
  if (actorData.img)            updatePayload.img            = actorData.img;
  if (actorData.system)         updatePayload.system         = actorData.system;
  if (actorData.flags)          updatePayload.flags          = actorData.flags;
  if (actorData.prototypeToken) updatePayload.prototypeToken = actorData.prototypeToken;

  await actor.update(updatePayload);

  // Also patch any tokens already placed on scenes — prototypeToken
  // only affects tokens dragged onto the map in future.
  const newTokenImg = actorData.prototypeToken?.texture?.src;
  if (newTokenImg && !newTokenImg.startsWith('http') && newTokenImg !== 'icons/svg/mystery-man.svg') {
    let patchedCount = 0;
    for (const scene of game.scenes) {
      const matches = scene.tokens.contents.filter(t => t.actorId === actor.id);
      for (const token of matches) {
        await token.update({ 'texture.src': newTokenImg });
        patchedCount++;
      }
    }
    if (patchedCount > 0) {
      console.log(`${PREFIX} 🖼️ Patched texture on ${patchedCount} placed token(s)`);
    }
  }

  console.log(`${PREFIX} ✅ Actor updated: ${actor.name} (${actor.uuid})`);
  reply(requestId, { ok: true, uuid: actor.uuid, name: actor.name });
}

// Update an actor's current HP only
async function handleUpdateHP(msg) {
  const { actorUuid, hp, requestId } = msg;

  const actor = await fromUuid(actorUuid);
  if (!actor) {
    reply(requestId, { ok: false, error: `Actor not found: ${actorUuid}` });
    return;
  }

  await actor.update({
    'system.attributes.hp.value':    hp.current,
    'system.attributes.hp.override': hp.max,   // locks DDB max into Foundry's "Maximum Override" field
    'system.attributes.hp.temp':     hp.temp ?? 0
  });

  console.log(`${PREFIX} ✅ HP updated: ${actor.name} → ${hp.current}/${hp.max}`);
  reply(requestId, { ok: true });
}

// Update AC as a flat value — Foundry calculation type set to 'flat'
async function handleUpdateAC(msg) {
  const { actorUuid, ac, requestId } = msg;
  const actor = await fromUuid(actorUuid);
  if (!actor) {
    reply(requestId, { ok: false, error: `Actor not found: ${actorUuid}` });
    return;
  }
  await actor.update({
    'system.attributes.ac.flat': ac,
    'system.attributes.ac.calc': 'flat'
  });
  console.log(`${PREFIX} ✅ AC updated: ${actor.name} → ${ac}`);
  reply(requestId, { ok: true });
}

// Remove the characterId flag from an actor so it no longer appears linked
async function handleUnlinkActor(msg) {
  const { uuid, requestId } = msg;
  const actor = await fromUuid(uuid);
  if (!actor) {
    reply(requestId, { ok: false, error: `Actor not found: ${uuid}` });
    return;
  }
  await actor.unsetFlag(MODULE_ID, 'characterId');
  console.log(`${PREFIX} ✅ Actor unlinked: ${actor.name}`);
  reply(requestId, { ok: true });
}

// ----------------------------------------------------------
// Reply helper
// ----------------------------------------------------------
function reply(requestId, data) {
  window.postMessage({ source: 'ddb-sync-module', requestId, ...data }, '*');
}
