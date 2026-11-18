// Gold_finger — analyse d'une capture de graphique.
// Même démarche que le "Pro Analyzer" de Gold AI Trader (réécrite) :
//   passe 1 = l'IA LIT le graphique (axe, dernier prix, sommets/creux, zones) sans donner d'avis
//   passe 2 = l'IA construit le plan à partir de cette lecture + contexte en direct (9 grilles de lecture, 6 portes qualité)
//   passe 3 = deuxième avis indépendant ; désaccord -> WAIT
//   puis le CODE vérifie : axe du graphique, côté du SL/TP, type d'ordre, nombre réel de confluences,
//   OB/FVG réellement présents en direct, dérive du prix, TP resserrés, obstacles, TP1 rapide, R:R, ATR, moteur en direct, news.
(function (G) {
  'use strict';
  const rnd = v => v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
  const num = v => (v == null || v === '' || isNaN(+v)) ? null : +v;
  const dirOf = s => (s || '').includes('BUY') ? 1 : (s || '').includes('SELL') ? -1 : 0;

  // ---------------------------------------------------------------- prompts
  const EXTRACT = `Tu es un instrument de lecture de graphique, PAS un analyste. Extrais UNIQUEMENT ce qui est visible sur cette capture. Aucun avis, aucun signal, aucune entrée.
Règles :
- Lis chaque prix sur l'AXE DES PRIX ; n'estime jamais un nombre que l'axe ne permet pas de lire.
- axisMin / axisMax = plus bas et plus haut prix écrits sur l'axe.
- lastClose = clôture de la dernière bougie complète à droite (ou l'étiquette de prix si le graphique en affiche une).
- Tous les nombres de swingHighs, swingLows, supportLevels, resistanceLevels doivent être entre axisMin et axisMax.
- Si c'est flou, coupé ou ambigu : ne devine pas, laisse le tableau vide et décris le problème dans uncertainties.
- readable = false si l'axe est illisible, si ce n'est pas un graphique de prix, ou s'il y a moins de 10 bougies.
- structure : décris littéralement les sommets/creux (ex. « sommets et creux plus hauts depuis la gauche »).
- indicators : seulement ceux dessinés (nom + ce qu'ils montrent).
- instrument / timeframe : recopie les étiquettes du graphique, sinon "unknown".
- drawnZones : rectangles, lignes, Fibonacci tracés par le trader, avec leurs prix tels qu'affichés.
- recentPriceAction : 1-2 phrases factuelles sur les ~8 dernières bougies.
Réponds UNIQUEMENT en JSON :
{"readable":bool,"instrument":"","timeframe":"","axisMin":nombre,"axisMax":nombre,"lastClose":nombre,"structure":"","swingHighs":[nombres],"swingLows":[nombres],
"supportLevels":[nombres],"resistanceLevels":[nombres],"indicators":[""],"drawnZones":[""],"recentPriceAction":"","uncertainties":[""]}`;

  const decidePrompt = (ex, ctx, newsRules) => `Tu es un trader-analyste d'élite sur ${Marches.get().name}. L'utilisateur ne veut PAS « quoi faire à la seconde » : il veut la MEILLEURE entrée que ce graphique propose, même si le prix doit d'abord y aller.
Une passe de lecture vérifiée a déjà extrait les faits du graphique. Construis le plan à partir de CES faits + le contexte en direct. L'image est jointe seulement pour vérifier : n'invente jamais un niveau absent de l'extraction et de l'axe.

=== LECTURE VÉRIFIÉE (passe 1) ===
${JSON.stringify(ex)}

=== CONTEXTE EN DIRECT (la capture peut être plus ancienne que le prix actuel) ===
${ctx}${newsRules}

MÉTHODE — passe le graphique par TOUTES ces grilles et utilise celles que le graphique confirme vraiment :
1. Structure : HH/HL ou LH/LL, cassure de structure (BOS), changement de caractère (CHoCH), biais dominant, prix en zone chère (> 50 % du range) ou bon marché (< 50 %).
2. Zones d'offre/demande et order blocks (dernière bougie opposée avant une impulsion qui casse la structure).
3. FVG / déséquilibres non comblés.
4. Liquidité : sommets/creux égaux, anciens extrêmes, mèches de chasse aux stops — et si elle a déjà été prise.
5. Fibonacci : retracement de la dernière impulsion (0,5 / 0,618 / 0,705 / 0,786 = zone OTE) et extensions (1,272 / 1,618) pour les cibles.
6. Niveaux classiques : supports/résistances inversés, chiffres ronds, obliques/canaux, figures (drapeau, biseau, triangle, ETE, double sommet/creux) et leurs retests.
7. Bougies aux niveaux : avalement, pin bar/mèche de rejet, élan ou essoufflement.
8. Indicateurs SEULEMENT s'ils sont dessinés — en confluence supplémentaire, jamais seuls.
9. Timing selon le contexte : sessions Londres/New York et news importantes.

CHOIX DE L'ENTRÉE :
- UNE entrée principale : le niveau avec le plus de confluences dans le sens du biais dominant (ou un retournement clair). Être loin du prix n'est PAS une raison d'abandonner : c'est le rôle d'un ordre en attente.
- orderType : MARKET seulement si le prix est DÉJÀ dans la zone idéale avec rejet/confirmation. BUY_LIMIT = achat sur repli, entrée SOUS lastClose (${ex.lastClose}). SELL_LIMIT = vente sur rebond, entrée AU-DESSUS. BUY_STOP = achat sur cassure, entrée AU-DESSUS. SELL_STOP = vente sur cassure, entrée EN DESSOUS. NONE uniquement avec WAIT.
- entry = prix exact de l'ordre ; entryZoneLow/High = zone serrée qui contient entry.
- entryConfluences : chaque raison INDÉPENDANTE au niveau d'entrée, avec son prix. Il en faut au moins 2 ; 3+ = entrée de qualité. UNE ligne = UNE raison : ne fusionne jamais deux raisons avec « et », « + » ou des virgules.
- strategiesUsed : noms courts des méthodes utilisées (Order Block, FVG, Fib OTE, Chasse de liquidité, S/R inversé…).
- stopLoss : juste au-delà de l'invalidation de la zone / structure, avec une petite marge pour les mèches et le spread ; aussi serré que la structure le permet honnêtement ; jamais élargi pour améliorer le R:R.
- Cibles COURTES et ATTEIGNABLES : TP1 = juste AVANT le premier obstacle (OB/FVG opposé, sommet/creux, liquidité, S/R, chiffre rond), environ 1,0 à 1,5 × le risque (1,0 minimum, sinon WAIT). TP2 = obstacle suivant, ≤ 2,2 × le risque. TP3 = optionnel, ≤ 3,2 ×, seulement si le chemin est libre. R:R mesuré DEPUIS l'entrée.
- WAIT (orderType NONE) seulement si : graphique illisible, pas ${Marches.get().name}, capture clairement périmée, ou aucun niveau avec 2 confluences ET un TP1 ≥ 1,0 R. Dans ce cas, waitPlan dit précisément ce que le prix doit faire pour créer un setup.

PORTES QUALITÉ (si une porte échoue, corrige le plan ou réponds WAIT) :
1. Sens : AVEC la structure dominante. Un contre-tendance exige un CHoCH/BOS confirmé au niveau, confiance ≤ 70.
2. Emplacement : acheter seulement en zone bon marché (< 50 % du range actif), vendre seulement en zone chère. Pas d'entrée au milieu du range.
3. Liquidité : de préférence juste après une prise de liquidité ; jamais droit dans une liquidité non prise juste devant le trade.
4. Stop : au-delà de la vraie invalidation, pas touché par les mèches ordinaires visibles.
5. Chemin : pas de niveau opposé fort entre l'entrée et TP1 ; sinon TP1 se place devant.
6. Autocritique : écris dans strongestCounterArgument la meilleure raison d'échec. Si elle est décisive, WAIT ; sinon baisse la confiance d'au moins 5 points.

RÈGLES DURES :
- Tout nombre (entry, zone, stopLoss, tp1..3, niveaux) doit être entre axisMin (${ex.axisMin}) et axisMax (${ex.axisMax}) et justifié par la lecture ou l'axe.
- Si readable = false ou si les incertitudes empêchent de lire les prix : WAIT, confiance ≤ 30.
- Si la plage de prix du graphique ne contient pas plausiblement le prix actuel de ${Marches.get().name} (voir contexte) : dis-le dans riskNotes et réponds WAIT.
- Calibrage de la confiance, strict : 85-97 seulement avec 4+ confluences indépendantes ; 75-88 avec 3 ; 60-74 avec 2 ; moins de 2 = WAIT.
- Un désaccord avec le moteur en direct baisse un peu la confiance mais n'annule pas un ordre en attente. Si une news importante est imminente ou vient de sortir, dis dans riskNotes de placer l'ordre après l'annonce ou de l'annuler avant.
- reasoning : 4-6 phrases en français, chacune avec une confluence concrète, son niveau ou un risque concret.
- keyObservations : chaque élément cite un prix ou un comportement de bougie de la lecture.
- decisionSteps : 6-8 objets {title, detail} dans cet ordre : Lecture, Biais et structure, Emplacement, Entrée — pourquoi ce niveau, Stop — pourquoi ici, Cibles — pourquoi celles-ci, Risques et contre-argument, Confiance — comment elle est comptée. 1-2 phrases concrètes avec des prix réels.
- rejectedAlternatives : 1-3 autres setups envisagés et pourquoi ils sont rejetés.
- waitPlan, confirmation, cancelIf, altScenario, riskNotes : en français simple avec des prix réels (waitPlan = ce que le prix doit faire avant d'entrer ; confirmation = signal à attendre en M1/M5/M15 dans la zone ; cancelIf = ce qui annule l'idée avant déclenchement ; altScenario = que faire si le prix casse dans l'autre sens).
Réponds UNIQUEMENT en JSON :
{"signal":"BUY|SELL|WAIT","orderType":"MARKET|BUY_LIMIT|SELL_LIMIT|BUY_STOP|SELL_STOP|NONE","entry":nombre|null,"entryZoneLow":nombre|null,"entryZoneHigh":nombre|null,
"stopLoss":nombre|null,"tp1":nombre|null,"tp2":nombre|null,"tp3":nombre|null,"confidence":0-100,"trend":"","entryConfluences":[""],"strategiesUsed":[""],
"supportLevels":[nombres],"resistanceLevels":[nombres],"reasoning":"","keyObservations":[""],"decisionSteps":[{"title":"","detail":""}],"rejectedAlternatives":[""],
"strongestCounterArgument":"","waitPlan":"","confirmation":"","cancelIf":"","altScenario":"","riskNotes":""}`;

  function newsRules(cal, now) {
    const up = (cal || []).filter(e => e.impact === 'High' && Marches.get().news.includes(e.country)).map(e => ({ e, m: Math.round((new Date(e.date) - now) / 60e3) }))
      .filter(x => x.m > -Moteur.CFG.newsPostMin && x.m < 360).slice(0, 3);
    if (!up.length) return '';
    return '\n\n=== NEWS (obligatoire) ===\n' + up.map(x => `- ${x.e.title} : ${x.m > 0 ? 'dans ' + x.m + ' min' : (-x.m) + ' min après'} (prévu ${x.e.forecast || 'n/a'}, précédent ${x.e.previous || 'n/a'})`).join('\n') +
      '\nRègles : (1) tiens compte de ces annonces et cite-les dans reasoning. (2) À moins de 45 min d\'une annonce, préfère un ordre en attente loin du prix, dis dans waitPlan et cancelIf de l\'annuler si le prix le traverse avant l\'annonce, et jamais d\'entrée au marché dans les 10 min avant. (3) Stop assez large pour la volatilité des news (au moins 1,4 × ATR). (4) Si l\'annonce est sortie (voir MODE NEWS dans le contexte), utilise le chiffre publié vs prévu, le biais et la réaction : suis la réaction confirmée.\n';
  }

  function toPlan(d, ex) {
    const r = {
      signal: (String(d.signal || 'WAIT').toUpperCase().match(/BUY|SELL/) || ['WAIT'])[0], orderType: String(d.orderType || 'NONE').toUpperCase(),
      entryPrice: num(d.entry), entryZoneLow: num(d.entryZoneLow), entryZoneHigh: num(d.entryZoneHigh), stopLoss: num(d.stopLoss),
      tp1: num(d.tp1), tp2: num(d.tp2), tp3: num(d.tp3), confidence: Math.max(0, Math.min(100, Math.round(+d.confidence || 0))),
      trend: d.trend || '', entryConfluences: (d.entryConfluences || []).filter(Boolean), strategiesUsed: d.strategiesUsed || [],
      supportLevels: (d.supportLevels || []).map(num).filter(x => x != null), resistanceLevels: (d.resistanceLevels || []).map(num).filter(x => x != null),
      reasoning: d.reasoning || '', keyObservations: d.keyObservations || [], decisionSteps: d.decisionSteps || [], rejectedAlternatives: d.rejectedAlternatives || [],
      strongestCounterArgument: d.strongestCounterArgument || '', waitPlan: d.waitPlan || '', confirmation: d.confirmation || '', cancelIf: d.cancelIf || '',
      altScenario: d.altScenario || '', riskNotes: d.riskNotes || '', extract: ex, notes: [], zoneChecks: [],
    };
    if (r.signal === 'WAIT') r.orderType = 'NONE';
    return r;
  }

  // ---------------------------------------------------------------- deux avis -> un seul
  function reconcile(a, b) {
    const da = dirOf(a.signal), db = dirOf(b.signal);
    if (da !== db) {
      const out = da === 0 ? b : a;
      out.notes.push(`🔬 Double vérification : deux lectures indépendantes donnent ${a.signal} et ${b.signal} — pas d'accord, signal passé en WAIT (graphique ambigu ou setup faible).`);
      out.signal = 'WAIT'; out.orderType = 'NONE'; out.confidence = Math.min(35, Math.round(out.confidence * 0.5)); out.selfCheck = `désaccord (${a.signal} / ${b.signal})`;
      return out;
    }
    const same = a.entryPrice == null || b.entryPrice == null || Math.abs(a.entryPrice - b.entryPrice) / Math.abs(a.entryPrice) <= 0.0015;
    if (same) {
      const avg = (x, y) => x != null && y != null ? rnd((x + y) / 2) : (x != null ? x : y);
      ['entryPrice', 'entryZoneLow', 'entryZoneHigh', 'stopLoss', 'tp1', 'tp2', 'tp3'].forEach(k => a[k] = avg(a[k], b[k]));
      if ((!a.orderType || a.orderType === 'NONE') && b.orderType && b.orderType !== 'NONE') a.orderType = b.orderType;
      a.confidence = Math.min(97, Math.round(a.confidence / 2 + b.confidence / 2) + 5);
      a.selfCheck = `accord (${a.signal})`;
      a.notes.push('🔬 Double vérification : deux lectures indépendantes d\'accord sur le sens et l\'entrée — niveaux = leur moyenne.');
      return a;
    }
    const [best, other] = a.confidence >= b.confidence ? [a, b] : [b, a];
    best.confidence = Math.round((a.confidence + b.confidence) / 2 * 0.9);
    best.selfCheck = 'même sens, entrée différente';
    best.notes.push(`🔬 Double vérification : même sens (${best.signal}) mais entrées différentes (${best.entryPrice} / ${other.entryPrice}). Plan affiché = la lecture la plus sûre ; l'autre entrée peut être un autre bon niveau.`);
    return best;
  }

  // ---------------------------------------------------------------- contrôles par le code
  function checkAxis(r) {
    const ex = r.extract; if (!ex || ex.axisMin == null || ex.axisMax == null) return;
    const lo = Math.min(ex.axisMin, ex.axisMax), hi = Math.max(ex.axisMin, ex.axisMax), pad = (hi - lo) * 0.02, inR = v => v >= lo - pad && v <= hi + pad;
    const inst = String(ex.instrument || '').trim();
    if (inst && !/unknown/i.test(inst) && !Marches.get().alias.test(inst)) {
      r.notes.push(`🚫 Le graphique « ${inst} » ne correspond pas au marché choisi (${Marches.get().short}) — signal passé en WAIT. Change de marché en haut de la page.`); r.signal = 'WAIT'; r.confidence = Math.min(25, r.confidence);
    }
    if (ex.readable === false) { r.notes.push('🚫 La passe 1 juge le graphique illisible — tout plan serait une supposition.'); r.signal = 'WAIT'; r.confidence = Math.min(25, r.confidence); }
    ['entryPrice', 'entryZoneLow', 'entryZoneHigh', 'stopLoss', 'tp1', 'tp2', 'tp3'].forEach(k => {
      if (r[k] != null && !inR(r[k])) { r.notes.push(`🚫 ${k} (${r[k]}) hors de l'axe du graphique (${lo} → ${hi}) : nombre inventé, retiré.`); r[k] = null; }
    });
    ['supportLevels', 'resistanceLevels'].forEach(k => { const n0 = r[k].length; r[k] = r[k].filter(inR); if (r[k].length < n0) r.notes.push(`🚫 ${n0 - r[k].length} niveau(x) hors de l'axe retiré(s).`); });
    if (r.entryPrice == null && r.signal !== 'WAIT') { r.notes.push('🚫 Plus d\'entrée valable lue sur le graphique — WAIT.'); r.signal = 'WAIT'; r.confidence = Math.min(30, r.confidence); }
    if ((ex.uncertainties || []).filter(Boolean).length) { r.confidence = Math.round(r.confidence * 0.9); r.notes.push(`ℹ️ La passe 1 a noté ${ex.uncertainties.length} point(s) peu clair(s) — confiance un peu réduite.`); }
  }

  function checkSides(r) {
    if (r.signal === 'WAIT' || r.entryPrice == null) return;
    const d = dirOf(r.signal), e = r.entryPrice, ahead = v => (v - e) * d > 0;
    if (r.stopLoss != null && ahead(r.stopLoss)) { r.notes.push(`🔧 SL ${r.stopLoss} du mauvais côté de l'entrée — retiré.`); r.stopLoss = null; }
    const tps = ['tp1', 'tp2', 'tp3'].map(k => r[k]).filter(v => v != null && ahead(v)).sort((a, b) => (a - b) * d);
    const removed = ['tp1', 'tp2', 'tp3'].filter(k => r[k] != null).length - tps.length;
    if (removed) r.notes.push(`🔧 ${removed} TP du mauvais côté de l'entrée retiré(s).`);
    [r.tp1, r.tp2, r.tp3] = [tps[0] ?? null, tps[1] ?? null, tps[2] ?? null];
    if (r.tp1 == null) { r.notes.push('🚫 Aucun TP valable — WAIT.'); r.signal = 'WAIT'; }
  }

  function ensureStop(r, atr) {
    if (r.signal === 'WAIT' || r.entryPrice == null || r.stopLoss != null) return;
    const dist = atr ? atr * 1.5 : r.entryPrice * 0.006;
    r.stopLoss = rnd(r.entryPrice - dirOf(r.signal) * dist); r.slIsFallback = true;
    r.notes.push(`🛠️ Pas de SL donné par l'IA : SL automatique à ~${atr ? '1,5 × ATR' : '0,6 %'} de l'entrée. Il n'est PAS basé sur la structure — vérifie-le et place-le derrière le dernier sommet/creux visible.`);
  }

  function fixOrderType(r, live, atr) {
    if (r.signal === 'WAIT' || r.entryPrice == null) { r.orderType = 'NONE'; return; }
    const buy = dirOf(r.signal) > 0, e = r.entryPrice;
    if (r.entryZoneLow != null && r.entryZoneHigh != null) {
      if (r.entryZoneLow > r.entryZoneHigh) [r.entryZoneLow, r.entryZoneHigh] = [r.entryZoneHigh, r.entryZoneLow];
      const pad = e * 0.0002;
      if (e < r.entryZoneLow - pad || e > r.entryZoneHigh + pad) { r.entryZoneLow = r.entryZoneHigh = null; r.notes.push('ℹ️ La zone d\'entrée ne contenait pas l\'entrée — zone retirée.'); }
    } else r.entryZoneLow = r.entryZoneHigh = null;
    const lc = num(r.extract && r.extract.lastClose), ref = lc != null && lc > 0 ? lc : live;
    if (ref == null) { if (r.orderType === 'NONE') r.orderType = 'MARKET'; return; }
    const d = e - ref, tol = ref * 0.0003;
    let geo = Math.abs(d) <= tol ? 'MARKET' : buy ? (d < 0 ? 'BUY_LIMIT' : 'BUY_STOP') : (d > 0 ? 'SELL_LIMIT' : 'SELL_STOP');
    if ((r.orderType === 'MARKET' || r.orderType === 'NONE') && geo !== 'MARKET' && Math.abs(d) <= ref * 0.002) geo = 'MARKET';
    if (r.orderType && r.orderType !== 'NONE' && r.orderType !== geo) r.notes.push(`🔧 Type d'ordre corrigé : l'IA a écrit ${r.orderType.replace('_', ' ')}, mais l'entrée (${e}) est ${d < 0 ? 'sous' : d > 0 ? 'au-dessus du' : 'au'} prix du graphique (${ref}) → ${geo.replace('_', ' ')}.`);
    r.orderType = geo;
    const fresh = live != null && lc != null && Math.abs(live - lc) / lc <= 0.005;
    const disp = live != null && (lc == null || fresh) ? live : ref;
    r.refPrice = rnd(disp); r.distanceToEntry = rnd(e - disp);
    if (geo !== 'MARKET') {
      if (atr) { const n = Math.abs(e - disp) / atr; r.distanceATR = Math.round(n * 10) / 10; if (n > 6) r.notes.push(`⏳ Entrée à ~${n.toFixed(1)} × ATR du prix : elle peut mettre du temps. Si tu poses un ordre en attente, mets-lui une expiration (ex. 24 h).`); }
      if (live != null && ((geo === 'BUY_LIMIT' && live <= e) || (geo === 'SELL_LIMIT' && live >= e) || (geo === 'BUY_STOP' && live >= e) || (geo === 'SELL_STOP' && live <= e)))
        r.notes.push(`⚡ Le prix en direct (${live.toFixed(2)}) a déjà atteint ou dépassé l'entrée (${e}) depuis la capture : ne place pas l'ordre à l'aveugle, refais une capture.`);
    }
  }

  function countConfluences(r) {
    if (r.signal === 'WAIT') return;
    let n = 0, merged = 0;
    for (const it of r.entryConfluences) {
      const s = String(it), joins = (s.match(/\s(?:\+|&|and|et)\s|;|,\s*(?:the|a|an|le|la|les)?\s*\d/gi) || []).length, prices = (s.match(/\d{3,5}(?:[.,]\d+)?/g) || []).length;
      if (joins >= 1 && prices >= 2) { n += 0.5; merged++; } else n += 1;
    }
    n = Math.floor(n); r.confluenceCount = n;
    if (merged) r.notes.push(`ℹ️ ${merged} confluence(s) regroupaient plusieurs raisons sur une ligne — comptées pour ½ seulement.`);
    if (n < 2) { r.notes.push(`🚫 Seulement ~${n} confluence(s) vraiment justifiée(s) à l'entrée (2 minimum) — WAIT, setup trop faible.`); r.signal = 'WAIT'; r.orderType = 'NONE'; r.confidence = Math.min(30, r.confidence); return; }
    const cap = n >= 4 ? 97 : n === 3 ? 88 : 74;
    if (r.confidence > cap) { r.notes.push(`🔧 Confiance ramenée de ${r.confidence} % à ${cap} % : avec ~${n} confluences réelles, le calibrage n'autorise pas plus.`); r.confidence = cap; }
  }

  function findOB(c, atr) {
    const out = [];
    for (let i = 1; i < c.length - 1; i++) {
      const k = c[i], nx = c[i + 1];
      if (Math.abs(nx.close - nx.open) < atr * 0.8) continue;
      let z = null;
      if (k.close < k.open && nx.close > nx.open && nx.close > k.high) z = { type: 1, low: k.low, high: k.high };
      else if (k.close > k.open && nx.close < nx.open && nx.close < k.low) z = { type: -1, low: k.low, high: k.high };
      if (!z) continue;
      let dead = false;
      for (let j = i + 2; j < c.length && !dead; j++) dead = z.type > 0 ? c[j].close < z.low : c[j].close > z.high;
      if (!dead) out.push(z);
    }
    return out;
  }
  function findFVG(c, atr) {
    const out = [];
    for (let i = 2; i < c.length; i++) {
      const a = c[i - 2], b = c[i];
      let z = null;
      if (b.low > a.high && b.low - a.high >= atr * 0.15) z = { type: 1, low: a.high, high: b.low };
      else if (b.high < a.low && a.low - b.high >= atr * 0.15) z = { type: -1, low: b.high, high: a.low };
      if (!z) continue;
      let filled = false;
      for (let j = i + 1; j < c.length && !filled; j++) filled = z.type > 0 ? c[j].low <= z.low : c[j].high >= z.high;
      if (!filled) out.push(z);
    }
    return out;
  }
  const tfFromText = t => { const s = String(t || '').toLowerCase().replace(/\s/g, ''); return /^(m?5|5m(in)?)$/.test(s) ? '5m' : /^(m?15|15m(in)?)$/.test(s) ? '15m' : /^(h1|1h|60)$/.test(s) ? '1h' : /^(h4|4h|240)$/.test(s) ? '4h' : /^(d1|1d|d|daily)$/.test(s) ? '1d' : null; };

  async function checkZones(r, getCandles) {
    if (r.signal === 'WAIT' || r.entryPrice == null) return;
    const text = [].concat(r.entryConfluences, r.strategiesUsed).join(' | ').toLowerCase(), claims = [];
    if (/order\s*block|\bob\b/.test(text)) claims.push('OB');
    if (/\bfvg\b|fair\s*value|imbalance|déséquilibre/.test(text)) claims.push('FVG');
    if (!claims.length) return;
    const tf = tfFromText(r.extract && r.extract.timeframe), data = {};
    for (const t of (tf ? [tf] : ['15m', '1h'])) { try { const c = await getCandles(t, 200); if (c.length > 30) data[t] = c.slice(-150); } catch (e) { } }
    if (!Object.keys(data).length) { r.zoneChecks.push({ ok: null, text: `L'IA cite ${claims.join(' + ')}, mais les bougies en direct sont indisponibles pour vérifier.` }); return; }
    const d = dirOf(r.signal), e = r.entryPrice, zl = r.entryZoneLow != null ? Math.min(r.entryZoneLow, e) : e, zh = r.entryZoneHigh != null ? Math.max(r.entryZoneHigh, e) : e;
    for (const kind of claims) {
      let hit = null, hitTf = null;
      for (const [t, c] of Object.entries(data)) {
        const a = Moteur.atr(c), atr = a[a.length - 1] || 5, tol = atr * 0.3;
        const zs = (kind === 'OB' ? findOB(c, atr) : findFVG(c, atr)).filter(z => z.type === d && z.low - tol <= zh && z.high + tol >= zl)
          .sort((x, y) => Math.abs((x.low + x.high) / 2 - e) - Math.abs((y.low + y.high) / 2 - e));
        if (zs.length) { hit = zs[0]; hitTf = t; break; }
      }
      const name = (kind === 'OB' ? 'order block' : 'FVG') + (d > 0 ? ' haussier' : ' baissier');
      r.zoneChecks.push(hit ? { ok: true, text: `${name} confirmé en direct (${hitTf}) : ${rnd(hit.low)} – ${rnd(hit.high)}, près de l'entrée ${e}.` }
        : { ok: false, text: `L'IA cite un ${name} à l'entrée ${e}, mais aucun ${name} encore valide n'existe dans les bougies en direct (${Object.keys(data).join(' / ')}). Vérifie de tes yeux : l'IA peut se tromper, ou ton graphique vient d'un autre broker / d'une autre unité de temps.` });
    }
  }

  function livePriceDrift(r, live) {
    if (live == null || r.entryPrice == null || r.signal === 'WAIT') return;
    const lc = num(r.extract && r.extract.lastClose), base = lc != null && lc > 0 ? lc : r.entryPrice, pct = Math.abs(live - base) / base * 100;
    r.livePrice = rnd(live);
    if (pct > 0.5) { r.notes.push(`⚡ Capture peut-être ancienne : le prix en direct (${live.toFixed(2)}) s'écarte de ~${pct.toFixed(2)} % du dernier prix du graphique (${base}). Refais une capture avant de passer un ordre.`); r.confidence = Math.round(r.confidence * 0.85); }
  }

  function tighten(r, atr) {
    if (r.signal === 'WAIT' || r.entryPrice == null || r.stopLoss == null || r.tp1 == null) return;
    const e = r.entryPrice, d = dirOf(r.signal), risk = Math.abs(e - r.stopLoss); if (!(risk > 0)) return;
    const dist = v => (v - e) * d, put = (k, x) => r[k] = rnd(e + d * x), old = { tp1: r.tp1, tp2: r.tp2, tp3: r.tp3 }, ch = [];
    const cap1 = Math.max(risk, Math.min(risk * 1.5, atr ? atr * 2 : Infinity));
    let prev = dist(r.tp1); if (prev > cap1 * 1.08) { prev = cap1; put('tp1', prev); ch.push('tp1'); }
    for (const [k, mult, am] of [['tp2', 2.2, 3.5], ['tp3', 3.2, 5]]) {
      if (r[k] == null) continue;
      let x = dist(r[k]); const cap = Math.max(prev + risk * 0.3, Math.min(risk * mult, atr ? atr * am : Infinity));
      if (x > cap * 1.08) { x = cap; put(k, x); ch.push(k); } else if (x <= prev) { x = prev + risk * 0.5; put(k, x); ch.push(k); }
      prev = x;
    }
    if (ch.length) { r.tpTightened = ch; r.notes.push(`✂️ Cibles rapprochées (plus souvent atteintes) : ${ch.map(k => `${k.toUpperCase()} ${old[k]} → ${r[k]}`).join(', ')}.`); }
  }

  async function obstacles(r, getCandles) {
    if (r.signal === 'WAIT' || r.entryPrice == null || r.stopLoss == null || r.tp1 == null) return;
    const e = r.entryPrice, d = dirOf(r.signal), risk = Math.abs(e - r.stopLoss); if (!(risk > 0)) return;
    const lv = []; let atr = null, lo = Infinity, hi = -Infinity;
    for (const t of ['15m', '1h']) {
      try {
        const c = await getCandles(t, 200); if (c.length < 40) continue;
        const s = c.slice(-160), a = Moteur.atr(s);
        if (t === '15m') atr = a[a.length - 1];
        s.forEach(x => { lo = Math.min(lo, x.low); hi = Math.max(hi, x.high); });
        for (let i = 3; i < s.length - 3; i++) {
          let H = true, L = true;
          for (let k = 1; k <= 3; k++) { if (s[i].high <= s[i - k].high || s[i].high <= s[i + k].high) H = false; if (s[i].low >= s[i - k].low || s[i].low >= s[i + k].low) L = false; }
          if (d > 0 && H) lv.push({ p: s[i].high, src: `sommet ${t}` });
          if (d < 0 && L) lv.push({ p: s[i].low, src: `creux ${t}` });
        }
      } catch (err) { }
    }
    if (!lv.length || !atr || e < lo - 2 * atr || e > hi + 2 * atr) return;
    const far = Math.max(r.tp3 || 0, r.tp2 || 0, r.tp1), RS = Marches.get().round;
    for (let p = Math.ceil(Math.min(e, far) / RS) * RS; p <= Math.max(e, far) + RS; p += RS) lv.push({ p, src: 'chiffre rond' });
    const dist = v => (v - e) * d, buf = Math.max(0.3, atr * 0.12);
    const obs = lv.map(l => ({ ...l, d: dist(l.p) })).filter(l => l.d > risk * 0.3).sort((a, b) => a.d - b.d);
    const moved = []; let prev = 0;
    for (const k of ['tp1', 'tp2', 'tp3']) {
      if (r[k] == null) continue;
      const dk = dist(r[k]), minD = k === 'tp1' ? risk : prev + risk * 0.3;
      const blk = obs.find(o => o.d > minD + buf && o.d < dk);
      if (blk) { const nd = blk.d - buf, was = r[k]; r[k] = rnd(e + d * nd); moved.push(`${k.toUpperCase()} ${was} → ${r[k]} (devant ${blk.src} à ${rnd(blk.p)})`); prev = nd; }
      else {
        const early = obs.find(o => o.d > risk * 0.5 && o.d <= minD + buf && o.d < dk);
        if (k === 'tp1' && early && !r.pathBlocked) { r.pathBlocked = early; r.notes.push(`🚧 Un ${early.src} à ${rnd(early.p)} se trouve avant TP1 (à moins de 1 R) : le chemin peut bloquer là, pense à prendre une partie à ce niveau.`); r.confidence = Math.round(r.confidence * 0.92); }
        prev = dk;
      }
    }
    if (moved.length) { r.obstacles = moved; r.notes.push(`🚧 Cibles placées devant les obstacles (le prix cale souvent juste avant) : ${moved.join(' ; ')}.`); }
  }

  function quickTp(r, atr) {
    if (r.signal === 'WAIT' || r.entryPrice == null || r.tp1 == null) return;
    const e = r.entryPrice, d = dirOf(r.signal), d1 = (r.tp1 - e) * d; if (!(d1 > 0)) return;
    const fl = Marches.get().pip * 10, nd = Math.max(d1 * 0.5, Math.min(d1, Math.max(fl, atr ? atr * 0.2 : fl)));
    r.planned = { tp1: r.tp1, tp2: r.tp2, tp3: r.tp3 };
    r.tp3 = r.tp2; r.tp2 = r.tp1; r.tp1 = rnd(e + d * nd); r.quickTp = true;
    r.notes.push(`🎯 TP1 rapide : TP1 = moitié du premier objectif (${r.planned.tp1} → ${r.tp1}) pour être touché plus souvent ; TP2 = ancien TP1, TP3 = ancien TP2. Gestion suggérée : fermer une partie au TP1 et mettre le SL au point d'entrée.`);
  }

  function checkRR(r) {
    if (r.signal === 'WAIT' || r.entryPrice == null || r.stopLoss == null || r.tp1 == null) return;
    const risk = Math.abs(r.entryPrice - r.stopLoss); if (!(risk > 0)) return;
    const k = r.quickTp && r.tp2 != null ? 'tp2' : 'tp1', rr = Math.abs(r[k] - r.entryPrice) / risk;
    r.riskReward = Math.round(rr * 100) / 100; r.rrTp1 = Math.round(Math.abs(r.tp1 - r.entryPrice) / risk * 100) / 100;
    if (rr < 0.8) { r.notes.push(`🚫 R:R ${k.toUpperCase()} = ${rr.toFixed(2)} seulement (risque ${risk.toFixed(2)} $) : plan perdant à long terme — WAIT.`); r.signal = 'WAIT'; r.confidence = Math.min(35, r.confidence); }
    else if (rr < 1) { r.notes.push(`⚠️ R:R ${k.toUpperCase()} = ${rr.toFixed(2)} : faible, il faudrait plus de ${Math.round(100 / (1 + rr))} % de réussite juste pour être à zéro.`); r.confidence = Math.round(r.confidence * 0.8); }
  }

  function checkATR(r, atr) {
    if (!atr || r.signal === 'WAIT' || r.entryPrice == null || r.stopLoss == null) return;
    const dist = Math.abs(r.entryPrice - r.stopLoss);
    if (dist < atr * 0.5) { r.notes.push(`⚠️ SL à ${dist.toFixed(2)} $ alors que l'ATR actuel est ${atr.toFixed(2)} $ : trop serré, une seule bougie peut le toucher.`); r.confidence = Math.round(r.confidence * 0.8); }
    else if (dist > atr * 4) r.notes.push(`⚠️ SL à ${dist.toFixed(2)} $ (> 4 × ATR) : gros risque par lot, réduis la taille.`);
  }

  function fuseLive(r, live) {
    if (r.signal === 'WAIT' || !live) return;
    if (!live.signal || live.signal === 'WAIT') { r.notes.push(`ℹ️ Le moteur en direct est en WAIT (${live.reason || 'pas d\'avantage clair'}) : ce plan ne repose que sur l'image.`); r.confidence = Math.round(r.confidence * 0.92); return; }
    if (dirOf(r.signal) === dirOf(live.signal)) { r.notes.push(`✅ Confluence : le moteur en direct dit aussi ${live.signal} (${live.conf} %).`); r.confidence = Math.min(97, r.confidence + 4); }
    else if (r.orderType !== 'MARKET' && r.orderType !== 'NONE') { r.notes.push(`ℹ️ Le moteur en direct dit ${live.signal} (${live.conf} %, ${live.aligned}/3 UT), mais ce plan est un ${r.orderType.replace('_', ' ')} (entrée à un niveau, pas maintenant) : désaccord normal pour un repli/cassure, attends la confirmation au niveau.`); r.confidence = Math.round(r.confidence * 0.85); }
    else { r.notes.push(`⚠️ Conflit : l'image dit ${r.signal}, le moteur en direct dit ${live.signal} (${live.conf} %). L'un des deux a tort — attends une confirmation.`); r.confidence = Math.round(r.confidence * 0.65); }
  }

  function newsAdjust(r, np) {
    if (!np) return;
    const ni = np.intel;
    r.newsMode = { event: np.ev.title, since: Math.round(np.since), actual: ni && ni.released ? ni.actual : null, forecast: (ni && ni.forecast) || np.ev.forecast, goldBias: ni ? ni.goldBias : null, biasConfidence: ni ? ni.biasConfidence : 0 };
    if (r.signal === 'WAIT') return;
    if (np.since > -3 && np.since < 1) { r.blockedSignal = r.signal; r.signal = 'WAIT'; r.waitPlan = `📰 ${np.ev.title} est en train de sortir : aucune entrée de 3 min avant à 1 min après. Relance l'analyse ensuite.`; r.notes.push(r.waitPlan); return; }
    if (np.since < 0 && np.since > -10 && r.orderType === 'MARKET') r.notes.push(`📰 ${np.ev.title} dans ${Math.ceil(-np.since)} min : entrer au marché maintenant est risqué ; attends l'annonce ou utilise un ordre en attente loin du prix.`);
    if (ni && ni.released) {
      const b = ni.goldBias === 'BULLISH' ? 1 : ni.goldBias === 'BEARISH' ? -1 : 0;
      if (b && b !== dirOf(r.signal) && ni.biasConfidence >= 60 && (ni.surprise === 'hot' || ni.surprise === 'cool')) { r.confidence = Math.max(40, r.confidence - 10); r.notes.push(`📰 Ce plan va contre la recherche news (${ni.goldBias} ${ni.biasConfidence} %, publié ${ni.actual} vs prévu ${ni.forecast || 'n/a'}) — confiance réduite.`); }
      else if (b === dirOf(r.signal) && ni.biasConfidence >= 60) r.notes.push('📰 Le plan va dans le sens de la recherche news.');
    }
  }

  function audit(r) {
    const a = [], ex = r.extract;
    if (ex) a.push({ ok: ex.readable === false ? false : ((ex.uncertainties || []).filter(Boolean).length ? null : true), text: `Lecture : ${ex.readable === false ? 'graphique illisible' : `axe ${ex.axisMin ?? '?'} – ${ex.axisMax ?? '?'}, dernier prix ${ex.lastClose ?? '?'}`}` });
    if (r.signal === 'WAIT') { a.push({ ok: false, text: 'Aucun setup n\'a passé les portes qualité → WAIT.' }); return a; }
    const n = r.confluenceCount ?? r.entryConfluences.length;
    a.push({ ok: n >= 3 ? true : n >= 2 ? null : false, text: `Confluences à l'entrée : ${n} indépendantes (minimum 2 ; 3+ = qualité).` });
    if (r.confidenceRaw != null) a.push({ ok: r.confidence >= r.confidenceRaw ? true : null, text: `Confiance : l'IA disait ${r.confidenceRaw} % → final ${r.confidence} %. Plafond : 2 confluences → 74 %, 3 → 88 %, 4+ → 97 %.` });
    if (r.selfCheck) a.push({ ok: /^accord/.test(r.selfCheck) ? true : /^même/.test(r.selfCheck) ? null : false, text: `Deuxième avis : ${r.selfCheck}.` });
    r.zoneChecks.forEach(z => a.push(z));
    return a;
  }

  // ---------------------------------------------------------------- chaîne complète
  // env = { key, model, selfCheck, image:{mime,b64}, context, calendar, live:{price, atr, signal, conf, aligned, reason}, newsPhase, getCandles, step }
  async function run(env) {
    const step = env.step || (() => { }), img = { inline_data: { mime_type: env.image.mime, data: env.image.b64 } };
    step('Passe 1 — lecture des prix sur le graphique…');
    const ex = (await IA.json(env.key, env.model, [img, { text: EXTRACT }], 0)).json;
    step('Passe 2 — construction du plan à partir de cette lecture…');
    const prompt = decidePrompt(ex, env.context, newsRules(env.calendar, new Date()));
    const d1 = await IA.json(env.key, env.model, [img, { text: prompt }], 0);
    let r = toPlan(d1.json, ex); r.model = d1.model;
    if (env.selfCheck) {
      step('Passe 3 — deuxième avis indépendant…');
      try { r = reconcile(r, toPlan((await IA.json(env.key, env.model, [img, { text: prompt }], 0.55)).json, ex)); }
      catch (e) { r.notes.push(`⚠️ Deuxième avis impossible (${e.message}) : résultat d'une seule lecture.`); }
    }
    step('Vérifications : axe, confluences, zones en direct, R:R, ATR, obstacles, news…');
    r.confidenceRaw = r.confidence;
    const atr = env.live && env.live.atr, live = env.live && env.live.price;
    await checkZones(r, env.getCandles);
    checkAxis(r); checkSides(r); ensureStop(r, atr); fixOrderType(r, live, atr); countConfluences(r); livePriceDrift(r, live); tighten(r, atr);
    await obstacles(r, env.getCandles);
    quickTp(r, atr); checkRR(r); checkATR(r, atr); fuseLive(r, env.live); newsAdjust(r, env.newsPhase);
    if (r.signal === 'WAIT') r.orderType = 'NONE';
    r.audit = audit(r);
    return r;
  }

  G.Analyse = { run };
})(window);
