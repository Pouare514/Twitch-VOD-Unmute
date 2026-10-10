/* Twitch VOD Unmute — patch worker IVS (portée worker, pas de DOM).
 * Injecté EN PREMIER dans le worker Amazon IVS via importScripts() préfixé
 * (même technique que TwitchNoSub/vaft : sous-classe window.Worker côté MAIN,
 * XHR synchrone du source blob:, nouveau Blob).
 * Ne traite que le HLS : playlists .m3u8 (master-safe) + fallback .ts.
 * Stats renvoyées au thread principal via BroadcastChannel (best-effort).
 */
(function () {
  if (self.__TVU_WPATCHED__) return;
  self.__TVU_WPATCHED__ = true;

  var wid = 'w' + Math.random().toString(36).slice(2);
  var totals = { playlists: 0, restored: 0, fallbacks: 0, seenM3u8: 0, seenTs: 0, lastUrl: '' };
  // Carte des plages mutées : ranges [{s,e,a,b}] (secondes + index),
  // failed {idx:1} (segments dont l'original est purgé → fallback muted),
  // segByUrl {absUrl: idx}, base (dossier variant), total (durée VOD).
  var ranges = [];
  var failed = {};
  var segByUrl = {};
  var variantBase = '';
  var vodTotal = 0;
  var bc = null;
  try { bc = new BroadcastChannel('tvu-w'); } catch (e) { bc = null; }
  function beacon() {
    try { if (bc) bc.postMessage({ type: 'TVU_WSTATS', id: wid, stats: totals, ranges: ranges, failed: failed, base: variantBase, total: vodTotal }); } catch (e) {}
  }

  function isM3U8(u) { return typeof u === 'string' && u.indexOf('.m3u8') !== -1; }
  function isTs(u) {
    return typeof u === 'string' && u.indexOf('.ts') !== -1 && u.indexOf('.m3u8') === -1;
  }
  function remute(u) {
    if (!u || u.indexOf('-muted') !== -1) return u;
    return u.replace(/\.ts(?=\?|#|$)/, '-muted.ts');
  }
  function bodily(resp, text) {
    var h = {};
    try {
      var nh = new Headers(resp.headers);
      nh.delete('content-length');
      h = nh;
    } catch (e) {}
    return new Response(text, { status: resp.status, statusText: resp.statusText, headers: h });
  }
  // Patch synchrone média uniquement : jamais de .m3u8 (le variant
  // "index-xxx.m3u8" sans -muted n'existe pas → 403 prouvé).
  // Construit aussi la carte temporelle (durées EXTINF cumulées) + segByUrl.
  function patchMedia(text, base) {
    var restored = 0;
    var out = [];
    var lines = text.split('\n');
    var t = 0; // temps cumulé (s)
    var idx = 0; // index segment
    var cur = null; // plage mutée en cours {s,a}
    var newRanges = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('-muted') === -1) {
        // Durées même des lignes non mutées (segments sains / commentaires)
        if (line.charAt(0) !== '#' && line.replace(/^\s+|\s+$/g, '').indexOf('.ts') !== -1) {
          var d0 = durOf(lines, i);
          try {
            var au = absUrl(line, base);
            segByUrl[au] = idx;
            segByUrl[au.replace(/-muted/g, '')] = idx;
          } catch (e) {}
          if (cur) { newRanges.push({ s: cur.s, e: t, a: cur.a, b: idx - 1 }); cur = null; }
          t += d0; idx++;
        }
        out.push(line);
        continue;
      }
      if (line.charAt(0) === '#') {
        if (/URI="[^"]*-muted[^"]*\.(ts|mp4)/.test(line)) {
          out.push(line.replace(/-muted/g, ''));
          restored++;
        } else { out.push(line); }
        continue;
      }
      var tr = line.replace(/^\s+|\s+$/g, '');
      if (tr.indexOf('.ts') !== -1 && tr.indexOf('.m3u8') === -1) {
        var d = durOf(lines, i);
        try {
            var au = absUrl(line, base);
            segByUrl[au] = idx;
            segByUrl[au.replace(/-muted/g, '')] = idx;
          } catch (e) {}
        if (!cur) cur = { s: t, a: idx };
        out.push(line.replace(/-muted/g, ''));
        restored++;
        t += d; idx++;
      } else { out.push(line); } // variant .m3u8 du master → intact
    }
    if (cur) newRanges.push({ s: cur.s, e: t, a: cur.a, b: idx - 1 });
    if (newRanges.length) ranges = newRanges;
    return { text: out.join('\n'), restored: restored };
  }
  function durOf(lines, i) {
    for (var j = i - 1; j >= Math.max(0, i - 3); j--) {
      var m = /#EXTINF:([\d.]+)/.exec(lines[j]);
      if (m) return parseFloat(m[1]) || 0;
    }
    return 10;
  }
  function absUrl(line, base) {
    var tr = line.replace(/^\s+|\s+$/g, '');
    return new URL(tr, base).href;
  }

  var segN = 0;
  var oldFetch = self.fetch;
  self.fetch = function (input, opt) {
    var url = (input instanceof Request) ? input.url : String(input);
    var method = 'GET';
    try {
      method = ((opt && opt.method) || (input instanceof Request && input.method) || 'GET').toUpperCase();
    } catch (e) {}
    if (method !== 'GET' || (!isM3U8(url) && !isTs(url))) {
      return oldFetch.apply(this, arguments);
    }

    // --- Segments .ts : si l'unmuted est purgé (403/404), rejoue le muted ---
    if (isTs(url) && url.indexOf('-muted') === -1) {
      totals.seenTs++; segN++;
      if (segN % 20 === 0) beacon();
      return oldFetch.apply(this, arguments).then(function (r) {
        if (r.ok || (r.status !== 403 && r.status !== 404)) return r;
        var muted = remute(url);
        if (muted === url) return r;
        var p = (input instanceof Request) ? oldFetch(new Request(muted, input)) : oldFetch(muted, opt);
        return p.then(function (r2) {
          if (r2.ok) {
            totals.fallbacks++;
            var fi = segByUrl[url];
            if (fi === undefined) { try { fi = segByUrl[url.split('?')[0].split('#')[0]]; } catch (e) {} }
            if (fi !== undefined) failed[fi] = 1; // original purgé → reste muet
            beacon();
            return r2;
          }
          return r;
        }, function () { return r; });
      });
    }

    // --- Playlists .m3u8 : patch optimiste immédiat ---
    if (isM3U8(url)) {
      return oldFetch.apply(this, arguments).then(function (resp) {
        if (!resp.ok) return resp;
        totals.seenM3u8++;
        var clone = null;
        try { clone = resp.clone(); } catch (e) {}
        return resp.text().then(function (text) {
          var mt = /#EXT-X-TWITCH-TOTAL-SECS:([\d.]+)/.exec(text);
          if (mt) vodTotal = parseFloat(mt[1]) || vodTotal;
          try { variantBase = url.slice(0, url.lastIndexOf('/') + 1); } catch (e) {}
          if (text.indexOf('#EXTM3U') === -1 ||
              text.indexOf('#EXT-X-STREAM-INF') !== -1 || // master → intact
              text.indexOf('-muted') === -1) {
            beacon();
            if (clone) return clone;
            return bodily(resp, text);
          }
          var pr = patchMedia(text, url);
          if (pr.restored > 0) {
            totals.playlists++;
            totals.restored += pr.restored;
            totals.lastUrl = url;
          }
          beacon();
          return bodily(resp, pr.text);
        }, function () { return clone || resp; });
      });
    }

    return oldFetch.apply(this, arguments);
  };
})();
