/* haloe tracking — Meta Pixel + Google Analytics 4, behind a cookie banner.
   Paste the two IDs below. While BOTH are empty nothing loads and no banner shows.
   Nothing runs until the visitor taps Accept (see privacy.html, "Cookies and analytics").
   No names, emails, phone numbers or health details are ever sent — only page views,
   the treatment price and the booking total. Not loaded on /intake or /app on purpose. */
(function () {
  var CFG = { META_PIXEL_ID: '1458867292869954', GA4_ID: 'G-DRSG76LKPP' };
  var KEY = 'haloe_consent';
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  var hasIds = !!(CFG.META_PIXEL_ID || CFG.GA4_ID);
  var loaded = false, queue = [];

  // Remember where the visitor came from (utm_*, fbclid) for this visit, once they've agreed.
  function captureUtm() {
    try {
      var p = new URLSearchParams(location.search), o = {}, any = false;
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) { if (p.get(k)) { o[k] = p.get(k).slice(0, 80); any = true; } });
      if (p.get('fbclid')) { o.fbclid = 'yes'; any = true; }
      if (any && !sessionStorage.getItem('haloe_utm')) sessionStorage.setItem('haloe_utm', JSON.stringify(o));
    } catch (e) {}
  }

  function load() {
    if (loaded || !hasIds) return; loaded = true; captureUtm();
    if (CFG.GA4_ID) {
      var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + CFG.GA4_ID; document.head.appendChild(s);
      window.dataLayer = window.dataLayer || []; window.gtag = function () { dataLayer.push(arguments); };
      gtag('js', new Date()); gtag('config', CFG.GA4_ID, { anonymize_ip: true });
    }
    if (CFG.META_PIXEL_ID) {
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', CFG.META_PIXEL_ID); fbq('track', 'PageView');
    }
    queue.splice(0).forEach(function (a) { send(a[0], a[1]); });
  }

  // Public: haloeTrack('ViewContent'|'InitiateCheckout'|'Purchase', { value: 32, currency: 'GBP', id: '...' })
  function send(name, d) {
    d = d || {}; var cur = d.currency || 'GBP';
    if (window.fbq && CFG.META_PIXEL_ID) {
      var m = { value: d.value, currency: cur }; if (d.name) m.content_name = d.name;
      fbq('track', name, m);
      // Health and wellness datasets can have standard events held back by Meta, so the same moments are
      // also sent as custom events (27 Oct 2026). Same data as above: a price, never a name or health detail.
      var custom = { InitiateCheckout: 'CheckoutStarted', Purchase: 'BookingCompleted' }[name];
      if (custom) fbq('trackCustom', custom, m);
    }
    if (window.gtag && CFG.GA4_ID) {
      var g = { value: d.value, currency: cur };
      if (name === 'Purchase') { g.transaction_id = d.id; gtag('event', 'purchase', g); }
      else if (name === 'InitiateCheckout') gtag('event', 'begin_checkout', g);
      else if (name === 'ViewContent') gtag('event', 'view_item', g);
    }
  }
  window.haloeTrack = function (name, d) { if (get() !== 'granted' || !hasIds) return; if (!loaded) { queue.push([name, d]); return; } send(name, d); };
  window.haloeUtm = function () { try { return JSON.parse(sessionStorage.getItem('haloe_utm') || '{}'); } catch (e) { return {}; } };
  window.haloeCookieSettings = function () { set(''); try { localStorage.removeItem(KEY); } catch (e) {} showBanner(); };

  function showBanner() {
    if (!hasIds || document.getElementById('haloeConsent')) return;
    var st = document.createElement('style');
    st.textContent = '#haloeConsent{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:520px;margin:0 auto;background:#2A2620;color:#F7F3EA;border-radius:20px;padding:16px 18px;font:400 14px/1.5 Poppins,Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)}#haloeConsent p{margin:0 0 12px}#haloeConsent a{color:#D7BC82;text-decoration:underline;text-underline-offset:3px}#haloeConsent .hc-row{display:flex;gap:8px}#haloeConsent button{flex:1;min-height:44px;border-radius:14px;border:0;font:500 15px Poppins,Arial,sans-serif;cursor:pointer}#haloeConsent .hc-yes{background:#F7F3EA;color:#2A2620}#haloeConsent .hc-no{background:rgba(247,243,234,.14);color:#F7F3EA}';
    document.head.appendChild(st);
    var b = document.createElement('div'); b.id = 'haloeConsent'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-label', 'Cookies');
    b.innerHTML = '<p>We use cookies to see which pages and ads bring people to haloe. No health details are ever shared. <a href="/privacy">Privacy policy</a></p><div class="hc-row"><button class="hc-no" type="button">No thanks</button><button class="hc-yes" type="button">Accept</button></div>';
    document.body.appendChild(b);
    b.querySelector('.hc-yes').onclick = function () { set('granted'); b.remove(); load(); try { document.dispatchEvent(new Event('haloe-consent')); } catch (e) {} };
    b.querySelector('.hc-no').onclick = function () { set('denied'); b.remove(); };
  }

  function init() { if (!hasIds) return; [].forEach.call(document.querySelectorAll('[data-cookie-settings]'), function (a) { a.hidden = false; a.addEventListener('click', function (e) { e.preventDefault(); window.haloeCookieSettings(); }); }); var c = get(); if (c === 'granted') load(); else if (c !== 'denied') showBanner(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
