// Gold_finger — moteur de signaux.
// Réécriture indépendante des règles observées dans "Gold AI Trader Pro v10" :
// score d'indicateurs sur 15 min, filtre de tendance 1h/4h, 3 niveaux d'exigence, quota de 5 signaux/jour
// avec assouplissement quand on est en retard, cooldowns, SL = ATR × 1,25 (1,6 en Asie), échelle de TP.
// ⚠️ Backtest 2018-2026 de ces règles : perdant chaque année (voir ../goldai_backtest).
(function (G) {
  'use strict';

  const CFG = {
    minConf: 70, dailyCap: 5, slotHours: 3.9, forceDaily: true,
    sameCooldownMin: 30, activeHours: 4, lossCooldownMin: 45,
    newsPreMin: 45, newsPostMin: 90, newsSlMult: 1.4,
  };

  // ------------------------------------------------------------ indicateurs
  const last = a => a.length ? a[a.length - 1] : null;
  function ema(v, p) {
    if (v.length < p) return [];
    const k = 2 / (p + 1); let e = 0;
    for (let i = 0; i < p; i++) e += v[i];
    e /= p; const out = [e];
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out.push(e); }
    return out;
  }
  function rsi(v, p = 14) {
    if (v.length < p + 1) return [];
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
    let ag = g / p, al = l / p; const out = [100 - 100 / (1 + ag / (al || 1e-10))];
    for (let i = p + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p;
      out.push(100 - 100 / (1 + (al === 0 ? 100 : ag / al)));
    }
    return out;
  }
  function macdHist(v) {
    const f = ema(v, 12), s = ema(v, 26); if (!f.length || !s.length) return [];
    const off = f.length - s.length, line = s.map((x, i) => f[off + i] - x), sig = ema(line, 9);
    return sig.map((x, i) => line[line.length - sig.length + i] - x);
  }
  function trueRanges(c) {
    const tr = [];
    for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
    return tr;
  }
  function atr(c, p = 14) {
    if (c.length < p + 1) return [];
    const tr = trueRanges(c); let a = 0;
    for (let i = 0; i < p; i++) a += tr[i];
    a /= p; const out = [a];
    for (let i = p; i < tr.length; i++) { a = (a * (p - 1) + tr[i]) / p; out.push(a); }
    return out;
  }
  function supertrendDir(c, p = 10, m = 3) {
    const a = atr(c, p); if (!a.length) return null;
    let up = 0, lo = 0, dir = 1;
    for (let i = p; i < c.length; i++) {
      const at = a[i - p] || 0, mid = (c[i].high + c[i].low) / 2, nu = mid + m * at, nl = mid - m * at;
      if (i === p) { up = nu; lo = nl; }
      else { if (nu < up || c[i - 1].close > up) up = nu; if (nl > lo || c[i - 1].close < lo) lo = nl; }
      if (c[i].close > up) dir = 1; else if (c[i].close < lo) dir = -1;
    }
    return dir;
  }
  function adx(c, p = 14) {
    if (c.length < 2 * p) return { adx: 0, pdi: 0, mdi: 0 };
    const pdm = [], mdm = [], tr = trueRanges(c);
    for (let i = 1; i < c.length; i++) {
      const u = c[i].high - c[i - 1].high, d = c[i - 1].low - c[i].low;
      pdm.push(u > d && u > 0 ? u : 0); mdm.push(d > u && d > 0 ? d : 0);
    }
    let sp = 0, sm = 0, st = 0;
    for (let i = 0; i < p; i++) { sp += pdm[i]; sm += mdm[i]; st += tr[i]; }
    const dx = [];
    for (let i = p; i < pdm.length; i++) {
      sp += pdm[i] - sp / p; sm += mdm[i] - sm / p; st += tr[i] - st / p;
      const a = st ? sp / st * 100 : 0, b = st ? sm / st * 100 : 0;
      dx.push(a + b ? Math.abs(a - b) / (a + b) * 100 : 0);
    }
    let x = 0; const n = Math.min(p, dx.length);
    for (let i = 0; i < n; i++) x += dx[i];
    x /= n;
    for (let i = p; i < dx.length; i++) x = (x * (p - 1) + dx[i]) / p;
    return { adx: x, pdi: st ? sp / st * 100 : 0, mdi: st ? sm / st * 100 : 0 };
  }
  function candlePatterns(c) {
    const out = [], n = c.length; if (n < 3) return out;
    const k = c[n - 1], p = c[n - 2], q = c[n - 3];
    const body = Math.abs(k.close - k.open), rng = (k.high - k.low) || 1e-4;
    const uw = k.high - Math.max(k.open, k.close), lw = Math.min(k.open, k.close) - k.low;
    const up = k.close > k.open, dn = k.close < k.open, pUp = p.close > p.open, pDn = p.close < p.open;
    const pSmall = Math.abs(p.close - p.open) < (p.high - p.low) * 0.15;
    if (body < rng * 0.1) out.push(['Doji', 0, 3]);
    if (lw > body * 2 && uw < body * 0.5 && body > 0) out.push(['Marteau', 1, 7]);
    if (uw > body * 2 && lw < body * 0.5 && body > 0) out.push(['Étoile filante', -1, 7]);
    if (up && pDn && k.close > p.open && k.open < p.close) out.push(['Avalement haussier', 1, 8]);
    if (dn && pUp && k.close < p.open && k.open > p.close) out.push(['Avalement baissier', -1, 8]);
    if (q.close < q.open && pSmall && up && k.close > (q.open + q.close) / 2) out.push(['Étoile du matin', 1, 9]);
    if (q.close > q.open && pSmall && dn && k.close < (q.open + q.close) / 2) out.push(['Étoile du soir', -1, 9]);
    if (up && pUp && q.close > q.open && k.close > p.close && p.close > q.close) out.push(['3 soldats blancs', 1, 9]);
    if (dn && pDn && q.close < q.open && k.close < p.close && p.close < q.close) out.push(['3 corbeaux', -1, 9]);
    if (lw > rng * 0.66 && up) out.push(['Pin bar haussière', 1, 8]);
    if (uw > rng * 0.66 && dn) out.push(['Pin bar baissière', -1, 8]);
    if (body > rng * 0.9 && body > 0) out.push([up ? 'Marubozu haussier' : 'Marubozu baissier', up ? 1 : -1, 7]);
    return out;
  }
  function divergence(c, vals, lb = 30) {
    if (c.length < lb + 2 || vals.length < lb + 2) return 0;
    const s = c.slice(-lb), v = vals.slice(-lb); let hi = 0, lo = 0;
    for (let i = 0; i < s.length; i++) { if (s[i].high > s[hi].high) hi = i; if (s[i].low < s[lo].low) lo = i; }
    const h1 = hi - 5, l1 = lo - 5; if (h1 < 0 || l1 < 0) return 0;
    if (s[hi].high > s[h1].high && v[hi] < v[h1]) return -1;
    if (s[lo].low < s[l1].low && v[lo] > v[l1]) return 1;
    return 0;
  }
  function ichimokuScore(c) {
    const n = c.length; if (n < 52) return 0;
    const hh = (a, b) => Math.max(...c.slice(a, b).map(x => x.high)), ll = (a, b) => Math.min(...c.slice(a, b).map(x => x.low));
    const ten = (hh(n - 9, n) + ll(n - 9, n)) / 2, kij = (hh(n - 26, n) + ll(n - 26, n)) / 2;
    const sa = (ten + kij) / 2, sb = (hh(n - 52, n) + ll(n - 52, n)) / 2, pr = c[n - 1].close;
    const above = pr > Math.max(sa, sb), below = pr < Math.min(sa, sb);
    if (above && ten > kij) return 8; if (below && ten <= kij) return -8;
    if (above) return 4; if (below) return -4; return 0;
  }
  function trendOf(c) {
    const cl = c.map(x => x.close), a = last(ema(cl, 21)), b = last(ema(cl, 50));
    if (a == null || b == null) return 'NEUTRE';
    return a > b * 1.0005 ? 'HAUSSE' : (a < b * 0.9995 ? 'BAISSE' : 'NEUTRE');
  }

  // ------------------------------------------------------------ score des facteurs
  const BULL_WORDS = ['rally', 'surge', 'bullish', 'rise', 'gain', 'soar', 'jump', 'boost', 'demand', 'safe haven', 'tension', 'war', 'conflict', 'sanctions', 'crisis', 'rate cut', 'dovish', 'weak dollar'];
  const BEAR_WORDS = ['drop', 'fall', 'bearish', 'decline', 'plunge', 'crash', 'strong dollar', 'rate hike', 'hawkish', 'correction', 'slump'];

  function score(c, ctx) {
    const cl = c.map(x => x.close), price = last(cl), F = [];
    let bull = 0, bear = 0;
    const put = (name, s, pts, detail) => { F.push({ name, score: s, detail }); if (pts > 0) bull += pts; else bear -= pts; };
    const e9 = last(ema(cl, 9)), e21 = last(ema(cl, 21)), e50 = last(ema(cl, 50)), have200 = cl.length >= 200;
    const e200 = last(ema(cl, have200 ? 200 : Math.max(50, Math.floor(cl.length / 2))));
    if (have200 && e9 > e21 && e21 > e50 && e50 > e200) put('Tendance (EMA)', 10, 25, '9>21>50>200');
    else if (e9 > e21 && e21 > e50) put('Tendance (EMA)', 7, 18, '9>21>50');
    else if (e9 > e21) put('Tendance (EMA)', 5, 12, '9>21');
    else if (have200 && e9 < e21 && e21 < e50 && e50 < e200) put('Tendance (EMA)', -10, -25, '9<21<50<200');
    else if (e9 < e21 && e21 < e50) put('Tendance (EMA)', -7, -18, '9<21<50');
    else if (e9 < e21) put('Tendance (EMA)', -5, -12, '9<21');
    else put('Tendance (EMA)', 0, 0, 'mixte');
    const R = rsi(cl), r = last(R), rp = R.length > 1 ? R[R.length - 2] : 50;
    if (r < 30) put('RSI', 10, 15, `${r.toFixed(0)} survendu`);
    else if (r < 40) put('RSI', 6, 9, `${r.toFixed(0)}`);
    else if (r > 70) put('RSI', -10, -15, `${r.toFixed(0)} suracheté`);
    else if (r > 60) put('RSI', -6, -9, `${r.toFixed(0)}`);
    else put('RSI', r > rp ? 2 : -2, r > rp ? 4 : -4, `${r.toFixed(0)} ${r > rp ? 'monte' : 'baisse'}`);
    const M = macdHist(cl);
    if (M.length > 1) {
      const a = M[M.length - 1], b = M[M.length - 2];
      if (a > 0 && b <= 0) put('MACD', 10, 12, 'croisement haussier');
      else if (a < 0 && b >= 0) put('MACD', -10, -12, 'croisement baissier');
      else put('MACD', a > 0 ? 6 : -6, a > 0 ? 7 : -7, a.toFixed(2));
    }
    const w = cl.slice(-20), mean = w.reduce((s, x) => s + x, 0) / 20, sd = Math.sqrt(w.reduce((s, x) => s + (x - mean) ** 2, 0) / 20);
    if (price <= (mean - 2 * sd) * 1.001) put('Bollinger', 8, 10, 'bande basse');
    else if (price >= (mean + 2 * sd) * 0.999) put('Bollinger', -8, -10, 'bande haute');
    else put('Bollinger', price < mean ? -3 : 3, price < mean ? -3 : 3, price < mean ? 'sous le milieu' : 'au-dessus du milieu');
    const K = [];
    for (let i = c.length - 3; i < c.length; i++) {
      const s = c.slice(i - 13, i + 1), hi = Math.max(...s.map(x => x.high)), lo = Math.min(...s.map(x => x.low));
      K.push(hi === lo ? 50 : (c[i].close - lo) / (hi - lo) * 100);
    }
    const k = K[2], d = (K[0] + K[1] + K[2]) / 3;
    if (k < 20 && k > d) put('Stochastique', 8, 8, 'remonte de la survente');
    else if (k > 80 && k < d) put('Stochastique', -8, -8, 'redescend de la surachat');
    else put('Stochastique', k > d ? 3 : -3, k > d ? 3 : -3, `K ${k.toFixed(0)} / D ${d.toFixed(0)}`);
    const st = supertrendDir(c);
    if (st != null) put('SuperTrend', st === 1 ? 8 : -8, st === 1 ? 10 : -10, st === 1 ? 'haussier' : 'baissier');
    const A = adx(c);
    if (A.adx > 25) put('ADX', A.pdi > A.mdi ? 6 : -6, A.pdi > A.mdi ? 5 : -5, `tendance forte (${A.adx.toFixed(0)})`);
    else put('ADX', 0, 0, `faible (${A.adx.toFixed(0)})`);
    const P = candlePatterns(c); let pb = 0, ps = 0;
    for (const [, dir, s] of P) { if (dir > 0) { bull += s * 0.4; pb++; } else if (dir < 0) { bear += s * 0.4; ps++; } }
    F.push({ name: 'Figures', score: Math.max(-10, Math.min(10, (pb - ps) * 3)), detail: P.map(p => p[0]).join(', ') || 'aucune' });
    let nb = 0, ns = 0;
    for (const a of (ctx.headlines || [])) {
      const t = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
      if (BEAR_WORDS.some(x => t.includes(x))) ns++; else if (BULL_WORDS.some(x => t.includes(x))) nb++;
    }
    if (nb + ns) { const s = (nb - ns) / (nb + ns) * 10; if (s > 0) bull += 5 * nb / (nb + ns); else bear += 5 * ns / (nb + ns); F.push({ name: 'Sentiment news', score: s, detail: `${nb} haussiers / ${ns} baissiers` }); }
    else F.push({ name: 'Sentiment news', score: 0, detail: 'neutre' });
    const ds = ctx.dollarSign ?? -1;   // -1 : dollar fort = baisse (or, EUR/USD…), +1 : hausse (USD/JPY), 0 : ignoré
    if (ctx.dxy != null && ds !== 0) {
      if (ctx.dxy > 0.3) put('Dollar (DXY)', 6 * ds, 5 * ds, `+${ctx.dxy.toFixed(2)} % → ${ds < 0 ? 'pression baissière' : 'soutien'} sur ce marché`);
      else if (ctx.dxy < -0.3) put('Dollar (DXY)', -6 * ds, -5 * ds, `${ctx.dxy.toFixed(2)} % → ${ds < 0 ? 'soutien' : 'pression baissière'} sur ce marché`);
      else F.push({ name: 'Dollar (DXY)', score: 0, detail: `stable (${ctx.dxy.toFixed(2)} %)` });
    } else F.push({ name: 'Dollar (DXY)', score: 0, detail: 'indisponible' });
    const vol = c.slice(-20).map(x => x.volume || 0), vr = vol.slice(-5).reduce((s, x) => s + x, 0) / 5, vp = (vol.slice(0, 15).reduce((s, x) => s + x, 0) / 15) || 1;
    if (vr > vp * 1.4 && vp > 0) { const upv = cl.length > 20 ? price > cl[cl.length - 21] : true; put('Volume', upv ? 4 : -4, upv ? 4 : -4, 'volume en hausse'); }
    else F.push({ name: 'Volume', score: 0, detail: 'normal' });
    const hh = Math.max(...c.slice(-48).map(x => x.high)), ll = Math.min(...c.slice(-48).map(x => x.low)), pos = (price - ll) / ((hh - ll) || 1);
    if (pos < 0.2) put('Position 12 h', 3, 3, 'près des plus bas');
    else if (pos > 0.8) put('Position 12 h', -3, -3, 'près des plus hauts');
    else F.push({ name: 'Position 12 h', score: 0, detail: 'milieu' });
    const lon = ctx.uh >= 7 && ctx.uh < 16, ny = ctx.uh >= 12 && ctx.uh < 21;
    F.push({ name: 'Session', score: lon && ny ? 1 : (lon || ny ? 0 : -1), detail: lon && ny ? 'Londres + New York' : (lon || ny ? 'session active' : 'hors grandes sessions') });
    const dv = divergence(c, R);
    if (dv) put('Divergence RSI', dv * 9, dv * 12, dv > 0 ? 'haussière' : 'baissière');
    const dm = divergence(c, M);
    if (dm) put('Divergence MACD', dm * 8, dm * 10, dm > 0 ? 'haussière' : 'baissière');
    const ic = ichimokuScore(c); put('Ichimoku', ic, ic, ic > 0 ? 'au-dessus du nuage' : (ic < 0 ? 'sous le nuage' : 'dans le nuage'));
    let pv = 0, vv = 0;
    for (const x of c.slice(-48)) { const v = x.volume || 1; pv += (x.high + x.low + x.close) / 3 * v; vv += v; }
    const vw = pv / vv;
    if (price > vw * 1.001) put('VWAP', 4, 4, 'au-dessus'); else if (price < vw * 0.999) put('VWAP', -4, -4, 'en dessous'); else F.push({ name: 'VWAP', score: 0, detail: 'au niveau' });
    const look = c.slice(-12, -2), kk = c[c.length - 1], pl = Math.min(...look.map(x => x.low)), ph = Math.max(...look.map(x => x.high));
    if (kk.low < pl && kk.close > pl && kk.close > kk.open) put('Chasse de liquidité', 9, 12, 'plus bas balayés puis repris');
    else if (kk.high > ph && kk.close < ph && kk.close < kk.open) put('Chasse de liquidité', -9, -12, 'plus hauts balayés puis rejetés');
    for (let i = c.length - 3; i >= Math.max(1, c.length - 12); i--) {
      const a = c[i], b = c[i + 1];
      if (a.close < a.open && b.close > b.open && b.close > a.high) { put('Order block', 5, 5, `support ${a.high.toFixed(2)}`); break; }
      if (a.close > a.open && b.close < b.open && b.close < a.low) { put('Order block', -5, -5, `résistance ${a.low.toFixed(2)}`); break; }
    }
    const s40 = c.slice(-40), H = Math.max(...s40.map(x => x.high)), L = Math.min(...s40.map(x => x.low)), rg = (H - L) || 1;
    const near = lv => Math.abs(price - lv) / rg < 0.03;
    const fb = near(L + rg * 0.618) ? 5 : (near(L + rg * 0.5) ? 3 : (near(L + rg * 0.786) ? 2 : 0));
    if (fb) put('Fibonacci', fb, fb, 'retracement');
    return { F, bull, bear, price, atr: last(atr(c)) || 10, rsi: r, e21, e50, adx: A.adx };
  }

  // ------------------------------------------------------------ décision
  const dirOf = s => (s || '').includes('BUY') ? 'BUY' : 'SELL';

  function decide(f, mtf, st) {
    // st = { now: Date, quotaCount, history: [{t, dir, status, closedAt}], newsBlock: null|{event, mins} }
    const now = st.now, uh = now.getUTCHours() + now.getUTCMinutes() / 60, ms = now.getTime();
    const net = f.bull - f.bear, tot = f.bull + f.bear, dir = net > 0 ? 'HAUSSE' : 'BAISSE', up = net > 0;
    const aligned = ['15m', '1h', '4h'].filter(t => mtf[t] === dir).length;
    const conf = Math.min(95, (tot > 0 ? Math.round(Math.max(f.bull, f.bear) / tot * 100) : 50) + aligned * 3);
    const asia = uh < 7, agree = f.F.filter(x => up ? x.score > 0 : x.score < 0).length;
    const behind = Math.min(CFG.dailyCap, Math.floor(uh / CFG.slotHours)) - st.quotaCount;
    const relax = CFG.forceDaily && st.strict !== false ? (behind >= 2 ? 2 : (behind === 1 ? 1 : 0)) : 0;
    const minC = st.minConf || CFG.minConf;
    const out = { signal: 'WAIT', reason: '', conf, net: Math.round(net), aligned, agree, level: 0, asia, mtf, price: f.price, atr: f.atr };

    const level = lv => {
      const T = lv === 2 ? { net: 6, agree: 2, conf: Math.max(50, minC - 18), adx: 0, aligned: 0, htf: 0, hi: 85, lo: 15, ext: 99, e50: false }
        : lv === 1 ? { net: 12, agree: asia ? 4 : 3, conf: minC - 8, adx: 16, aligned: 1, htf: 1, hi: 80, lo: 20, ext: 3, e50: false }
          : { net: 20, agree: asia ? 6 : 5, conf: minC, adx: asia ? 20 : 22, aligned: 2, htf: 2, hi: 72, lo: 28, ext: 2.2, e50: true };
      const opp = up ? 'BAISSE' : 'HAUSSE';
      let why = '';
      if ((T.htf === 2 && (mtf['1h'] === opp || mtf['4h'] === opp)) || (T.htf === 1 && mtf['4h'] === opp)) why = 'tendance 1h/4h contraire';
      else if (up ? f.rsi > T.hi : f.rsi < T.lo) why = `RSI ${f.rsi.toFixed(0)} trop étiré`;
      else if (f.atr > 0 && (up ? f.price - f.e21 : f.e21 - f.price) / f.atr > T.ext) why = 'prix trop loin de l\'EMA21';
      else if (T.e50 && (up ? f.price < f.e50 : f.price > f.e50)) why = 'prix du mauvais côté de l\'EMA50';
      const ok = conf >= T.conf && aligned >= T.aligned && agree >= T.agree && !why;
      const strong = f.adx >= (asia ? 22 : 25);
      if (lv === 0 && ok && strong && net > 28 && up) return { s: 'STRONG_BUY' };
      if (lv === 0 && ok && strong && net < -28 && !up) return { s: 'STRONG_SELL' };
      if (ok && f.adx >= T.adx && net > T.net && up) return { s: 'BUY' };
      if (ok && f.adx >= T.adx && net < -T.net && !up) return { s: 'SELL' };
      if (conf < T.conf) why = `confiance ${conf}% < ${T.conf}%`;
      else if (Math.abs(net) <= T.net) why = 'facteurs trop partagés';
      else if (agree < T.agree) why = `seulement ${agree} facteurs d'accord (${T.agree} requis)`;
      else if (aligned < T.aligned) why = `${aligned}/3 unités de temps alignées`;
      else if (f.adx < T.adx) why = `ADX ${f.adx.toFixed(0)} trop faible`;
      return { s: 'WAIT', why };
    };

    let r;
    if (st.strict === false) {  // mode "souple" : seuils du score net seulement
      r = { s: net > 25 ? 'STRONG_BUY' : net > 12 ? 'BUY' : net < -25 ? 'STRONG_SELL' : net < -12 ? 'SELL' : 'WAIT', why: 'facteurs trop partagés' };
    } else {
      r = level(0);
      if (r.s === 'WAIT' && relax > 0) { const r2 = level(relax); if (r2.s !== 'WAIT') { r = r2; out.level = relax; } }
    }
    out.signal = r.s; out.reason = r.why || '';
    const wait = why => { out.signal = 'WAIT'; out.reason = why; return out; };

    const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })), wd = ny.getDay(), nh = ny.getHours();
    const closed = (wd === 5 && nh >= 17) || wd === 6 || (wd === 0 && nh < 17);
    if (closed && !st.always) return wait('marché fermé (week-end)');
    if (out.signal !== 'WAIT' && uh >= 21 && !st.always) wait('hors horaires (21h-00h UTC)');

    // mode news : de 45 min avant à 90 min après une annonce USD importante, la décision passe par newsDecide
    let newsWide = false;
    if (st.news) {
      const nd = newsDecide(st.news, f, out.signal, out.conf, out.level === 0 && st.strict !== false);
      out.signal = nd.signal; out.reason = nd.reason; out.news = nd.info;
      if (nd.conf != null) out.conf = nd.conf;
      newsWide = nd.signal !== 'WAIT';
    }
    if (out.signal === 'WAIT') return out;

    const d = dirOf(out.signal), H = st.history;
    if (st.strict !== false && !newsWide) {
      const flip = H.find(h => h.dir !== d && (ms - h.t < (out.level ? 30 : 90) * 60e3 || (!out.level && h.status === 'ACTIVE' && ms - h.t < CFG.activeHours * 36e5)));
      if (flip) return wait('signal inverse encore récent — pas de retournement rapide');
      if (out.level < 2 && H.find(h => h.status === 'LOSS' && h.closedAt && ms - h.closedAt < CFG.lossCooldownMin * 60e3)) return wait('pause de 45 min après un SL');
    }
    const running = out.level ? H.find(h => h.dir === d && ms - h.t < 90 * 60e3)
      : H.find(h => h.dir === d && (ms - h.t < CFG.sameCooldownMin * 60e3 || (h.status === 'ACTIVE' && ms - h.t < CFG.activeHours * 36e5)));
    out.running = !!running;
    const cap = CFG.dailyCap + (newsWide ? 2 : 0);
    if (st.quotaCount >= cap && !running) return wait(`quota atteint (${st.quotaCount}/${cap} aujourd'hui)`);
    out.newsWide = newsWide;

    const slDist = f.atr * (asia ? 1.6 : 1.25) * (newsWide ? CFG.newsSlMult : 1), m = asia ? [0.8, 1.4, 2.0] : [1.0, 2.0, 3.5], s = d === 'BUY' ? 1 : -1;
    const rd = x => Math.round(x * 100) / 100, d1 = slDist * m[0];
    const q1 = Math.max(d1 * 0.5, Math.min(d1, Math.max((st.pip || 0.1) * 10, f.atr * 0.2)));
    Object.assign(out, { entry: rd(f.price), sl: rd(f.price - s * slDist), tp1: rd(f.price + s * q1), tp2: rd(f.price + s * d1), tp3: rd(f.price + s * slDist * m[1]) });
    return out;
  }

  // ------------------------------------------------------------ mode news
  // n = { ev: {title, forecast, previous}, since: minutes depuis l'annonce (<0 = avant), intel: recherche IA ou null, prePrice }
  function newsDecide(n, f, techSignal, techConf, techQuality) {
    const ev = n.ev, since = n.since, ni = n.intel, atrV = f.atr || 1;
    const techDir = techQuality ? (techSignal.includes('BUY') ? 1 : techSignal.includes('SELL') ? -1 : 0) : 0;
    const bias = ni ? (ni.goldBias === 'BULLISH' ? 1 : ni.goldBias === 'BEARISH' ? -1 : 0) : 0;
    const biasConf = ni ? ni.biasConfidence : 0;
    const hasActual = !!(ni && ni.released && ni.actual);
    const info = { event: ev.title, since: Math.round(since), phase: since < 0 ? 'avant' : 'après', forecast: (ni && ni.forecast) || ev.forecast || null,
      previous: (ni && ni.previous) || ev.previous || null, actual: hasActual ? ni.actual : null, surprise: hasActual ? ni.surprise : null,
      goldBias: ni ? ni.goldBias : null, biasConfidence: biasConf, summary: ni ? ni.summary : '', sources: ni ? ni.sources : [], researching: !ni, reaction: null };
    const W = why => ({ signal: 'WAIT', conf: null, reason: why, info });
    const S = (dir, c) => { c = Math.round(Math.max(50, Math.min(92, c))); return { signal: c >= 85 ? (dir > 0 ? 'STRONG_BUY' : 'STRONG_SELL') : (dir > 0 ? 'BUY' : 'SELL'), conf: c, reason: '', info }; };

    if (since < 0) {
      const m = Math.ceil(-since);
      if (m <= 3) return W(`📰 ${ev.title} dans ${m} min — pas d'entrée juste avant l'annonce, reprise 1 min après`);
      if (techDir) {
        if (bias && bias !== techDir && biasConf >= 55) return W(`📰 ${ev.title} dans ${m} min — setup technique, mais la recherche news penche dans l'autre sens : on attend`);
        return S(techDir, Math.min(techConf, 78));
      }
      return W(`📰 ${ev.title} dans ${m} min — pas de setup fort avant l'annonce, on attend le chiffre et la réaction`);
    }
    if (since < 1) return W(`📰 ${ev.title} vient de sortir — on laisse passer la première minute`);
    if (!hasActual) {
      if (since < 25 || !ni) return W(`📰 ${ev.title} : l'IA cherche le chiffre publié (${ni ? 'pas encore trouvé' : 'recherche en cours'})`);
      if (techDir) return S(techDir, Math.min(techConf, 72));
      return W(`📰 ${ev.title} : aucun chiffre fiable trouvé et pas de setup technique`);
    }
    let react = 0;
    if (n.prePrice != null) {
      const mv = (f.price - n.prePrice) / atrV;
      react = Math.abs(mv) >= 0.3 ? Math.sign(mv) : 0; info.reaction = (mv >= 0 ? '+' : '') + mv.toFixed(2) + ' ATR';
    } else if (ni.reactionDir === 'UP' || ni.reactionDir === 'DOWN') { react = ni.reactionDir === 'UP' ? 1 : -1; info.reaction = ni.reactionDir; }
    const clear = bias && biasConf >= 50 && (ni.surprise === 'hot' || ni.surprise === 'cool');
    if (!clear) {
      if (techDir) return S(techDir, Math.min(techConf, 75));
      return W(`📰 ${ev.title} : chiffre conforme ou flou — pas d'avantage clair`);
    }
    if (react === bias) return S(bias, 0.55 * biasConf + 0.25 * techConf + (techDir === bias ? 12 : 0) + 8);
    if (react === 0) {
      if (since >= 4 && techDir !== -bias) return S(bias, Math.min(0.55 * biasConf + 0.25 * techConf + (techDir === bias ? 10 : 0), 82));
      return W(`📰 ${ev.title} : le chiffre pousse vers ${bias > 0 ? 'l\'achat' : 'la vente'} mais le prix n'a pas encore bougé`);
    }
    if (techDir === react) return S(react, Math.min(techConf, 72));
    return W(`📰 ${ev.title} : le marché va contre le chiffre — on attend une direction claire`);
  }

  // annonce USD importante la plus proche dans la fenêtre [-45 min ; +90 min]
  function newsPhase(cal, now, currencies) {
    const cur = currencies || ['USD'];
    let best = null;
    for (const e of cal || []) {
      if (!cur.includes(e.country) || e.impact !== 'High') continue;
      const since = (now - new Date(e.date)) / 60e3;
      if (isNaN(since) || since < -CFG.newsPreMin || since > CFG.newsPostMin) continue;
      if (!best || Math.abs(since) < Math.abs(best.since)) best = { ev: e, since, key: e.title + '|' + e.date };
    }
    return best;
  }

  G.Moteur = { CFG, score, decide, trendOf, dirOf, newsPhase, atr, candlePatterns };
})(window);
