// Gold_finger — appels à Google Gemini, directement depuis le navigateur avec TA clé
// (saisie dans Réglages, gardée seulement dans ce navigateur).
(function (G) {
  'use strict';
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // key = clé saisie dans ce navigateur (appel direct) ; vide = on passe par le serveur local qui a sa propre clé
  const endpoint = (key, model) => key
    ? { url: BASE + 'models/' + encodeURIComponent(model) + ':generateContent', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key } }
    : { url: '/api/ia/generate?model=' + encodeURIComponent(model), headers: { 'Content-Type': 'application/json' } };

  // fournisseur : 'gemini' (gratuit limité) ou 'claude' (API payante, clé dans cle_claude.txt côté serveur)
  let provider = 'gemini';
  const setProvider = p => { provider = p === 'claude' ? 'claude' : 'gemini'; };
  const isClaude = () => provider === 'claude';
  let claudeKey = '';   // clé Claude de l'utilisateur (gardée dans son navigateur, envoyée à chaque appel, jamais enregistrée par le serveur)
  const setClaudeKey = k => { if ((k || '') !== claudeKey) { claudeKey = k || ''; delete modelCache.claude; } };
  const claudeHeaders = () => Object.assign({ 'Content-Type': 'application/json' }, claudeKey ? { 'X-Claude-Key': claudeKey } : {});
  const CLAUDE_DEFAULT = 'claude-haiku-5-5';   // le moins cher ; Opus 5.5 / Sonnet 5.5 au choix dans Réglages

  let status = null;
  async function getStatus() {
    if (status === null) { try { status = await (await fetch('/api/ia/status')).json(); } catch (e) { status = {}; } }
    return status;
  }
  async function hasServerKey() { return !!(await getStatus()).serverKey; }
  async function ready(key, prov) { return (prov || provider) === 'claude' ? (!!claudeKey || !!(await getStatus()).claudeKey) : (!!key || await hasServerKey()); }

  // ---- Claude : tout passe par le serveur local (/api/claude), qui utilise le SDK officiel Anthropic
  async function claude(req) {
    const r = await fetch('/api/claude', { method: 'POST', headers: claudeHeaders(), body: JSON.stringify(req) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Claude : ' + (j.error?.message || ('HTTP ' + r.status)));
    return j;
  }
  const toClaudeParts = parts => parts.map(p => p.inline_data ? { image: { mime: p.inline_data.mime_type, data: p.inline_data.data } } : { text: p.text });

  // liste des modèles réellement disponibles pour cette clé (Google en retire régulièrement)
  const modelCache = {};
  async function listModels(key, prov) {
    if ((prov || provider) === 'claude') {
      if (modelCache.claude) return modelCache.claude;
      const r = await fetch('/api/claude/models', { headers: claudeHeaders() }), j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
      return (modelCache.claude = j);
    }
    const ck = key ? 'k:' + key.slice(-6) : 'server';
    if (modelCache[ck]) return modelCache[ck];
    const r = key ? await fetch(BASE + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key } }) : await fetch('/api/ia/models');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    const ver = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
    const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini/.test(n) && !/image|tts|audio|live|embedding|vision|thinking-exp|robotics|computer|nano/i.test(n));
    // flash d'abord (rapide, gros quota gratuit), puis le reste ; version la plus récente d'abord ; préversions après
    const rank = n => (/flash/.test(n) ? 0 : 1) * 1000 + (/preview|exp/.test(n) ? 500 : 0) + (/lite/.test(n) ? 100 : 0) - ver(n) * 10;
    return (modelCache[ck] = ok.sort((a, b) => rank(a) - rank(b)));
  }

  // appel brut avec repli sur d'autres modèles disponibles si celui choisi est absent / saturé
  let blockedUntil = 0, blockedMsg = '';   // quota du jour épuisé -> on n'insiste plus jusqu'à l'heure indiquée par Google
  const parseDelay = s => { const m = /(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/.exec(s || ''); return m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0; };
  async function call(key, model, body, timeoutMs = 45000) {
    if (Date.now() < blockedUntil) throw new Error(blockedMsg);
    let avail = [];
    try { avail = await listModels(key, 'gemini'); } catch (e) { if (/API key/i.test(e.message)) throw e; }
    const models = [...new Set([...(model && (!avail.length || avail.includes(model)) ? [model] : []), ...avail.slice(0, 5), 'gemini-flash-latest'])];
    let lastErr, quotaErr = null;
    const tried = [];
    for (const m of models) {
      tried.push(m);
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const ep = endpoint(key, m);
          const r = await fetch(ep.url, { method: 'POST', signal: ctl.signal, headers: ep.headers, body: JSON.stringify(body) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            const e = new Error(j.error?.message || ('HTTP ' + r.status));
            e.status = r.status;
            throw e;
          }
          const cand = j.candidates?.[0];
          const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
          if (!text) throw new Error('réponse vide (' + (cand?.finishReason || 'inconnu') + ')');
          const sources = (cand?.groundingMetadata?.groundingChunks || []).map(c => c.web && (c.web.title || c.web.uri)).filter(Boolean).slice(0, 4);
          return { text, model: m, sources };
        } catch (e) {
          lastErr = e.name === 'AbortError' ? new Error('délai dépassé') : e;
          if (lastErr.status === 400 && /API key/i.test(lastErr.message)) throw lastErr;     // mauvaise clé : inutile d'insister
          if (/no Gemini|pas de clé/i.test(lastErr.message)) throw lastErr;
          const wrongModel = lastErr.status === 404 || lastErr.status === 403 || /not found|not supported|no longer available|deprecated/i.test(lastErr.message);
          const dailyQuota = lastErr.status === 429 && /per day|PerDay|quota/i.test(lastErr.message);
          if (dailyQuota) quotaErr = lastErr;
          if (wrongModel || dailyQuota) break;
          await sleep(lastErr.status === 429 ? 1500 : 400);
        } finally { clearTimeout(to); }
      }
    }
    const e = quotaErr || lastErr || new Error('aucun modèle disponible');
    if (e.status === 429) {
      const wait = (e.message.match(/retry in ([\dhms.]+)/i) || [])[1];
      e.message = `Quota gratuit Gemini épuisé pour aujourd'hui (le plan gratuit limite le nombre de requêtes par jour et par modèle)${wait ? ' — réessaie dans ' + wait.replace(/\.\d+s$/, 's') : ''}. Solution : attendre, utiliser une autre clé, ou activer la facturation sur Google AI Studio.`;
      blockedUntil = Date.now() + Math.max(parseDelay(wait), 10 * 60e3); blockedMsg = e.message;
    }
    e.message += ` (modèles essayés : ${tried.join(', ')})`;
    throw e;
  }

  function parseJSON(text) {
    const m = text.replace(/```json\n?|```\n?/g, '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('réponse IA illisible');
    return JSON.parse(m[0]);
  }

  async function json(key, model, parts, temperature = 0, system) {
    if (isClaude()) {
      // Claude n'a pas de "température" sur les modèles récents : le deuxième avis reste indépendant car c'est un nouvel appel
      const r = await claude({ model: model || CLAUDE_DEFAULT, system: (system ? system + '\n' : '') + 'Réponds uniquement avec un objet JSON valide, sans texte autour.',
        messages: [{ role: 'user', parts: toClaudeParts(parts) }], effort: 'medium' });
      return { json: parseJSON(r.text), model: r.model };
    }
    const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature, topP: 0.1, maxOutputTokens: 6144, responseMimeType: 'application/json' } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const r = await call(key, model, body);
    return { json: parseJSON(r.text), model: r.model };
  }

  // recherche Google (outil google_search de Gemini) + réponse JSON
  // prov = IA choisie pour la recherche news (peut être différente de celle du chat)
  async function searchJSON(key, model, prompt, prov) {
    if ((prov || provider) === 'claude') {
      const r = await claude({ model: model || CLAUDE_DEFAULT, messages: [{ role: 'user', parts: [{ text: prompt + '\nUse the web_search tool to find the information.' }] }], search: true, effort: 'medium' });
      return { json: parseJSON(r.text), sources: r.sources || [], model: r.model };
    }
    const r = await call(key, model, { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } }, 40000);
    return { json: parseJSON(r.text), sources: r.sources, model: r.model };
  }

  async function test(key, model) {
    if (isClaude()) return (await claude({ model: model || CLAUDE_DEFAULT, messages: [{ role: 'user', parts: [{ text: 'Réponds juste OK.' }] }], effort: 'low' })).model;
    return (await call(key, model, { contents: [{ role: 'user', parts: [{ text: 'Réponds juste OK.' }] }] })).model;
  }

  const sysChat = () => { const m = G.Marches.get(); return `Tu es l'assistant de "Gold_finger", un outil d'analyse des marchés. Marché affiché : ${m.name}.
Réponds en français simple (ou en darija si l'utilisateur écrit en darija), court et concret, en raisonnant en ${m.pipName} (1 ${m.pipName.slice(0, -1)} = ${m.pip}).
Appuie-toi sur le CONTEXTE EN DIRECT fourni (prix, signal du moteur, facteurs, tendances, news, calendrier, mode news).
Sois honnête : le moteur de signaux a été backtesté perdant sur 2018-2026 ; ne promets jamais de gains, rappelle le risque quand on parle d'entrer.
N'invente aucun prix ni aucune news absente du contexte.`; };

  async function chat(key, model, history, context) {
    if (isClaude()) {
      const msgs = history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', parts: [{ text: m.text }] }));
      msgs[msgs.length - 1].parts[0].text = `CONTEXTE EN DIRECT :\n${context}\n\nQUESTION :\n${msgs[msgs.length - 1].parts[0].text}`;
      return claude({ model: model || CLAUDE_DEFAULT, system: sysChat(), messages: msgs, effort: 'low' });
    }
    const contents = history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
    contents[contents.length - 1].parts[0].text = `CONTEXTE EN DIRECT :\n${context}\n\nQUESTION :\n${contents[contents.length - 1].parts[0].text}`;
    return call(key, model, { systemInstruction: { parts: [{ text: sysChat() }] }, contents, generationConfig: { temperature: 0.4 } });
  }

  G.IA = { call, json, searchJSON, test, chat, ready, hasServerKey, listModels, setProvider, isClaude, setClaudeKey };
})(window);
