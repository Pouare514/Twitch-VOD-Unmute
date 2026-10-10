/* Twitch VOD Unmute — Hook réseau (monde MAIN)
 *
 *  - Le variant unmuted "index-xxx.m3u8" N'EXISTE PAS (403 prouvé). Seule la
 *    playlist "index-muted-xxx.m3u8" existe. Donc : ne JAMAIS réécrire les URLs
 *    en ".m3u8" (master + variants). On ne touche que les segments ".ts".
 *  - Patch SYNCHRONE non-bloquant (optimiste) : aucun HEAD avant réinjection,
 *    réponse immédiate.
 *  - Le filet de sécurité est le fallback ".ts" : si "517.ts" 403/404 (purgé),
 *    on rejoue "517-muted.ts" à la volée. Donc l'optimisme ne casse jamais le player.
 */

(() => {
  if (window.__TVU_HOOKED__) return;
  window.__TVU_HOOKED__ = true;

  const state = {
    enabled: true,
    debug: false,
    playlists: 0,
    restored: 0,
    fallbacks: 0,
    lastUrl: '',
    seenM3u8: 0, // compteurs diagnostic v1.3 : le hook voit-il le trafic ?
    seenTs: 0,
    workers: {} // v1.4 : snapshots cumulés reçus des workers IVS hookés
  };

  // URL du patch worker (posée par le bridge en localStorage + event).
  var workerPatchUrl = null;
  try { workerPatchUrl = localStorage.getItem('tvu_patch_url') || null; } catch (e) {}

  // Exposé en lecture directe monde MAIN (diagnostic console).
  // Fusionne les compteurs MAIN + workers (le HLS passe par le worker IVS).
  function emitStats() {
    var p = state.playlists, r = state.restored, f = state.fallbacks,
        sm = state.seenM3u8, st = state.seenTs, lu = state.lastUrl;
    for (var k in state.workers) {
      var w = state.workers[k] || {};
      p += w.playlists || 0; r += w.restored || 0; f += w.fallbacks || 0;
      sm += w.seenM3u8 || 0; st += w.seenTs || 0;
      if (w.lastUrl) lu = w.lastUrl;
    }
    const s = {
      playlists: p, restored: r, fallbacks: f, lastUrl: lu,
      seenM3u8: sm, seenTs: st
    };
    window.__TVU_STATS__ = s;
    window.dispatchEvent(new CustomEvent('TVU_STATS', { detail: s }));
  }
  emitStats();

  // Canal stats workers → MAIN (BroadcastChannel, même origine).
  try {
    var tvuBC = new BroadcastChannel('tvu-w');
    tvuBC.onmessage = function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== 'TVU_WSTATS' || !d.id || !d.stats) return;
      state.workers[d.id] = d.stats;
      try { state.wSeen = Math.max(state.wSeen || 0, d.stats.seenM3u8 || 0); } catch (e) {}
      mergeTimeline(d);
      emitStats();
    };
  } catch (e) {}

  // ---------- Timeline VOD (v1.5) ----------
  // Carte des plages mutées/récupérées, persistée par VOD, affichée en HUD.
  state.timeline = { vodId: null, duration: 0, groups: [], failed: {}, bases: [], bestBase: null };
  var lastPersist = 0;

  function tvuVodId() {
    try {
      var m = /\/videos\/(\d+)/.exec(location.pathname);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function mergeTimeline(d) {
    var T = state.timeline;
    var vid = tvuVodId();
    if (!vid) return;
    if (T.vodId !== vid) {
      state.timeline = T = { vodId: vid, duration: 0, groups: [], failed: {}, bases: [], bestBase: null };
    }
    var changed = false;
    if (d.total && d.total > T.duration) { T.duration = d.total; changed = true; }
    if (d.base && T.bases.indexOf(d.base) === -1) {
      T.bases.push(d.base);
      changed = true;
      if (!T.bestBase || d.base.indexOf('/chunked/') !== -1) T.bestBase = d.base;
    }
    if (d.ranges && d.ranges.length && !T.groups.length) { T.groups = d.ranges; changed = true; }
    if (d.failed) {
      for (var k in d.failed) {
        if (!T.failed[k]) { T.failed[k] = 1; changed = true; }
      }
    }
    renderHud();
    var now = Date.now();
    // Exposé en lecture directe, temps réel (diagnostic console).
    try { window.__TVU_TIMELINE__ = T; } catch (e) {}
    if (changed) tvuPanelDirty = true;
    if (changed && now - lastPersist > 5000) {
      lastPersist = now;
      persistTimeline();
    }
  }

  function persistTimeline() {
    var T = state.timeline;
    if (!T.vodId || !T.groups.length) return;
    window.dispatchEvent(new CustomEvent('TVU_TIMELINE', { detail: T }));
  }

  function fmtT(s) {
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var mm = (h > 0 ? String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
    return h > 0 ? h + ':' + mm : mm;
  }

  function pickVideo() {
    var best = null, ba = 0;
    try {
      var vs = document.querySelectorAll('video');
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        var a = (v.clientWidth || 0) * (v.clientHeight || 0);
        if (v.readyState > 0 && a >= ba) { ba = a; best = v; }
      }
    } catch (e) {}
    return best;
  }

  // ---------- Intégration lecteur (v1.6) ----------
  // Marqueurs DIRECTEMENT sur la seekbar native Twitch (calque display-only,
  // pointer-events:none → scrub/hover/tooltip natifs intacts) + pastille dans
  // la barre de contrôles (clic = saut au prochain passage muté).
  // Aucun sélecteur figé : candidats multiples + MutationObserver, donc
  // résilient aux re-renders React, théâtre/plein écran et à toutes les VODs.
  var tvuLayer = null;
  var tvuPlayerRoot = null;
  var tvuObs = null;
  var tvuScanTimer = null;
  var tvuLastPath = '';
  var tvuRemountT = null;

  function tvuIsVodPage() {
    try { return /\/videos\/\d+/.test(location.pathname); } catch (e) { return false; }
  }

  function tvuFindPlayer() {
    try {
      var v = pickVideo();
      if (v) {
        var el = v;
        for (var i = 0; i < 8 && el; i++) {
          if (el.querySelector && (el.querySelector('[data-a-target="player-seekbar-current-time"]') ||
              el.querySelector('[data-a-target="player-seekbar"]') ||
              el.querySelector('[data-a-target="player-controls"]'))) return el;
          el = el.parentElement;
        }
      }
      var cands = ['.video-player__container', '[data-a-target="video-player"]',
        '.video-player', '[data-a-target="player-controls"]'];
      for (var j = 0; j < cands.length; j++) {
        var n = document.querySelector(cands[j]);
        if (n) return n;
      }
    } catch (e) {}
    return null;
  }

  // Retourne l'élément hôte de la barre de progression (pleine largeur).
  function tvuFindSeekHost(root) {
    if (!root) return null;
    try {
      var direct = ['[data-a-target="player-seekbar"]', '[role="slider"]',
        '.seekbar', '.player-seekbar'];
      for (var i = 0; i < direct.length; i++) {
        var n = root.querySelector(direct[i]);
        if (n) return n;
      }
      if (root.matches) {
        for (var m = 0; m < direct.length; m++) {
          if (root.matches(direct[m])) return root;
        }
      }
      // time actuel → la rangée parente (slider + durées)
      var cur = root.querySelector('[data-a-target="player-seekbar-current-time"]');
      if (cur && cur.parentElement) return cur.parentElement;
      // repli générique : div large et fine dans le player
      var vw = 0;
      try { vw = root.getBoundingClientRect().width; } catch (e) {}
      if (vw > 0) {
        var all = root.querySelectorAll('div');
        for (var j = 0; j < all.length; j++) {
          var r;
          try { r = all[j].getBoundingClientRect(); } catch (e) { continue; }
          if (r.width > vw * 0.5 && r.height >= 2 && r.height <= 26) return all[j];
        }
      }
    } catch (e) {}
    return null;
  }

  function tvuEnsureRelative(host) {
    try {
      if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative';
    } catch (e) {}
  }

  function tvuMountLayer() {
    try {
      if (tvuLayer && document.contains(tvuLayer)) return true;
      tvuLayer = null;
      if (!tvuPlayerRoot || !document.contains(tvuPlayerRoot)) return false;
      var host = tvuFindSeekHost(tvuPlayerRoot);
      if (!host) return false;
      tvuEnsureRelative(host);
      tvuLayer = document.createElement('div');
      tvuLayer.setAttribute('data-tvu', 'seekbar-layer');
      tvuLayer.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:4px;' +
        'pointer-events:none;z-index:5;overflow:hidden;';
      host.appendChild(tvuLayer);
      return true;
    } catch (e) { return false; }
  }


  function tvuPaint() {
    if (!tvuLayer || !document.contains(tvuLayer)) return;
    var T = state.timeline;
    while (tvuLayer.firstChild) tvuLayer.removeChild(tvuLayer.firstChild);
    if (!T.vodId || !T.groups.length || !T.duration) return;
    for (var g = 0; g < T.groups.length; g++) {
      var gr = T.groups[g];
      var n = Math.max(1, gr.b - gr.a + 1);
      var w = (gr.e - gr.s) / n;
      for (var i = gr.a; i <= gr.b; i++) {
        var ok = !T.failed[i];
        var sp = document.createElement('div');
        sp.style.cssText = 'position:absolute;top:0;bottom:0;' +
          'background:' + (ok ? '#00e676' : '#eb0400') + ';' +
          'left:' + ((gr.s + (i - gr.a) * w) / T.duration * 100).toFixed(3) + '%;' +
          'width:' + Math.max(0.25, (w / T.duration * 100)).toFixed(3) + '%;';
        tvuLayer.appendChild(sp);
      }
    }
  }

  function tvuCounts() {
    var T = state.timeline, tot = 0, rec = 0;
    for (var g = 0; g < T.groups.length; g++) {
      for (var i = T.groups[g].a; i <= T.groups[g].b; i++) {
        tot++;
        if (!T.failed[i]) rec++;
      }
    }
    return { tot: tot, rec: rec };
  }


  // ---------- Bouton Share + dropdown (v1.8) ----------
  // Un bouton pilule natif à côté de Share (icône + compteurs) ouvre le panneau en
  // dropdown positionné vers le haut (jamais dans le flux vidéo). Style via CSS vars Twitch.
  var tvuPanel = null; // le dropdown (réutilise le nom pour tvuUnmount/scan)
  var tvuPanelVod = null;
  var tvuPanelDirty = true;
  var tvuShareBtn = null;
  var tvuDropRows = null;
  var tvuDropFoot = null;
  var tvuDropSwitch = null;
  var tvuDropTitle = null;
  var tvuDropBarFill = null;
  var tvuOutsideHooked = false;

  function tvuEnsureStyle() {
    try {
      if (document.getElementById('tvu-style') || !document.head) return;
      var st = document.createElement('style');
      st.id = 'tvu-style';
      st.textContent =
        '[data-tvu="panel"] button[data-tvu-btn]:hover{filter:brightness(1.15);}' +
        '[data-tvu="panel"] [data-tvu-chev]{transition:transform .15s;}' +
        '[data-tvu="panel"].tvu-closed [data-tvu-chev]{transform:rotate(-90deg);}' +
        '[data-tvu="panel"].tvu-closed [data-tvu-body]{display:none;}' +
        '[data-tvu="share-btn"]:hover{filter:brightness(1.25);}' +
        '[data-tvu="panel"] button[data-tvu-x]:hover{opacity:1;}';
      document.head.appendChild(st);
    } catch (e) {}
  }

  function tvuFindShare() {
    try {
      var s = document.querySelector('[data-a-target="share-button"]');
      if (s) return s;
      var scoped = document.querySelectorAll('main button');
      for (var i = 0; i < scoped.length; i++) {
        var tx = (scoped[i].textContent || '').trim().toLowerCase();
        if ((tx === 'share' || tx === 'partager') &&
            (!tvuPlayerRoot || !tvuPlayerRoot.contains(scoped[i]))) return scoped[i];
      }
      var allb = document.querySelectorAll('button');
      for (var j = 0; j < allb.length && j < 500; j++) {
        var t2 = (allb[j].textContent || '').trim().toLowerCase();
        if ((t2 === 'share' || t2 === 'partager') &&
            (!tvuPlayerRoot || !tvuPlayerRoot.contains(allb[j]))) return allb[j];
      }
    } catch (e) {}
    return null;
  }

  // Icône haut-parleur façon Twitch (SVG, pas d'emoji → rendu natif).
  var TVU_SPK = '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
    '<path d="M3 8v4h3l4 4V4L6 8H3z"/><path d="M13.5 6.5a5 5 0 0 1 0 7" stroke="currentColor" ' +
    'stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

  function tvuPaintShareBtn() {
    if (!tvuShareBtn || !document.contains(tvuShareBtn)) return;
    var T = state.timeline;
    var c = tvuCounts();
    var hasData = T.vodId && (T.groups.length || (state.wSeen || 0) > 0) && T.duration;
    var label = hasData ? (c.rec + '/' + c.tot) : '';
    // évite le churn DOM : ne reconstruit que si besoin, ne touche au texte que s'il change
    if (!tvuShareBtn.__tvuBuilt) {
      tvuShareBtn.__tvuBuilt = true;
      tvuShareBtn.innerHTML = TVU_SPK;
      var lb = document.createElement('span');
      lb.setAttribute('data-tvu', 'share-label');
      lb.style.cssText = 'font-variant-numeric:tabular-nums;';
      tvuShareBtn.appendChild(lb);
      tvuShareBtn.__tvuLabel = null;
    }
    if (tvuShareBtn.__tvuLabel !== label) {
      tvuShareBtn.__tvuLabel = label;
      var sp = tvuShareBtn.querySelector('[data-tvu="share-label"]');
      if (sp) {
        while (sp.firstChild) sp.removeChild(sp.firstChild);
        if (label) sp.appendChild(document.createTextNode(label));
      }
    }
    tvuShareBtn.title = (T.vodId && T.groups.length)
      ? ('Twitch VOD Unmute — ' + c.rec + '/' + c.tot + ' passages récupérés. Cliquer pour ouvrir.')
      : 'Twitch VOD Unmute';
  }

  function tvuMountShareBtn() {
    try {
      if (tvuShareBtn && document.contains(tvuShareBtn)) return true;
      tvuShareBtn = null;
      var share = tvuFindShare();
      if (!share || !share.parentElement) return false;
      tvuShareBtn = document.createElement('button');
      tvuShareBtn.type = 'button';
      tvuShareBtn.setAttribute('data-tvu', 'share-btn');
      // même gabarit que la pilule Share native (vars + replis)
      tvuShareBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;' +
        'margin-left:8px;padding:7px 12px;border:0;border-radius:6px;' +
        'background-color:var(--color-background-button-secondary-default,rgba(255,255,255,.13));' +
        'color:var(--color-text-base,#efeff1);font:inherit;font-size:13px;font-weight:600;' +
        'cursor:pointer;white-space:nowrap;';
      tvuShareBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        tvuToggleDrop();
      });
      share.parentElement.insertBefore(tvuShareBtn, share.nextSibling);
      tvuPaintShareBtn();
      return true;
    } catch (e) { return false; }
  }

  function tvuToggleDrop() {
    if (tvuPanel && document.contains(tvuPanel)) {
      tvuCloseDrop();
      return;
    }
    var wantVod = tvuVodId();
    if (!wantVod || !document.body) return;
    tvuPanel = tvuBuildDrop(wantVod);
    tvuPanelVod = wantVod;
    tvuPanelDirty = true;
    tvuRenderPanel();
    tvuPositionDrop();
  }

  function tvuCloseDrop() {
    try { if (tvuPanel && tvuPanel.parentNode) tvuPanel.parentNode.removeChild(tvuPanel); } catch (e) {}
    tvuPanel = null;
    tvuPanelVod = null;
  }

  // Le dropdown s'ouvre TOUJOURS vers le haut (même par-dessus la vidéo) :
  // pas de scroll nécessaire pour l'atteindre.
  function tvuPositionDrop() {
    try {
      if (!tvuPanel || !tvuShareBtn || !document.contains(tvuShareBtn)) return;
      var r = tvuShareBtn.getBoundingClientRect();
      tvuPanel.style.top = 'auto';
      tvuPanel.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
      tvuPanel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      tvuPanel.style.maxHeight = Math.max(220, r.top - 24) + 'px';
    } catch (e) {}
  }

  function tvuHookOutside() {
    if (tvuOutsideHooked) return;
    tvuOutsideHooked = true;
    try {
      document.addEventListener('click', function (ev) {
        if (!tvuPanel || !document.contains(tvuPanel)) return;
        var t = ev.target;
        if (tvuPanel.contains(t)) return;
        if (tvuShareBtn && tvuShareBtn.contains(t)) return;
        // la modale de consentement vit hors dropdown : ses clics ne ferment rien
        try {
          var el = t && t.closest ? t.closest('[data-tvu="modal"]') : null;
          if (el) return;
        } catch (e) {}
        tvuCloseDrop();
      }, true);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') tvuCloseDrop();
      }, true);
      window.addEventListener('scroll', function () { tvuPositionDrop(); }, true);
      window.addEventListener('resize', function () { tvuPositionDrop(); });
    } catch (e) {}
  }

  function tvuBtn(label, primary) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-tvu-btn', '1');
    b.textContent = label;
    b.style.cssText = 'border:0;border-radius:6px;padding:5px 12px;font:inherit;' +
      'font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;' +
      (primary
        ? 'background-color:var(--color-background-button-primary-default,#9146ff);color:#fff;'
        : 'background-color:var(--color-background-button-secondary-default,#2f2f35);color:var(--color-text-base,#efeff1);');
    return b;
  }

  function tvuBuildDrop(vodId) {
    var sec = document.createElement('div');
    sec.setAttribute('data-tvu', 'panel');
    sec.setAttribute('role', 'dialog');
    sec.setAttribute('aria-label', 'Twitch VOD Unmute');
    sec.style.cssText = 'position:fixed;z-index:2147483001;width:340px;max-width:calc(100vw - 16px);' +
      'overflow:auto;background-color:var(--color-background-alt-default,var(--color-background-alt,#26262c));' +
      'border:1px solid var(--color-border-base,#323239);border-radius:8px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.6);padding:0;font:inherit;' +
      'color:var(--color-text-base,#efeff1);font-size:13px;';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 14px 8px;';
    head.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
      '<path d="M3 8v4h3l4 4V4L6 8H3z"/><path d="M13.5 6.5a5 5 0 0 1 0 7" stroke="currentColor" ' +
      'stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
    var tt = document.createElement('div');
    tt.style.cssText = 'flex:1;min-width:0;';
    tvuDropTitle = document.createElement('div');
    tvuDropTitle.style.cssText = 'font-weight:600;font-size:13px;';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;opacity:.7;';
    sub.textContent = 'Pistes audio d\u2019origine restaurées quand le CDN les a encore.';
    tt.appendChild(tvuDropTitle);
    tt.appendChild(sub);
    head.appendChild(tt);

    tvuDropSwitch = document.createElement('button');
    tvuDropSwitch.type = 'button';
    tvuDropSwitch.setAttribute('role', 'switch');
    tvuDropSwitch.title = 'Activer / mettre en pause';
    tvuDropSwitch.style.cssText = 'position:relative;flex:0 0 auto;width:36px;height:20px;border-radius:999px;' +
      'border:0;cursor:pointer;padding:0;';
    var knob = document.createElement('span');
    knob.style.cssText = 'position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;' +
      'background:#fff;transition:left .15s;';
    tvuDropSwitch.appendChild(knob);
    tvuDropSwitch.addEventListener('click', function (ev) {
      ev.stopPropagation();
      window.dispatchEvent(new CustomEvent('TVU_UI_SET', { detail: { enabled: !state.enabled } }));
    });
    head.appendChild(tvuDropSwitch);

    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.title = 'Fermer';
    x.setAttribute('data-tvu-x', '1');
    x.style.cssText = 'border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;font-size:13px;padding:4px;line-height:1;';
    x.addEventListener('click', function () { tvuCloseDrop(); });
    head.appendChild(x);
    sec.appendChild(head);

    var body = document.createElement('div');
    body.style.cssText = 'padding:0 14px 12px;';
    var track = document.createElement('div');
    track.style.cssText = 'height:6px;border-radius:3px;background:rgba(255,255,255,.12);' +
      'overflow:hidden;margin:2px 0 8px;';
    tvuDropBarFill = document.createElement('div');
    tvuDropBarFill.style.cssText = 'height:100%;width:0%;background:#00e676;border-radius:3px;';
    track.appendChild(tvuDropBarFill);
    body.appendChild(track);
    tvuDropRows = document.createElement('div');
    body.appendChild(tvuDropRows);
    tvuDropFoot = document.createElement('div');
    tvuDropFoot.style.cssText = 'font-size:12px;color:var(--color-text-alt,#adadb8);margin-top:8px;';
    body.appendChild(tvuDropFoot);
    sec.appendChild(body);
    document.body.appendChild(sec);
    return sec;
  }

  function tvuPaintSwitch() {
    if (!tvuDropSwitch) return;
    var on = !!state.enabled;
    tvuDropSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
    tvuDropSwitch.style.background = on ? '#772ce8' : '#53535a';
    var knob = tvuDropSwitch.firstChild;
    if (knob) knob.style.left = on ? '18px' : '2px';
  }

  function tvuRenderPanel() {
    var T = state.timeline;
    if (!tvuIsVodPage()) return;
    tvuEnsureStyle();
    tvuHookOutside();
    // le bouton vit sa vie : monté dès la page VOD, libellé dès les données
    tvuMountShareBtn();
    tvuPaintShareBtn();
    var wantVod = tvuVodId();
    var ready = wantVod && (T.vodId === wantVod) && (T.groups.length > 0 || (state.wSeen || 0) > 0);
    if (!ready) return;
    // dropdown : (re)construit seulement si demandé/ouvert
    var open = tvuPanel && document.contains(tvuPanel) && tvuPanelVod === wantVod;
    if (!open) {
      // on ne construit que sur demande (clic) : ici on s'assure juste qu'un
      // dropdown ouvert sur une autre VOD est fermé
      if (tvuPanel) tvuCloseDrop();
      return;
    }
    if (!tvuPanelDirty) return;
    tvuPanelDirty = false;
    var c = tvuCounts();
    tvuDropTitle.textContent = T.groups.length
      ? 'Audio restauré : ' + c.rec + '/' + c.tot + ' passages'
      : 'Audio d\u2019origine intact sur cette VOD';
    tvuDropBarFill.style.width = (c.tot ? (c.rec / c.tot * 100).toFixed(1) : 100) + '%';
    tvuDropBarFill.style.background = c.rec === c.tot ? '#00e676' : (c.rec === 0 ? '#eb0400' : '#ffb300');
    tvuPaintSwitch();
    while (tvuDropRows.firstChild) tvuDropRows.removeChild(tvuDropRows.firstChild);
    if (!T.groups.length) {
      var ok = document.createElement('div');
      ok.style.cssText = 'font-size:13px;color:var(--color-text-alt,#adadb8);padding:4px 0;';
      ok.textContent = '✓ Aucun passage coupé détecté dans les playlists chargées.';
      tvuDropRows.appendChild(ok);
    }
    for (var g = 0; g < T.groups.length; g++) {
      (function (gr) {
        var n = Math.max(1, gr.b - gr.a + 1);
        var rec = 0;
        for (var i = gr.a; i <= gr.b; i++) if (!T.failed[i]) rec++;
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;' +
          'border-top:1px solid var(--color-border-base,#2f2f35);font-size:13px;';
        var tm = document.createElement('span');
        tm.style.cssText = 'font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;';
        tm.textContent = fmtT(gr.s) + ' → ' + fmtT(gr.e);
        tm.title = 'Aller à ce passage';
        (function (t0) {
          tm.addEventListener('click', function () {
            try {
              var v = pickVideo();
              if (v) { v.currentTime = Math.max(0, t0 + 0.5); v.play().catch(function () {}); }
            } catch (e) {}
            tvuCloseDrop();
          });
        })(gr.s);
        var ct = document.createElement('span');
        ct.style.cssText = 'margin-left:auto;color:var(--color-text-alt,#adadb8);font-size:12px;';
        ct.textContent = rec + '/' + n + ' récupérés';
        row.appendChild(tm);
        row.appendChild(ct);
        if (rec > 0 && T.bestBase) {
          var b = tvuBtn('Télécharger', true);
          b.title = 'Fusionne les originaux en un .ts lisible VLC';
          b.addEventListener('click', function () {
            tvuDownloadRange(T.vodId, gr.a, gr.b, T.bestBase, b);
          });
          row.appendChild(b);
        } else {
          var off = tvuBtn('Purgé du CDN', false);
          off.disabled = true;
          off.style.opacity = '.55';
          off.title = 'Originaux 403 — rien à sauver pour cette plage';
          row.appendChild(off);
        }
        tvuDropRows.appendChild(row);
      })(T.groups[g]);
    }
    tvuRenderDl();
  }

  // Fetch parallélisé d'une plage (retourne bufs ordonnés + index OK).
  function tvuFetchRange(base, a, b, tick) {
    var urls = [];
    for (var k = a; k <= b; k++) urls.push(base + k + '.ts');
    var total = urls.length;
    var parts = new Array(total).fill(null);
    var done = 0, ok = 0, skip = 0, next = 0;
    function worker() {
      if (next >= total) return Promise.resolve();
      var i = next++;
      return fetch(urls[i], { method: 'GET', credentials: 'omit', cache: 'no-store' }).then(function (r) {
        if (r.ok) return r.arrayBuffer().then(function (buf) { parts[i] = buf; ok++; });
        skip++;
      }).catch(function () { skip++; }).then(function () {
        done++;
        if (tick && (done % 2 === 0 || done === total)) tick(done, total, ok, skip);
        return worker();
      });
    }
    var pool = [];
    for (var w = 0; w < Math.min(4, total); w++) pool.push(worker());
    return Promise.all(pool).then(function () {
      var bufs = [], okIdx = [];
      for (var j = 0; j < parts.length; j++) if (parts[j]) { bufs.push(parts[j]); okIdx.push(a + j); }
      return { bufs: bufs, okIdx: okIdx, done: done, ok: ok, skip: skip, total: total };
    });
  }



  // ---------- Téléchargement côté page (v2.0) ----------
  // Le CDN renvoie 403 aux requêtes du service worker (pas de Referer Twitch)
  // mais 200 depuis la page : on télécharge donc ici, là où le player lit déjà.
  var tvuDlRunning = false;

  function tvuDlState() {
    try { return window.__TVU_DL__ || null; } catch (e) { return null; }
  }
  function tvuSetDl(p) {
    try { window.__TVU_DL__ = p; } catch (e) {}
    tvuRenderDl();
  }

  function tvuDownloadRange(vodId, a, b, base, btn) {
    if (tvuDlRunning) return;
    var T = state.timeline;
    if (!vodId || T.vodId !== vodId || a == null || b == null || !base) return;
    tvuDlRunning = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
    var filename = 'tvu-' + vodId + '-' + a + '-' + b + '.ts';
    var total = b - a + 1;
    tvuSetDl({ state: 'run', done: 0, total: total, ok: 0, skip: 0, filename: filename });
    tvuFetchRange(base, a, b, function (done, tot2, ok, skip) {
      tvuSetDl({ state: 'run', done: done, total: tot2, ok: ok, skip: skip, filename: filename });
    }).then(function (fr) {
      tvuDlRunning = false;
      if (!fr.bufs.length) {
        tvuSetDl({ state: 'error', done: fr.done, total: fr.total, ok: 0, skip: fr.skip, filename: filename, message: 'Originaux purgés (403) — rien de récupérable' });
        tvuPanelDirty = true;
        tvuRenderPanel();
        return;
      }
      try {
        var blob = new Blob(fr.bufs, { type: 'video/mp2t' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        setTimeout(function () {
          try { URL.revokeObjectURL(url); } catch (e) {}
          try { link.parentNode.removeChild(link); } catch (e) {}
        }, 60000);
        tvuSetDl({ state: 'done', done: fr.done, total: fr.total, ok: fr.ok, skip: fr.skip, filename: filename });
      } catch (e) {
        tvuSetDl({ state: 'error', done: fr.done, total: fr.total, ok: fr.ok, skip: fr.skip, filename: filename, message: String((e && e.message) || e) });
      }
      tvuPanelDirty = true;
      tvuRenderPanel();
    });
  }

  function tvuRenderDl() {
    if (!tvuDropFoot) return;
    var d = tvuDlState();
    var T = state.timeline;
    if (d && d.state === 'run' && d.filename && d.filename.indexOf('tvu-' + (T.vodId || '')) === 0) {
      tvuDropFoot.textContent = '⏳ Téléchargement ' + d.done + '/' + d.total + ' segments (' +
        d.ok + ' OK, ' + d.skip + ' purgés)…';
    } else if (d && d.state === 'done' && d.filename && d.filename.indexOf('tvu-' + (T.vodId || '')) === 0) {
      tvuDropFoot.textContent = '✓ ' + d.filename + ' enregistré (' + d.ok + ' segments fusionnés, ' +
        d.skip + ' purgés sautés) — lisible dans VLC.';
    } else if (d && d.state === 'error') {
      tvuDropFoot.textContent = '✕ ' + (d.message || 'Échec du téléchargement.');
    } else {
      tvuDropFoot.textContent = 'Fichiers .ts fusionnés — lisibles dans VLC.';
    }
  }

  function tvuUnmount() {
    try { if (tvuLayer && tvuLayer.parentNode) tvuLayer.parentNode.removeChild(tvuLayer); } catch (e) {}
    tvuLayer = null;
    try { if (tvuPanel && tvuPanel.parentNode) tvuPanel.parentNode.removeChild(tvuPanel); } catch (e) {}
    tvuPanel = null;
    tvuPanelVod = null;
  }

  function tvuRemount() {
    if (tvuRemountT) return;
    tvuRemountT = setTimeout(function () {
      tvuRemountT = null;
      try {
        if (!tvuPlayerRoot || !document.contains(tvuPlayerRoot)) return;
        var needPaint = false;
        if (!tvuLayer || !document.contains(tvuLayer)) { tvuLayer = null; if (tvuMountLayer()) needPaint = true; }
        if (needPaint) tvuPaint();
      } catch (e) {}
    }, 300);
  }

  function tvuWatch(root) {
    try {
      if (tvuObs) tvuObs.disconnect();
      tvuObs = new MutationObserver(function () { tvuRemount(); });
      tvuObs.observe(root, { childList: true, subtree: true });
    } catch (e) {}
  }

  function tvuScan() {
    try {
      if (!tvuIsVodPage()) { tvuUnmount(); return; }
      if (location.pathname !== tvuLastPath) {
        tvuLastPath = location.pathname;
        tvuUnmount();
        tvuPlayerRoot = null;
        state.timeline = { vodId: null, duration: 0, groups: [], failed: {}, bases: [], bestBase: null };
        tvuPanelDirty = true;
      }
      var T = state.timeline;
      var wantVod = tvuVodId();
      // le bouton Share vit sa vie dès la page VOD (même sans données) ;
      // le dropdown, lui, attend la carte (cf. tvuRenderPanel).
      if (wantVod) {
        tvuEnsureStyle();
        tvuMountShareBtn();
        tvuPaintShareBtn();
        if (wantVod && T.vodId === wantVod && (T.groups.length > 0 || (state.wSeen || 0) > 0)) {
          tvuRenderPanel();
        }
      }
      if (!T.vodId || !T.groups.length || !T.duration) return;
      if (!tvuPlayerRoot || !document.contains(tvuPlayerRoot)) {
        tvuPlayerRoot = tvuFindPlayer();
        if (tvuPlayerRoot) tvuWatch(tvuPlayerRoot);
      }
      if (tvuPlayerRoot) {
        var hadLayer = tvuLayer && document.contains(tvuLayer);
        if (tvuMountLayer() && !hadLayer) tvuPaint();
      }
    } catch (e) {}
  }

  function renderHud() {
    var T = state.timeline;
    if (!tvuIsVodPage() || !T.vodId) return;
    tvuScan();
    if (T.groups.length && T.duration) { tvuPaint(); }
    tvuRenderPanel();
  }

  try {
    tvuLastPath = location.pathname;
    if (!tvuScanTimer) tvuScanTimer = setInterval(tvuScan, 3000);
    tvuScan();
  } catch (e) {}


  const log = (...a) => {
    if (state.debug) console.log('[TVU]', ...a);
  };

  window.addEventListener('TVU_CONFIG', (e) => {
    if (e.detail && typeof e.detail.enabled === 'boolean') {
      state.enabled = e.detail.enabled;
      tvuPanelDirty = true;
      tvuRenderPanel();
    }
    if (e.detail && typeof e.detail.debug === 'boolean') state.debug = e.detail.debug;
    if (e.detail && typeof e.detail.workerPatchUrl === 'string') {
      workerPatchUrl = e.detail.workerPatchUrl;
      try { localStorage.setItem('tvu_patch_url', workerPatchUrl); } catch (ign) {}
    }
  });


  // v1.3 : un log unique même sans debug, pour prouver l'armement dans la console.
  // Version exposée (vérifiable en console : window.__TVU_VERSION__).
  try { window.__TVU_VERSION__ = '1.0.0'; window.__TVU_BUILD__ = 7; } catch (e) {}
  console.log('[TVU] v1.0.0 b7 — hook actif, en attente de playlists .m3u8…');
  let loggedFirstM3u8 = false;
  function noteM3u8(url, kind) {
    state.seenM3u8++;
    emitStats();
    if (!loggedFirstM3u8) {
      loggedFirstM3u8 = true;
      console.log('[TVU] première playlist vue (' + kind + ') :', url);
    } else {
      log('playlist vue (' + kind + ') :', url);
    }
  }

  // ---------- Helpers ----------
  const isM3U8Url = (u) => typeof u === 'string' && u.includes('.m3u8');
  const isTsUrl = (u) =>
    typeof u === 'string' && u.includes('.ts') && !u.includes('.m3u8');

  function remuteUrl(unmutedUrl) {
    if (!unmutedUrl || unmutedUrl.includes('-muted')) return unmutedUrl;
    return unmutedUrl.replace(/\.ts(?=\?|#|$)/, '-muted.ts');
  }

  // Master ? contient #EXT-X-STREAM-INF (variants .m3u8) → NE PAS TOUCHER.
  const isMasterPlaylist = (text) => text.includes('#EXT-X-STREAM-INF');
  const isMediaPlaylist = (text) =>
    text.includes('#EXTM3U') && (text.includes('#EXTINF') || text.includes('.ts'));

  // Patch synchrone : uniquement les segments .ts (+ init URI .ts/.mp4), jamais .m3u8.
  function patchMediaPlaylistSync(text) {
    let restored = 0;
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.includes('-muted')) {
        out.push(line);
        continue;
      }
      if (line.startsWith('#')) {
        // #EXT-X-MAP:URI="init-muted.mp4" / KEY etc. — jamais de .m3u8 ici.
        if (/URI="[^"]*-muted[^"]*\.(ts|mp4)/.test(line)) {
          out.push(line.replace(/-muted/g, ''));
          restored++;
        } else {
          out.push(line);
        }
        continue;
      }
      const t = line.trim();
      // Ligne URI : ne réécrire que si c'est un segment .ts (avec ou sans query).
      if (t.includes('.ts') && !t.includes('.m3u8')) {
        out.push(line.replace(/-muted/g, ''));
        restored++;
      } else {
        out.push(line); // variant .m3u8 du master → intact
      }
    }
    return { text: out.join('\n'), restored };
  }

  // ---------- Hook fetch ----------
  const origFetch = window.fetch.bind(window);

  function extractUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof Request) return input.url;
    if (input && typeof input.href === 'string') return input.href;
    try {
      return String(input);
    } catch {
      return '';
    }
  }

  window.fetch = async function (input, init) {
    const url = extractUrl(input);
    const method = (
      (init && init.method) ||
      (input instanceof Request && input.method) ||
      'GET'
    ).toUpperCase();

    if (!state.enabled || method !== 'GET' || (!isM3U8Url(url) && !isTsUrl(url))) {
      return origFetch(input, init);
    }

    // --- Segments .ts : filet de sécurité ---
    // La playlist patchée pointe vers "517.ts". S'il est purgé (403) on rejoue
    // "517-muted.ts" pour ne jamais freezer. Si OK, on laisse passer.
    if (isTsUrl(url) && !url.includes('-muted')) {
      state.seenTs++;
      if (state.seenTs % 10 === 0) emitStats();
      let r;
      try {
        r = await origFetch(input, init);
      } catch (e) {
        // Erreur réseau sur l'unmuted → dernier recours : tenter le muted.
        const muted = remuteUrl(url);
        if (muted !== url) {
          try {
            const r2 =
              input instanceof Request
                ? await origFetch(new Request(muted, input))
                : await origFetch(muted, init);
            if (r2.ok) {
              state.fallbacks++;
              emitStats();
              log('fallback .ts (net-err)', url);
              return r2;
            }
          } catch {}
        }
        throw e;
      }
      if (r.ok || (r.status !== 403 && r.status !== 404)) return r;
      const muted = remuteUrl(url);
      if (muted === url) return r;
      log('fallback .ts', r.status, url);
      try {
        const r2 =
          input instanceof Request
            ? await origFetch(new Request(muted, input))
            : await origFetch(muted, init);
        if (r2.ok) {
          state.fallbacks++;
          emitStats();
          return r2;
        }
      } catch {}
      return r;
    }

    // --- Playlists .m3u8 : patch synchrone immédiat, zéro attente réseau ---
    if (isM3U8Url(url)) {
      let resp;
      try {
        resp = await origFetch(input, init);
      } catch (e) {
        log('m3u8 net-err, passthrough', url);
        throw e;
      }
      if (!resp.ok) return resp;
      noteM3u8(url, 'fetch');
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const clone = resp.clone();
      let text;
      try {
        text = await resp.text();
      } catch {
        return clone;
      }
      if (!text.includes('#EXTM3U') && !ct.includes('mpegurl') && !ct.includes('m3u8')) {
        return clone;
      }
      // Master (variants) → intact, sinon le player 403 sur index-xxx.m3u8.
      if (isMasterPlaylist(text)) return clone;
      if (!isMediaPlaylist(text) || !text.includes('-muted')) return clone;

      const { text: patched, restored } = patchMediaPlaylistSync(text);
      if (restored > 0) {
        state.playlists++;
        state.restored += restored;
        state.lastUrl = url;
        emitStats();
        log(`m3u8 ${url}: ${restored} segments restaurés (optimiste)`);
      }
      const headers = new Headers(clone.headers);
      headers.delete('content-length');
      return new Response(patched, {
        status: clone.status,
        statusText: clone.statusText,
        headers
      });
    }

    return origFetch(input, init);
  };

  // ---------- Hook XHR (même logique, chemin secondaire) ----------
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__tvu_method = String(method || 'GET').toUpperCase();
    this.__tvu_url = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.send = function (...args) {
    const xhr = this;
    const url = xhr.__tvu_url || '';
    const method = xhr.__tvu_method || 'GET';

    if (state.enabled && method === 'GET' && isM3U8Url(url)) {
      xhr.addEventListener('load', () => {
        try {
          if (xhr.status !== 200 || typeof xhr.responseText !== 'string') return;
          noteM3u8(url, 'xhr');
          const text = xhr.responseText;
          if (!text.includes('-muted') || isMasterPlaylist(text)) return;
          if (!isMediaPlaylist(text)) return;
          const { text: patched, restored } = patchMediaPlaylistSync(text);
          if (restored > 0 && patched !== text) {
            state.playlists++;
            state.restored += restored;
            state.lastUrl = url;
            emitStats();
            log(`XHR m3u8 ${url}: ${restored} restaurés`);
            try {
              Object.defineProperty(xhr, 'responseText', { value: patched, configurable: true });
              if (!xhr.responseType || xhr.responseType === 'text') {
                Object.defineProperty(xhr, 'response', { value: patched, configurable: true });
              }
            } catch {}
          }
        } catch {}
      });
    }

    if (state.enabled && method === 'GET' && isTsUrl(url) && !url.includes('-muted')) {
      state.seenTs++;
      if (state.seenTs % 10 === 0) emitStats();
      xhr.addEventListener('load', () => {
        try {
          if ((xhr.status === 403 || xhr.status === 404) && !xhr.__tvu_retried) {
            xhr.__tvu_retried = true;
            const muted = remuteUrl(url);
            if (muted === url) return;
            log('XHR fallback .ts', url);
            state.fallbacks++;
            emitStats();
            const retry = new OrigXHR();
            retry.open('GET', muted, true);
            try {
              retry.responseType = xhr.responseType;
            } catch {}
            retry.onload = () => {
              try {
                Object.defineProperty(xhr, 'response', { value: retry.response, configurable: true });
                Object.defineProperty(xhr, 'status', { value: retry.status, configurable: true });
                try {
                  Object.defineProperty(xhr, 'responseText', { value: retry.responseText, configurable: true });
                } catch {}
              } catch {}
              xhr.dispatchEvent(new Event('load'));
              xhr.dispatchEvent(new Event('loadend'));
            };
            retry.onerror = () => xhr.dispatchEvent(new Event('error'));
            retry.send();
          }
        } catch {}
      });
    }

    return origSend.apply(this, args);
  };

  // ---------- Worker IVS (v1.4) ----------
  // Le player Twitch charge le HLS dans un Dedicated Worker créé depuis un
  // blob: (Amazon IVS). Le hook MAIN ne voit donc rien (compteurs à 0).
  // Même technique que TwitchNoSub/vaft : XHR synchrone du source, préfixe
  // importScripts(worker-patch.js), nouveau Blob. Idempotent + repli natif.
  function getWorkerSrcSync(u) {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', u, false);
      try { x.overrideMimeType('text/javascript'); } catch (e) {}
      x.send();
      if (x.status === 200 || x.status === 0) return x.responseText;
    } catch (e) {}
    return null;
  }

  try {
    const OrigWorker = window.Worker;
    if (OrigWorker) {
      window.Worker = new Proxy(OrigWorker, {
        construct(t, args, newTarget) {
          try {
            const src0 = args[0];
            if (state.enabled && workerPatchUrl && typeof src0 === 'string') {
              const abs = String(new URL(src0, location.href));
              const code = getWorkerSrcSync(abs.replace(/'/g, '%27'));
              if (
                code && code.indexOf('__TVU_WPATCHED__') === -1 &&
                /(m3u8|ext-x-stream-inf|\.ts\b)/i.test(code) &&
                !/importScripts\s*\(\s*['"]\./.test(code) &&
                !/from\s+['"]\./.test(code)
              ) {
                const wrapped =
                  "importScripts('" + workerPatchUrl.replace(/'/g, '%27') + "');\n" + code;
                const blobUrl = URL.createObjectURL(
                  new Blob([wrapped], { type: 'text/javascript' })
                );
                try {
                  console.log('[TVU] worker IVS hooké :', abs.slice(0, 120));
                  return Reflect.construct(t, [blobUrl].concat(args.slice(1)), newTarget);
                } catch (e) {
                  log('worker blob refusé (CSP ?), repli natif');
                }
              }
            }
          } catch (e) {}
          return Reflect.construct(t, args, newTarget);
        }
      });
    }
  } catch (e) {}

  log('hook armé (MAIN + worker IVS, master-safe)');
})();
