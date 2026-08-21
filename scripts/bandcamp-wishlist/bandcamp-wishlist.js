(async () => {
  try {
    /* Fallback FX table. Only reached when Bandcamp's own rate table is
       missing from the page blob, or is missing one currency. These drift,
       so anything converted with them is flagged in the output. */
    var FX = {USD:1,GBP:1.27,EUR:1.08,AUD:0.66,CAD:0.73,NZD:0.61,NOK:0.093,JPY:0.0064,SEK:0.095,DKK:0.145,CHF:1.11,MXN:0.055,BRL:0.18,PLN:0.25,CZK:0.043,HUF:0.0028,ILS:0.27,ZAR:0.055,SGD:0.74,HKD:0.128,INR:0.012,RUB:0.011};

    /* Currencies that fell back to FX, and ones with no rate anywhere. */
    var fxFallback = new Set();
    var fxMissing = new Set();

    function num(v) {
      if (v && typeof v === 'object') v = v.amount != null ? v.amount : v.price;
      var n = typeof v === 'string' ? parseFloat(v) : v;
      return typeof n === 'number' && isFinite(n) ? n : null;
    }

    function rateTable(blob) {
      var r = blob && blob.currency_data && blob.currency_data.rates;
      return r && num(r.USD) === 1 ? r : null;
    }

    /* Returns the USD figure AND where the rate came from, so a guess never
       gets displayed as though it were Bandcamp's own number.

       Both rate tables are USD-per-unit-of-currency, so both MULTIPLY. That
       is the same direction as the FX literals above (GBP 1.27 = one pound is
       $1.27), and it is what currency_data.rates holds too: ground truth from
       a checkout page is 11.00 AUD = $7.88, i.e. rates.AUD = 0.716. Dividing
       here inverts every non-USD row and corrupts the price sort. */
    function convert(amount, currency, rates) {
      var a = num(amount) || 0, c = currency || 'USD';
      if (c === 'USD') return {usd: a, src: 'usd'};
      if (rates && num(rates[c]) > 0) return {usd: a * num(rates[c]), src: 'live'};
      if (FX[c]) { fxFallback.add(c); return {usd: a * FX[c], src: 'table'}; }
      fxMissing.add(c); return {usd: a, src: 'none'};
    }

    function itemPrice(it) {
      var pd = it.player_data || {};
      var cur = it.currency || pd.currency || 'USD';
      var amt = null;
      var cands = [it.price, pd.price, pd.album && pd.album.price];
      for (var i = 0; i < cands.length && amt === null; i++) {
        amt = num(cands[i]);
        if (amt !== null && cands[i] && typeof cands[i] === 'object' && cands[i].currency) cur = cands[i].currency;
      }
      var kind = 'set';
      if (it.is_purchasable === false) kind = 'unavailable';
      else if (it.is_set_price === false) kind = 'nyp';
      else if (amt === null) kind = 'unknown';
      return {amount: amt === null ? 0 : amt, currency: cur, kind: kind};
    }

    function needsLookup(p, it) {
      return p.kind !== 'set' || !(p.amount > 0) || it.item_type === 'package';
    }

    function detailsPrice(d, prev) {
      if (!d || d.error) return {amount: prev.amount, currency: prev.currency, kind: prev.amount > 0 ? prev.kind : 'unknown'};
      var amt = num(d.price), cur = d.currency || prev.currency;
      if (amt === null) return {amount: prev.amount, currency: prev.currency, kind: 'unknown'};
      if (d.is_purchasable === false) return {amount: amt, currency: cur, kind: d.free_download ? 'free' : 'unavailable'};
      if (amt <= 0) return {amount: 0, currency: cur, kind: 'free'};
      return {amount: amt, currency: cur, kind: d.is_set_price === false ? 'nyp' : 'set'};
    }

    function label(p) {
      if (p.kind === 'unknown') return 'price unknown';
      if (p.kind === 'unavailable') return 'not for sale';
      if (p.kind === 'free') return 'free / name your price';
      var s = p.currency === 'USD' ? '$' + p.amount.toFixed(2) : p.amount.toFixed(2) + ' ' + p.currency;
      return s + (p.kind === 'nyp' ? '+' : '');
    }

    function rank(p) {
      if (p.kind === 'unavailable') return 1;
      if (p.kind === 'unknown') return 2;
      return 0;
    }

    function csvCell(s) {
      return '"' + ('' + (s == null ? '' : s)).replace(/"/g, '""') + '"';
    }

    var status = document.getElementById('wl-status');
    if (status) status.remove();
    status = document.createElement('div');
    status.id = 'wl-status';
    status.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;background:#1da0c3;color:#fff;padding:10px 14px;border-radius:6px;font:13px monospace;box-shadow:0 4px 24px rgba(0,0,0,.4)';
    status.textContent = 'Loading wishlist...';
    document.body.appendChild(status);

    var blob = JSON.parse(document.getElementById('pagedata').getAttribute('data-blob'));
    var fan = blob.fan_data.fan_id;
    var tok = blob.wishlist_data.last_token;
    var rates = rateTable(blob);

    var all = new Map();
    var keyOf = function (it) { return (it.item_type || 'x') + '-' + (it.item_id != null ? it.item_id : it.tralbum_id); };
    var addAll = function (list) { (list || []).forEach(function (it) { all.set(keyOf(it), it); }); };
    addAll(Object.values(blob.item_cache.wishlist || {}));

    for (var i = 0; i < 100; i++) {
      var r = await fetch('/api/fancollection/1/wishlist_items', {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({fan_id: fan, older_than_token: tok, count: 40})});
      var d = await r.json();
      addAll(d.items);
      status.textContent = 'Loading wishlist... ' + all.size + ' items';
      if (!d.more_available || !d.last_token) break;
      tok = d.last_token;
    }

    var items = Array.from(all.values());
    var rows = items.map(function (it) {
      return {it: it, artist: it.band_name, title: it.item_title, url: it.item_url, price: itemPrice(it)};
    });

    /* Items whose price is already usable straight off the page never get a
       second request — that gap is why "looked up" is always below the total. */
    var todo = rows.filter(function (row) { return needsLookup(row.price, row.it); });
    var cached = rows.length - todo.length;
    var done = 0;
    status.textContent = 'Checking ' + todo.length + ' unpriced items...';

    var fetchDetails = async function (it) {
      var tt = it.tralbum_type || (it.item_type === 'track' ? 't' : 'a');
      if (tt === 'p') tt = 'a';
      var tid = it.tralbum_id != null ? it.tralbum_id : it.item_id;
      if (tid == null) return null;
      var bid = it.band_id != null ? it.band_id : 1;
      var res = await fetch('/api/mobile/25/tralbum_details?band_id=' + bid + '&tralbum_id=' + tid + '&tralbum_type=' + tt, {credentials: 'include'});
      if (!res.ok) return null;
      return await res.json();
    };

    var next = 0;
    var worker = async function () {
      while (next < todo.length) {
        var row = todo[next++];
        try {
          row.price = detailsPrice(await fetchDetails(row.it), row.price);
        } catch (e) {
          row.price = {amount: row.price.amount, currency: row.price.currency, kind: 'unknown'};
        }
        done++;
        status.textContent = 'Checking prices... ' + done + ' of ' + todo.length;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

    rows.forEach(function (row) {
      var c = convert(row.price.amount, row.price.currency, rates);
      row.usd = +c.usd.toFixed(2);
      row.fx = c.src;
    });

    rows.sort(function (a, b) {
      return rank(a.price) - rank(b.price) || a.usd - b.usd || (a.artist || '').localeCompare(b.artist || '');
    });

    var csv = 'rank,price,currency,usd_est,fx_source,price_type,artist,title,url\n' + rows.map(function (row, n) {
      return [n + 1, row.price.amount, row.price.currency, row.usd, row.fx, row.price.kind, csvCell(row.artist), csvCell(row.title), csvCell(row.url)].join(',');
    }).join('\n');
    var csvUrl = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));

    var list = rows.map(function (row, n) {
      var money = label(row.price);
      if (row.price.currency !== 'USD' && (row.price.kind === 'set' || row.price.kind === 'nyp')) {
        money += row.fx === 'none' ? ' (no FX rate)' : ' (~$' + row.usd.toFixed(2) + (row.fx === 'table' ? '?' : '') + ')';
      }
      return (n + 1) + '. ' + money + '  ' + row.artist + ' - ' + row.title;
    }).join('\n');

    var unknown = rows.filter(function (row) { return row.price.kind === 'unknown'; });

    /* Say what each number actually counts. "looked up" alone reads as
       "found only this many of the total", which it never meant. */
    var notes = [
      cached + ' priced from page data',
      todo.length + ' needed a lookup',
      unknown.length + ' still unknown',
      '+ means "or more"'
    ];
    if (!rates) notes.push('no live FX rates — USD est. from built-in table');
    else if (fxFallback.size) notes.push('built-in FX rate used for ' + Array.from(fxFallback).join(', ') + ' (marked ?)');
    if (fxMissing.size) notes.push('no FX rate at all for ' + Array.from(fxMissing).join(', '));

    status.remove();
    var old = document.getElementById('wl-export');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'wl-export';
    box.style.cssText = 'position:fixed;top:20px;right:20px;width:560px;max-height:85vh;overflow:auto;background:#fff;color:#000;z-index:99999;border:2px solid #1da0c3;border-radius:8px;padding:12px;font:13px/1.4 monospace;box-shadow:0 4px 24px rgba(0,0,0,.4)';
    box.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><b>Wishlist &mdash; ' + rows.length + ' items</b><span><a href="' + csvUrl + '" download="bandcamp-wishlist.csv" style="margin-right:10px">CSV</a><a id="wl-dbg" href="javascript:void 0" style="margin-right:10px">Debug</a><a id="wl-x" href="javascript:void 0">&times;</a></span></div><div id="wl-notes" style="margin-bottom:8px;color:#555"></div><pre style="white-space:pre-wrap;margin:0"></pre>';
    box.querySelector('#wl-notes').textContent = notes.join(' · ');
    box.querySelector('pre').textContent = list;
    box.querySelector('#wl-x').onclick = function (e) { e.preventDefault(); box.remove(); URL.revokeObjectURL(csvUrl); };
    box.querySelector('#wl-dbg').onclick = function (e) {
      e.preventDefault();
      var sample = unknown.slice(0, 5).map(function (row) { return row.it; });
      navigator.clipboard.writeText(JSON.stringify(sample, null, 1));
      e.target.textContent = 'Copied';
    };
    document.body.appendChild(box);
  } catch (e) {
    alert('Wishlist export failed: ' + e.message);
  }
})();
