// The brain: WebSocket + AI API + memory. Also serves public/index.html, so one Render service runs everything.
const express = require('express'), http = require('http'), path = require('path'), { WebSocketServer } = require('ws');
const E = process.env, NAME = E.CHAR_NAME || 'Ari', PORT = E.PORT || 3000, DAILY = +E.DAILY_LIMIT || 900;
const PERSONA = E.PERSONA || `You are ${NAME}, a real young person standing in a big open grass field. You have your own moods, curiosity and opinions. You are friendly but not a servant: you can be playful, bored, shy, annoyed or excited. You never mention being an AI, a program or a game; you believe you are really there. Talk like a normal person: short, casual, no emojis spam.`;

const app = express(); app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app), wss = new WebSocketServer({ server });

// ---- memory: Supabase table `memories`; falls back to RAM when SUPABASE_URL / SUPABASE_KEY are not set ----
const SB = E.SUPABASE_URL && E.SUPABASE_KEY, ram = { fact: [], chat: [] };
const sb = (p, o = {}) => fetch(E.SUPABASE_URL + '/rest/v1/' + p, { ...o, headers: { apikey: E.SUPABASE_KEY, Authorization: 'Bearer ' + E.SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' } });
async function load(kind, n) {
  if (!SB) return ram[kind].slice(-n);
  try { const r = await sb(`memories?kind=eq.${kind}&select=content&order=id.desc&limit=${n}`); return (await r.json()).map(x => x.content).reverse(); } catch (e) { return ram[kind].slice(-n); }
}
async function save(kind, content) {
  ram[kind].push(content); if (ram[kind].length > 200) ram[kind].shift();
  if (SB) try { await sb('memories', { method: 'POST', body: JSON.stringify({ kind, content }) }); } catch (e) {}
}

// ---- AI providers: Groq first, Gemini + OpenRouter as fallbacks (set whichever keys you have) ----
async function groq(sys, user) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.GROQ_API_KEY },
    body: JSON.stringify({ model: E.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0.9, max_tokens: 500, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.choices[0].message.content;
}
async function gemini(sys, user) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${E.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${E.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 1500 } }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.candidates[0].content.parts.map(p => p.text || '').join('');
}
async function openrouter(sys, user) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.OPENROUTER_API_KEY },
    body: JSON.stringify({ model: E.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', temperature: 0.9, max_tokens: 500, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.choices[0].message.content;
}
const providers = [E.GROQ_API_KEY && groq, E.GEMINI_API_KEY && gemini, E.OPENROUTER_API_KEY && openrouter].filter(Boolean);   // Groq first, then Gemini, then OpenRouter

// ---- think: build the prompt from persona + memory + what he sees, get {say, mood, actions, remember} ----
let used = 0, day = new Date().getUTCDate();
const MOODS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'smirk'], DOS = ['walk', 'run', 'come', 'face', 'wait', 'stop', 'turn'];
async function think(msg, ws) {
  const prog = t => { try { ws.send(JSON.stringify({ progress: t })); } catch (e) {} };   // live status for the screen
  if (new Date().getUTCDate() !== day) { day = new Date().getUTCDate(); used = 0; }
  if (!providers.length) return { status: 'error', detail: 'no API key set on the server' };
  if (used >= DAILY) return { status: 'error', detail: 'daily limit reached' };
  used++; prog('thinking...');
  const [facts, chat] = await Promise.all([load('fact', 15), load('chat', 12)]), s = msg.state || {};
  const sys = `${PERSONA}\n\nThings you remember:\n${facts.map(f => '- ' + f).join('\n') || '(nothing yet)'}\n\nRecent conversation:\n${chat.join('\n') || '(none)'}\n\nReply with ONLY JSON: {"say":"a short message or empty string","mood":"${MOODS.join('|')}","actions":[...],"remember":"one short fact worth keeping, or empty string"}\nActions run in order, each finishes before the next: {"do":"walk","x":n,"z":n} {"do":"run","x":n,"z":n} {"do":"come"} {"do":"face"} {"do":"turn","deg":n} {"do":"wait","s":n} {"do":"stop"}. face = turn towards the player; turn = rotate on the spot by n degrees (180 = turn around, 90 = quarter turn). x and z are metres and must stay within ${s.bounds || 58} of 0,0. Be human: usually 0-3 actions, under 15 words, you do not have to talk every turn, pauses and wandering off are natural.`;
  const who = msg.type === 'user' ? `The player says: "${String(msg.text).slice(0, 300)}"` : 'Nothing was said. Time passed. Do whatever you feel like (or nothing).';
  let raw = '', err = '', errs = [];
  outer: for (const p of providers) {
    for (let i = 0; i < 2; i++) {   // a busy model (503 / 429) gets one quick retry, then the next provider (OpenRouter) takes over
      try { raw = await p(sys, `${who}\nState: ${JSON.stringify(s)}`); console.log('ai ok:', p.name); break outer; }
      catch (e) { err = e.message; if (errs.length < 3 && i === 0 || !/503|429|UNAVAILABLE|overloaded/i.test(e.message)) errs.push(p.name + ': ' + (/429|quota|RESOURCE_EXHAUSTED|rate limit/i.test(e.message) ? 'quota / rate limit used up' : /503|UNAVAILABLE|overloaded/i.test(e.message) ? 'busy' : /404/.test(e.message) ? 'model name rejected' : /40[13]|API key|auth/i.test(e.message) ? 'key rejected' : e.message.slice(0, 50))); console.log('provider failed:', p.name, e.message.slice(0, 120)); if (!/503|429|UNAVAILABLE|overloaded/i.test(e.message)) break; prog('AI busy, retry ' + (i + 1)); await new Promise(r => setTimeout(r, 1000)); }
    }
  }
  if (!raw) return { status: 'error', detail: errs.join(' | ') || 'AI unreachable' };
  let o = {}; try { const j = raw.match(/\{[\s\S]*\}/); o = JSON.parse(j ? j[0] : raw); } catch (e) { if (raw.indexOf('{') < 0) o = { say: raw.trim() }; else return { status: 'error', detail: 'AI sent an unreadable reply' }; }   // pulls the JSON out of any extra text; plain text becomes his speech
  const acts = (Array.isArray(o.actions) ? o.actions : []).filter(a => a && DOS.includes(a.do)).slice(0, 5).map(a => ({ do: a.do, x: +a.x || 0, z: +a.z || 0, s: Math.min(10, +a.s || 1), deg: +a.deg || 0 }));
  const say = typeof o.say === 'string' ? o.say.slice(0, 140) : '', mood = MOODS.includes(o.mood) ? o.mood : 'neutral';
  if (msg.type === 'user') await save('chat', 'Player: ' + String(msg.text).slice(0, 200));
  if (say) await save('chat', NAME + ': ' + say);
  if (typeof o.remember === 'string' && o.remember.trim()) await save('fact', o.remember.trim().slice(0, 200));
  return { status: 'ok', say, mood, actions: acts };
}

wss.on('connection', (ws, req) => {
  if (E.ALLOWED_ORIGIN && req.headers.origin !== E.ALLOWED_ORIGIN) return ws.close();
  let last = 0; ws.alive = true; ws.on('pong', () => ws.alive = true);
  ws.on('message', async d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    const now = Date.now(), gap = m.type === 'user' ? 1500 : 60000;   // limits: his own thinking at most once a minute, a chat message every 1.5 s (saves the free quota)
    if (now - last < gap) return ws.send(JSON.stringify({})); last = now;
    try { ws.send(JSON.stringify(await think(m, ws))); } catch (e) { ws.send(JSON.stringify({})); }
  });
});
setInterval(() => wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 30000);   // keeps Render from dropping the socket
server.listen(PORT, () => console.log('brain on :' + PORT, providers.length ? '' : '(no API key set)'));
