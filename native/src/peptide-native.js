/* peptide-native.js — Capacitor native shim for the LIVE PeptideOS app.
 *
 * The live PeptideOS (peptideos.cwenterprises.net) is a login-gated app:
 * it makes relative fetch calls to /api/* (auth, peptides, planner, vials,
 * logs, settings, vendors, prices, orders, push, parse-price-file) with a
 * Bearer token from localStorage. When wrapped as a native iOS app, the web
 * bundle is served from the local WKWebView origin (https://localhost with
 * Capacitor iosScheme:'https', or capacitor://localhost), so those relative
 * /api/* requests would hit the local bundle instead of the server. This
 * shim repoints every /api/* fetch at the live origin so login and data
 * sync work cross-origin (the worker allows https://localhost and
 * capacitor://localhost via CORS).
 *
 * There is NO WebSocket in the live app; rewriteWsUrl is kept for parity
 * with The Wire's shim and future-proofing, and is unit-tested.
 *
 * /privacy, /terms and /labels are cross-origin navigations (not /api) — the shim
 * intercepts clicks on those relative links and opens them at the live
 * origin so they render the real pages instead of 404-ing in the bundle.
 *
 * The rewriteApiUrl / rewriteWsUrl helpers are PURE and unit-tested
 * (test/shim.test.cjs). Keep them side-effect free.
 */
(function () {
  'use strict';

  var LIVE_ORIGIN = 'https://peptideos.cwenterprises.net';

  // Pure: given a request URL (relative or absolute-to-native-scheme) that
  // targets an /api/* path, return the same path pointed at the live origin.
  // Anything that is NOT an /api call (or is already cross-origin to a real
  // remote host) is returned unchanged.
  function rewriteApiUrl(input, liveOrigin) {
    liveOrigin = liveOrigin || LIVE_ORIGIN;
    if (typeof input !== 'string') return input;

    // Relative path: "/api/..." (but not protocol-relative "//host")
    if (input.charAt(0) === '/' && input.charAt(1) !== '/') {
      if (input.indexOf('/api/') === 0 || input === '/api') {
        return liveOrigin + input;
      }
      return input;
    }

    // Absolute URL. Repoint only when the host is a native/local scheme host
    // AND the path is /api/*. Real remote hosts pass through untouched.
    var m = /^(https?|capacitor|ionic):\/\/([^/]+)(\/[^?#]*)?/i.exec(input);
    if (!m) return input;
    var host = m[2];
    var path = m[3] || '/';
    var isLocalHost = host === 'localhost' || host === 'localhost:80' ||
      host === 'localhost:443' || host === '' ;
    if (isLocalHost && (path.indexOf('/api/') === 0 || path === '/api')) {
      var tail = input.slice(m[0].length); // preserve ?query#hash
      return liveOrigin + path + tail;
    }
    return input;
  }

  // Pure: rewrite a ws://localhost/... or /ws relative URL to wss at live origin.
  function rewriteWsUrl(input, liveOrigin) {
    liveOrigin = liveOrigin || LIVE_ORIGIN;
    var wssOrigin = liveOrigin.replace(/^http/i, 'ws');
    if (typeof input !== 'string') return input;
    if (input.charAt(0) === '/' && input.charAt(1) !== '/') {
      return wssOrigin + input;
    }
    var m = /^wss?:\/\/([^/]+)(\/.*)?$/i.exec(input);
    if (!m) return input;
    var host = m[1];
    if (host === 'localhost' || host.indexOf('localhost:') === 0) {
      return wssOrigin + (m[2] || '/');
    }
    return input;
  }

  // Pure: the peptide slug from a vial-label deep link (https://…/?log=pt141), or null.
  function logSlugFromUrl(input) {
    if (typeof input !== 'string') return null;
    var m = /[?&]log=([^&#]*)/.exec(input);
    if (!m) return null;
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')) || null; } catch (e) { return null; }
  }

  // Expose helpers for tests / debugging.
  var api = { rewriteApiUrl: rewriteApiUrl, rewriteWsUrl: rewriteWsUrl, logSlugFromUrl: logSlugFromUrl, LIVE_ORIGIN: LIVE_ORIGIN };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.PeptideNative = api;

    // Patch fetch: repoint /api/* at the live origin.
    if (typeof window.fetch === 'function') {
      var origFetch = window.fetch.bind(window);
      window.fetch = function (resource, init) {
        try {
          if (typeof resource === 'string') {
            resource = rewriteApiUrl(resource);
          } else if (resource && typeof resource.url === 'string') {
            var newUrl = rewriteApiUrl(resource.url);
            if (newUrl !== resource.url) resource = new Request(newUrl, resource);
          }
        } catch (e) { /* never break the app over a rewrite */ }
        return origFetch(resource, init);
      };
    }

    // Patch WebSocket (no-op for today's app; parity with The Wire shim).
    if (typeof window.WebSocket === 'function') {
      var OrigWS = window.WebSocket;
      var PatchedWS = function (url, protocols) {
        try { url = rewriteWsUrl(url); } catch (e) {}
        return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      };
      PatchedWS.prototype = OrigWS.prototype;
      PatchedWS.CONNECTING = OrigWS.CONNECTING; PatchedWS.OPEN = OrigWS.OPEN;
      PatchedWS.CLOSING = OrigWS.CLOSING; PatchedWS.CLOSED = OrigWS.CLOSED;
      window.WebSocket = PatchedWS;
    }

    // Universal Link from a vial-label QR (app already running, or cold launch).
    // Stash the slug where the web app's own ?log= handling looks for it; if the app
    // is already showing, apply now, otherwise showApp() applies it after login/boot.
    function handleDeepLink(url) {
      var slug = logSlugFromUrl(url);
      if (!slug) return;
      try { sessionStorage.setItem('pending_log', slug); } catch (e) { return; }
      var main = document.getElementById('mainApp');
      if (main && main.style.display === 'block' && typeof window.applyPendingLogLink === 'function') {
        window.applyPendingLogLink();
      }
    }
    try {
      var CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (CapApp) {
        CapApp.addListener('appUrlOpen', function (ev) { handleDeepLink(ev && ev.url); });
        CapApp.getLaunchUrl().then(function (r) { if (r && r.url) handleDeepLink(r.url); }).catch(function () {});
      }
    } catch (e) { /* never break the app over deep links */ }

    // Open /privacy and /terms at the live origin (they are server-rendered
    // pages, not part of the local bundle). Capture clicks on those links.
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      // /labels prints best from the live site (the WKWebView can't print), so open it there too
      if (href === '/privacy' || href === '/terms' || href === '/labels') {
        ev.preventDefault();
        var url = LIVE_ORIGIN + href;
        // Prefer Capacitor Browser if present; else window.open.
        try {
          if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
            window.Capacitor.Plugins.Browser.open({ url: url });
            return;
          }
        } catch (e) {}
        window.open(url, '_blank');
      }
    }, true);
  }
})();
