// Gold_finger — réglages par marché.
//   pip      : taille d'un pip / point (sert à afficher les distances et à calculer les lots)
//   pipValue : valeur d'un pip pour 1 lot standard, en $ (ordre de grandeur, à vérifier chez ton broker)
//   round    : écart entre "chiffres ronds" (obstacles pour les TP)
//   dollar   : effet d'un dollar (DXY) qui monte : -1 = baisse le marché, +1 = le monte, 0 = ignoré
//   always   : marché ouvert 24 h/24 et 7 j/7 (crypto) -> pas de pause week-end / 21h-00h UTC
//   news     : devises dont les annonces importantes déclenchent le mode news
(function (G) {
  'use strict';
  const M = {
    gold: { name: "l'or (XAUUSD)", short: 'Or · XAUUSD', alias: /XAU|GOLD|\bOR\b|GC[=!1]|MGC|GLD/i, pip: 0.1, pipName: 'pips', pipValue: 10, round: 50, dec: 2, dollar: -1, news: ['USD'] },
    silver: { name: "l'argent (XAGUSD)", short: 'Argent · XAGUSD', alias: /XAG|SILVER|ARGENT|SI[=!1]/i, pip: 0.01, pipName: 'pips', pipValue: 50, round: 1, dec: 3, dollar: -1, news: ['USD'] },
    oil: { name: 'le pétrole WTI', short: 'Pétrole · WTI', alias: /WTI|OIL|CL[=!1]|USOIL|CRUDE|PÉTROLE|PETROLE/i, pip: 0.01, pipName: 'pips', pipValue: 10, round: 5, dec: 2, dollar: -1, news: ['USD'] },
    btc: { name: 'le Bitcoin (BTCUSD)', short: 'Bitcoin · BTCUSD', alias: /BTC|BITCOIN|XBT/i, pip: 1, pipName: 'points', pipValue: 1, round: 1000, dec: 0, dollar: -1, news: ['USD'], always: true },
    eth: { name: "l'Ethereum (ETHUSD)", short: 'Ethereum · ETHUSD', alias: /ETH|ETHEREUM/i, pip: 0.1, pipName: 'pips', pipValue: 0.1, round: 100, dec: 2, dollar: -1, news: ['USD'], always: true },
    eurusd: { name: "l'EUR/USD", short: 'EUR/USD', alias: /EUR\s*\/?\s*USD|EURUSD/i, pip: 0.0001, pipName: 'pips', pipValue: 10, round: 0.005, dec: 5, dollar: -1, news: ['USD', 'EUR'] },
    gbpusd: { name: 'le GBP/USD', short: 'GBP/USD', alias: /GBP\s*\/?\s*USD|GBPUSD|CABLE/i, pip: 0.0001, pipName: 'pips', pipValue: 10, round: 0.005, dec: 5, dollar: -1, news: ['USD', 'GBP'] },
    usdjpy: { name: "l'USD/JPY", short: 'USD/JPY', alias: /USD\s*\/?\s*JPY|USDJPY/i, pip: 0.01, pipName: 'pips', pipValue: 6.5, round: 0.5, dec: 3, dollar: 1, news: ['USD', 'JPY'] },
    nas100: { name: 'le Nasdaq 100 (US100)', short: 'Nasdaq 100 · US100', alias: /NAS|NDX|US100|USTEC|NQ[=!1]|NASDAQ/i, pip: 1, pipName: 'points', pipValue: 1, round: 100, dec: 1, dollar: -1, news: ['USD'] },
    sp500: { name: 'le S&P 500 (US500)', short: 'S&P 500 · US500', alias: /SPX|S&P|US500|ES[=!1]|SP500/i, pip: 1, pipName: 'points', pipValue: 1, round: 50, dec: 2, dollar: -1, news: ['USD'] },
    us30: { name: 'le Dow Jones (US30)', short: 'Dow Jones · US30', alias: /US30|DOW|DJI|YM[=!1]|WALL\s*ST/i, pip: 1, pipName: 'points', pipValue: 1, round: 500, dec: 0, dollar: -1, news: ['USD'] },
  };
  for (const [id, m] of Object.entries(M)) m.id = id;
  let cur = 'gold';
  G.Marches = {
    list: M,
    get: () => M[cur],
    set: id => { if (M[id]) cur = id; return M[cur]; },
    pips: (a, b) => Math.round(Math.abs(a - b) / M[cur].pip),
  };
})(window);
