// Twitch VOD Unmute — Service Worker (MV3)
// Rôle unique : réinjecter les content-scripts quand le manifest les rate
// (onglet déjà ouvert lors de l'install, navigation SPA, course document_start).
// Idempotent grâce aux gardes __TVU_BRIDGE_READY__ / __TVU_HOOKED__.
// Tout le reste (restauration, téléchargements) vit côté page/worker.

const TWITCH_RE = /^https:\/\/(.+\.)?twitch\.tv\//;

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab?.url || '';
  if (!TWITCH_RE.test(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/bridge.js']
    });
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/injected.js'],
      world: 'MAIN'
    });
  } catch {}
});
