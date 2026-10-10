// Twitch VOD Unmute — Bridge (monde ISOLÉ)
// Relais entre le script MAIN (injected.js, sans accès chrome.*) et les API
// d'extension (storage). Protocole page <-> bridge via CustomEvent sur window.

(() => {
  if (window.__TVU_BRIDGE_READY__) return;
  window.__TVU_BRIDGE_READY__ = true;

  const CFG = 'TVU_CONFIG';
  const STATS = 'TVU_STATS';

  // Pousse la config + l'URL du patch worker vers le monde MAIN.
  async function pushConfig() {
    try {
      const { enabled = true, debug = false } = await chrome.storage.sync.get([
        'enabled',
        'debug'
      ]);
      const workerPatchUrl = chrome.runtime.getURL('src/worker-patch.js');
      // Partagé aussi via localStorage (lu SYNCHRONEMENT par le monde MAIN,
      // avant même l'arrivée de l'événement — le worker IVS est créé tôt).
      try { localStorage.setItem('tvu_patch_url', workerPatchUrl); } catch {}
      window.dispatchEvent(
        new CustomEvent(CFG, { detail: { enabled, debug, workerPatchUrl } })
      );
    } catch {
      window.dispatchEvent(new CustomEvent(CFG, { detail: { enabled: true } }));
    }
  }

  pushConfig();

  // Heartbeat : prouve que le bridge (monde isolé) tourne.
  try {
    window.dispatchEvent(new CustomEvent('TVU_BRIDGE_ALIVE', { detail: { build: 1 } }));
    setInterval(function () {
      try { window.dispatchEvent(new CustomEvent('TVU_BRIDGE_ALIVE', { detail: { build: 1 } })); } catch (e) {}
    }, 5000);
  } catch (e) {}

  // NOTE : pas d'injection <script src="chrome-extension://..."> ici —
  // la CSP de Twitch (script-src) la bloque ("Refused to load the script") et
  // ça pollue la console. L'injection monde MAIN passe par le content_script
  // manifest (exempté CSP) + la réinjection via chrome.scripting (background),
  // toutes deux idempotentes (gardes __TVU_BRIDGE_READY__ / __TVU_HOOKED__).

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled || changes.debug) pushConfig();
  });

  // Interrupteur du panneau natif (dropdown dans la page).
  window.addEventListener('TVU_UI_SET', (ev) => {
    const en = ev.detail && ev.detail.enabled;
    chrome.storage.sync.set({ enabled: !!en }).catch(() => {});
  });

  // Stats : page -> storage (persistance + diagnostic).
  window.addEventListener(STATS, (ev) => {
    const s = ev.detail;
    if (!s) return;
    chrome.storage.local.set({ tvu_stats: { ...s, updatedAt: Date.now() } }).catch(() => {});
  });

  // Timeline : carte des plages par VOD (persistance + diagnostic).
  window.addEventListener('TVU_TIMELINE', (ev) => {
    const m = ev.detail;
    if (!m || !m.vodId) return;
    const o = {};
    o['tvu_map_' + m.vodId] = { ...m, updatedAt: Date.now() };
    chrome.storage.local.set(o).catch(() => {});
  });
})();
