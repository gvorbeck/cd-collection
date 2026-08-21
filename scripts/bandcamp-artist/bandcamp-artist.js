(async () => {
  try {
    /* Fallback FX table. Only reached when Bandcamp's own rate table is
       missing from the page, or is missing one currency. These drift, so
       anything converted with them is flagged in the output. */
    var FX = {USD:1,GBP:1.27,EUR:1.08,AUD:0.66,CAD:0.73,NZD:0.61,NOK:0.093,JPY:0.0064,SEK:0.095,DKK:0.145,CHF:1.11,MXN:0.055,BRL:0.18,PLN:0.25,CZK:0.043,HUF:0.0028,ILS:0.27,ZAR:0.055,SGD:0.74,HKD:0.128,INR:0.012,RUB:0.011};

    /* Currencies that fell back to FX, and ones with no rate anywhere. */
    var fxFallback = new Set();
    var fxMissing = new Set();

    function num(v) {
      if (v && typeof v === 'object') v = v.amount != null ? v.amount : v.price;
      var n = typeof v === 'string' ? parseFloat(v) : v;
      return typeof n === 'number' && isFinite(n) ? n : null;
    }

    /* Artist pages load Bandcamp's live rates as window.CurrencyData rather
       than carrying them in the page blob the way the wishlist does. Same
       table either way; the USD===1 check is what proves it's the real one. */
    function rateTable() {
      var r = window.CurrencyData && window.CurrencyData.rates;
      return r && num(r.USD) === 1 ? r : null;
    }

    /* Returns the USD figure AND where the rate came from, so a guess never
       gets displayed as though it were Bandcamp's own number.

       Both rate tables are USD-per-unit-of-currency, so both MULTIPLY. That
       is the same direction as the FX literals above (GBP 1.27 = one pound is
       $1.27), and it is what CurrencyData.rates holds too: rates.JPY is
       0.0063, because one yen is well under a cent. It reads like a table
       you'd divide by. Dividing inverts every non-USD row and, since the sort
       key is the USD figure, silently scrambles the whole ranking. */
    function convert(amount, currency, rates) {
      var a = num(amount) || 0, c = currency || 'USD';
      if (c === 'USD') return {usd: a, src: 'usd'};
      if (rates && num(rates[c]) > 0) return {usd: a * num(rates[c]), src: 'live'};
      if (FX[c]) { fxFallback.add(c); return {usd: a * FX[c], src: 'table'}; }
      fxMissing.add(c); return {usd: a, src: 'none'};
    }

    function detailsPrice(d) {
      /* Being rate-limited is not the same as having no price, and the two
         used to land in the same bucket. Anything marked throttled is worth
         re-running for; "price unknown" means the lookup came back empty. */
      if (d && d.throttled) return {amount: 0, currency: 'USD', kind: 'throttled'};
      if (!d || d.error) return {amount: 0, currency: 'USD', kind: 'unknown'};
      var amt = num(d.price), cur = d.currency || 'USD';
      if (amt === null) return {amount: 0, currency: cur, kind: 'unknown'};
      if (d.is_purchasable === false) return {amount: amt, currency: cur, kind: d.free_download ? 'free' : 'unavailable'};
      if (amt <= 0) return {amount: 0, currency: cur, kind: 'free'};
      return {amount: amt, currency: cur, kind: d.is_set_price === false ? 'nyp' : 'set'};
    }

    function label(p) {
      if (p.kind === 'throttled') return 'rate-limited — re-run';
      if (p.kind === 'unknown') return 'price unknown';
      if (p.kind === 'unavailable') return 'not for sale';
      if (p.kind === 'free') return 'free / name your price';
      var s = p.currency === 'USD' ? '$' + p.amount.toFixed(2) : p.amount.toFixed(2) + ' ' + p.currency;
      return s + (p.kind === 'nyp' ? '+' : '');
    }

    function rank(p) {
      if (p.kind === 'unavailable') return 1;
      if (p.kind === 'unknown') return 2;
      if (p.kind === 'throttled') return 3;
      return 0;
    }

    function csvCell(s) {
      return '"' + ('' + (s == null ? '' : s)).replace(/"/g, '""') + '"';
    }

    function esc(s) {
      return ('' + (s == null ? '' : s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var grid = document.getElementById('music-grid');
    if (!grid) throw new Error('no discography on this page — open the artist’s Music tab');

    /* Two views of the same list, and neither is reliably complete on its
       own: the server renders the first screenful as <li>, and the rest ride
       along in data-client-items for the page's own script to hydrate. Read
       both, keyed by type+id, and take whichever arrived. */
    var all = new Map();
    var put = function (it) {
      if (!it.id || !it.type) return;
      var key = it.type + '-' + it.id;
      var prev = all.get(key) || {};
      all.set(key, {
        id: it.id,
        type: it.type,
        band_id: it.band_id || prev.band_id,
        title: it.title || prev.title,
        artist: it.artist || prev.artist,
        url: it.url || prev.url
      });
    };

    Array.prototype.forEach.call(grid.querySelectorAll('li[data-item-id]'), function (li) {
      var m = /^(album|track)-(\d+)$/.exec(li.getAttribute('data-item-id') || '');
      if (!m) return;
      var a = li.querySelector('a[href]');
      /* .title holds the release name and, on label pages, the artist name in
         a nested .artist-override — pull the artist out before reading text,
         or every title on a label page ends with its own artist glued on. */
      var t = li.querySelector('.title'), name = '', over = '';
      if (t) {
        var clone = t.cloneNode(true);
        Array.prototype.forEach.call(clone.querySelectorAll('.artist-override'), function (o) {
          over = (o.textContent || '').trim();
          o.remove();
        });
        name = (clone.textContent || '').trim();
      }
      put({id: +m[2], type: m[1], band_id: +(li.getAttribute('data-band-id') || 0) || null, title: name, artist: over, url: a ? a.href : null});
    });

    try {
      JSON.parse(grid.getAttribute('data-client-items') || '[]').forEach(function (x) {
        put({id: x.id, type: x.type, band_id: x.band_id, title: x.title, artist: x.artist, url: x.page_url ? new URL(x.page_url, location.origin).href : null});
      });
    } catch (e) {}

    var rows = Array.from(all.values());
    if (!rows.length) throw new Error('found the grid but no releases in it');

    var bandName = (document.querySelector('#band-name-location .title') || {}).textContent || document.title;
    bandName = ('' + bandName).trim();
    var fallbackBand = null;
    rows.forEach(function (row) { if (!fallbackBand && row.band_id) fallbackBand = row.band_id; });

    var old = document.getElementById('bca-panel');
    if (old) old.remove();
    var status = document.getElementById('bca-status');
    if (status) status.remove();
    status = document.createElement('div');
    status.id = 'bca-status';
    status.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;background:#1da0c3;color:#fff;padding:10px 14px;border-radius:6px;font:13px monospace;box-shadow:0 4px 24px rgba(0,0,0,.4)';
    status.textContent = 'Pricing ' + rows.length + ' releases...';
    document.body.appendChild(status);

    var rates = rateTable();

    /* Anything already priced in this tab is reused. A run that got
       rate-limited half way can be re-run immediately and only pays for the
       releases it missed. Cleared by a page reload, which is fine. */
    window.__bcaPrices = window.__bcaPrices || {};
    var cache = window.__bcaPrices;

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    /* tralbum_details is rate-limited: about thirty requests arrive fine and
       then every one after that is a 429 until you back off. Six workers
       firing flat out hit that wall on any discography over ~40 releases, and
       because a 429 has no price in it, the whole tail of the list came back
       "price unknown" — a real limit misreported as missing data.

       So all workers share one clock. Each request starts `pace` ms after the
       previous one started, whichever worker it belongs to; a 429 stops every
       worker for the Retry-After the response asks for and widens the pace,
       and a long clean streak narrows it back. Measured on the way in: one
       request every 500ms drew no 429s at all. */
    var PACE_MIN = 350, PACE_MAX = 2500, TRIES = 8;
    var pace = 450, nextAt = 0, streak = 0;
    var gate = Promise.resolve(), pausedUntil = 0, waits = 0;

    var slot = async function () {
      await gate;
      var now = Date.now();
      var at = Math.max(now, nextAt);
      nextAt = at + pace;
      if (at > now) await sleep(at - now);
    };

    var pauseAll = function (secs) {
      var until = Date.now() + secs * 1000;
      if (until <= pausedUntil) return gate;
      pausedUntil = until;
      nextAt = Math.max(nextAt, until);
      waits++;
      gate = sleep(until - Date.now());
      return gate;
    };

    var fetchDetails = async function (row) {
      var bid = row.band_id || fallbackBand || 1;
      var url = '/api/mobile/25/tralbum_details?band_id=' + bid + '&tralbum_id=' + row.id + '&tralbum_type=' + (row.type === 'track' ? 't' : 'a');
      for (var tries = 0; tries < TRIES; tries++) {
        await slot();
        var res = await fetch(url, {credentials: 'include'});
        if (res.status === 429) {
          var ra = parseFloat(res.headers.get('retry-after'));
          streak = 0;
          pace = Math.min(PACE_MAX, pace + 300);
          await pauseAll(isFinite(ra) && ra > 0 ? Math.min(ra, 30) : 3);
          continue;
        }
        if (!res.ok) return null;
        /* Decay geometrically, not in 50ms steps: one rough patch pins the
           pace at the ceiling, and stepping down from 2500ms would take more
           clean requests than most discographies have. */
        if (++streak > 8 && pace > PACE_MIN) { pace = Math.max(PACE_MIN, Math.round(pace * 0.85)); streak = 0; }
        return await res.json();
      }
      return {throttled: true};
    };

    var next = 0, done = 0;
    var tick = function () {
      status.textContent = 'Pricing releases... ' + done + ' of ' + rows.length +
        (Date.now() < pausedUntil ? ' · waiting out a rate limit' : '') +
        (waits ? ' · ' + waits + ' backoff' + (waits === 1 ? '' : 's') : '');
    };
    var worker = async function () {
      while (next < rows.length) {
        var row = rows[next++];
        var hit = cache[row.type + '-' + row.id];
        if (hit) {
          row.price = hit.price;
          row.title = hit.title || row.title;
          row.artist = row.artist || hit.artist;
          row.url = hit.url || row.url;
          row.released = hit.released;
        } else {
          try {
            var d = await fetchDetails(row);
            row.price = detailsPrice(d);
            if (d && !d.error && !d.throttled) {
              row.title = d.title || row.title;
              row.artist = row.artist || d.tralbum_artist || d.band && d.band.name;
              row.url = d.bandcamp_url || row.url;
              row.released = d.release_date || '';
              cache[row.type + '-' + row.id] = {price: row.price, title: row.title, artist: row.artist, url: row.url, released: row.released};
            }
          } catch (e) {
            row.price = {amount: 0, currency: 'USD', kind: 'unknown'};
          }
        }
        done++;
        tick();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    rows.forEach(function (row) {
      if (!row.price) row.price = {amount: 0, currency: 'USD', kind: 'unknown'};
      var c = convert(row.price.amount, row.price.currency, rates);
      row.usd = +c.usd.toFixed(2);
      row.fx = c.src;
    });

    rows.sort(function (a, b) {
      return rank(a.price) - rank(b.price) || a.usd - b.usd || (a.title || '').localeCompare(b.title || '');
    });

    /* One artist's own page repeats the same name on every line. A label's
       page doesn't, and there the name is the useful half. */
    var artists = new Set();
    rows.forEach(function (row) { if (row.artist) artists.add(row.artist); });
    var showArtist = artists.size > 1;

    var csv = 'rank,price,currency,usd_est,fx_source,price_type,artist,title,released,url\n' + rows.map(function (row, n) {
      return [n + 1, row.price.amount, row.price.currency, row.usd, row.fx, row.price.kind, csvCell(row.artist || bandName), csvCell(row.title), csvCell(row.released), csvCell(row.url)].join(',');
    }).join('\n');
    var csvUrl = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
    var slug = bandName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artist';

    var list = rows.map(function (row, n) {
      var money = label(row.price);
      if (row.price.currency !== 'USD' && (row.price.kind === 'set' || row.price.kind === 'nyp')) {
        money += row.fx === 'none' ? ' (no FX rate)' : ' (~$' + row.usd.toFixed(2) + (row.fx === 'table' ? '?' : '') + ')';
      }
      var name = (showArtist && row.artist ? row.artist + ' - ' : '') + row.title;
      return '<div style="margin:2px 0"><span style="color:#666">' + (n + 1) + '.</span> <b>' + esc(money) + '</b> ' +
        (row.url ? '<a href="' + esc(row.url) + '" target="_blank" style="color:#1da0c3">' + esc(name) + '</a>' : esc(name)) + '</div>';
    }).join('');

    var unknown = rows.filter(function (row) { return row.price.kind === 'unknown'; });
    var throttled = rows.filter(function (row) { return row.price.kind === 'throttled'; });
    var buyable = rows.filter(function (row) { return row.price.kind === 'set' || row.price.kind === 'nyp' || row.price.kind === 'free'; });
    var total = buyable.reduce(function (sum, row) { return sum + row.usd; }, 0);

    var notes = [
      buyable.length + ' for sale',
      '~$' + total.toFixed(2) + ' for all of them' + (throttled.length ? ' so far' : ''),
      unknown.length + ' price unknown',
      '+ means "or more"'
    ];
    /* A run that ends short says so and says what to do about it, rather than
       leaving a tail of rows that read like releases with no price. */
    if (throttled.length) notes.push(throttled.length + ' gave up to rate limiting — click the bookmark again, it keeps what it already has');
    if (waits) notes.push(waits + ' rate-limit backoff' + (waits === 1 ? '' : 's'));
    if (!rates) notes.push('no live FX rates — USD est. from built-in table');
    else if (fxFallback.size) notes.push('built-in FX rate used for ' + Array.from(fxFallback).join(', ') + ' (marked ?)');
    if (fxMissing.size) notes.push('no FX rate at all for ' + Array.from(fxMissing).join(', '));

    status.remove();
    var box = document.createElement('div');
    box.id = 'bca-panel';
    box.style.cssText = 'position:fixed;top:20px;right:20px;width:560px;max-height:85vh;overflow:auto;background:#fff;color:#000;z-index:99999;border:2px solid #1da0c3;border-radius:8px;padding:12px;font:13px/1.4 monospace;box-shadow:0 4px 24px rgba(0,0,0,.4)';
    box.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><b>' + esc(bandName) + ' &mdash; ' + rows.length + ' releases</b><span><a href="' + csvUrl + '" download="bandcamp-' + esc(slug) + '.csv" style="margin-right:10px">CSV</a><a id="bca-dbg" href="javascript:void 0" style="margin-right:10px">Debug</a><a id="bca-x" href="javascript:void 0">&times;</a></span></div><div id="bca-notes" style="margin-bottom:8px;color:#555"></div><div id="bca-list"></div>';
    box.querySelector('#bca-notes').textContent = notes.join(' · ');
    box.querySelector('#bca-list').innerHTML = list;
    box.querySelector('#bca-x').onclick = function (e) { e.preventDefault(); box.remove(); URL.revokeObjectURL(csvUrl); };
    box.querySelector('#bca-dbg').onclick = function (e) {
      e.preventDefault();
      navigator.clipboard.writeText(JSON.stringify({pace: pace, backoffs: waits, sample: unknown.concat(throttled).slice(0, 5)}, null, 1));
      e.target.textContent = 'Copied';
    };
    document.body.appendChild(box);
  } catch (e) {
    var s = document.getElementById('bca-status');
    if (s) s.remove();
    alert('Artist price ranking failed: ' + e.message);
  }
})();
