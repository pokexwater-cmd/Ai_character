// The brain: WebSocket + AI API + memory. Also serves public/index.html, so one Render service runs everything.
const express = require('express'), http = require('http'), path = require('path'), { WebSocketServer } = require('ws');
const E = process.env, NAME = E.CHAR_NAME || 'Ari', PORT = E.PORT || 3000, DAILY = +E.DAILY_LIMIT || 900;
const PERSONA = E.PERSONA || `You are ${NAME}, a real young person standing in a big open grass field. You have your own moods, curiosity and opinions. You are friendly but not a servant: you can be playful, bored, shy, annoyed or excited. You never mention being an AI, a program or a game; you believe you are really there. Talk like a normal person: short, casual, no emojis spam.`;

const app = express(); app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app), wss = new WebSocketServer({ server });

// ---- memory: Supabase table `character_memories`; falls back to RAM when SUPABASE_URL / SUPABASE_KEY are not set ----
const SBURL = (E.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''), SBKEY = (E.SUPABASE_KEY || E.SUPABASE_SERVICE_KEY || E.SUPABASE_SERVICE_ROLE_KEY || E.SUPABASE_ANON_KEY || '').trim();   // forgiving: trailing slash, /rest/v1 and common key names are all accepted
const TABLE = E.SUPABASE_TABLE || 'character_memories', SB = SBURL && SBKEY, ram = { fact: [], chat: [], lesson: [], skill: [], summary: [] };
const sb = (p, o = {}) => fetch(SBURL + '/rest/v1/' + p, { ...o, headers: { apikey: SBKEY, Authorization: 'Bearer ' + SBKEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' } });
async function load(kind, n) {
  if (!SB) return (ram[kind] || []).slice(-n);
  try { const r = await sb(`${TABLE}?kind=eq.${kind}&select=content&order=id.desc&limit=${n}`); const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 150)); return j.map(x => x.content).reverse(); } catch (e) { console.log('memory load failed:', kind, e.message); return (ram[kind] || []).slice(-n); }
}
async function save(kind, content) {
  (ram[kind] = ram[kind] || []).push(content); if (ram[kind].length > 200) ram[kind].shift();
  if (SB) try { const r = await sb(TABLE, { method: 'POST', body: JSON.stringify({ kind, content }) }); if (!r.ok) console.log('memory save failed:', kind, r.status, (await r.text()).slice(0, 150)); } catch (e) { console.log('memory save error:', e.message); }
}

// ---- AI providers: Groq first, Gemini + OpenRouter as fallbacks (set whichever keys you have) ----
const groqCall = key => async (sys, user, hist = []) => {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: E.GROQ_MODEL || 'openai/gpt-oss-20b', temperature: 0.9, max_tokens: 1200, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: user }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.choices[0].message.content;
};
async function gemini(sys, user, hist = []) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${E.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${E.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [...hist.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })), { role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 1500 } }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.candidates[0].content.parts.map(p => p.text || '').join('');
}
async function openrouter(sys, user, hist = []) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.OPENROUTER_API_KEY },
    body: JSON.stringify({ model: E.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', temperature: 0.9, max_tokens: 500, messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: user }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.choices[0].message.content;
}
// every env var starting with GROQ_API_KEY is a Groq key (GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3 ...); a comma list in one var also works
const groqKeys = Object.keys(E).filter(k => /^GROQ_API_KEY/i.test(k)).sort().flatMap(k => String(E[k]).split(',')).map(k => k.trim()).filter(Boolean);
// ORDER: every Groq key first -> OpenRouter -> Gemini only as the very last option
const providers = [
  ...groqKeys.map((k, n) => ({ name: 'groq#' + (n + 1), fn: groqCall(k) })),
  ...(E.OPENROUTER_API_KEY ? [{ name: 'openrouter', fn: openrouter }] : []),
  ...(E.GEMINI_API_KEY ? [{ name: 'gemini', fn: gemini }] : []),
];
const cool = {};   // provider name -> time until which it rests after hitting a limit
const rest = (name, msg) => { cool[name] = Date.now() + (/per day|daily|TPD|RPD/i.test(msg) ? 30 * 60000 : /40[13]|invalid|does not exist|access/i.test(msg) ? 10 * 60000 : 65000); };
async function memtest() {   // open https://YOUR-APP.onrender.com/memtest in a browser to see whether memory is really connected
  if (!SB) return { ok: false, why: 'RAM only', SUPABASE_URL_found: !!SBURL, key_found: !!SBKEY };
  try {
    const w = await sb(TABLE, { method: 'POST', body: JSON.stringify({ kind: 'test', content: 'ping ' + new Date().toISOString() }) }), wt = w.ok ? 'ok' : w.status + ' ' + (await w.text()).slice(0, 150);
    const r = await sb(`${TABLE}?select=id&limit=1`), rt = r.ok ? 'ok' : r.status + ' ' + (await r.text()).slice(0, 150);
    return { ok: w.ok && r.ok, table: TABLE, write: wt, read: rt, host: SBURL.replace(/^https?:\/\//, '').split('.')[0].slice(0, 4) + '...' };
  } catch (e) { return { ok: false, why: 'cannot reach Supabase: ' + e.message.slice(0, 100) }; }
}
app.get('/memtest', async (req, res) => res.json(await memtest()));
memtest().then(r => console.log('memory test:', JSON.stringify(r)));
console.log('memory:', SB ? 'Supabase table ' + TABLE : 'RAM only (SUPABASE_URL / SUPABASE_KEY not found)');
console.log('providers in order:', providers.map(p => p.name).join(' > ') || 'none');

// ---- body vocabulary: the AI may use any of these, and can INVENT new moves with the `move` action (motion numbers, clamped to safe ranges) ----
const MOODS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'smirk'], DOS = ['walk', 'run', 'come', 'face', 'wait', 'stop', 'turn', 'spin', 'jump', 'move', 'punch', 'block', 'dodge', 'shoot'];
const PK = { cps: [0, 4], duty: [0.3, 0.8], stride: [0, 30], lift: [0, 14], lean: [-0.5, 0.6], headKeep: [0, 1], bob: [0, 3], sway: [0, 2], twist: [0, 0.5], armAmp: [0, 1.5], armBend: [0, 1.2], crouch: [0, 6] };
const clean = list => (Array.isArray(list) ? list : []).filter(a => a && DOS.includes(a.do)).slice(0, 8).map(a => {
  const o = { do: a.do, x: +a.x || 0, z: +a.z || 0, s: Math.min(10, +a.s || 1), deg: +a.deg || 0 };
  if (a.do === 'move') { o.name = String(a.name || 'move').replace(/\W/g, '').slice(0, 20) || 'move'; o.p = {}; for (const k in PK) if (a.p && isFinite(+a.p[k]) && a.p[k] !== null) o.p[k] = Math.max(PK[k][0], Math.min(PK[k][1], +a.p[k])); }
  return o; });
const why = m => /429|quota|RESOURCE_EXHAUSTED|rate limit/i.test(m) ? 'quota / rate limit used up' : /503|UNAVAILABLE|overloaded/i.test(m) ? 'busy' : /404|does not exist|not have access/i.test(m) ? 'model name rejected' : /40[13]|API key|auth/i.test(m) ? 'key rejected' : m.slice(0, 60);
async function callAI(sys, user, prog = () => {}, hist = [], pref = '') {   // walks the provider chain (Groq keys > OpenRouter > Gemini), skipping resting ones
  const now0 = Date.now(), ready = providers.filter(p => (cool[p.name] || 0) <= now0), order0 = ready.length ? ready : providers, order = [...order0.filter(p => p.name === pref), ...order0.filter(p => p.name !== pref)], errs = []; let raw = '';
  outer: for (const p of order) {
    for (let i = 0; i < 2; i++) {
      try { raw = await p.fn(sys, user, hist); console.log('ai ok:', p.name); break outer; }
      catch (e) { console.log('provider failed:', p.name, e.message.slice(0, 120));
        if (/503|UNAVAILABLE|overloaded/i.test(e.message) && !/429|quota|rate limit/i.test(e.message) && i === 0) { prog('AI busy, retry'); await new Promise(r => setTimeout(r, 800)); continue; }
        errs.push(p.name + ': ' + why(e.message)); rest(p.name, e.message); break; }
    }
  }
  return { raw, errs };
}
const turns = lines => { const out = []; for (const l of lines) { const me = l.indexOf(NAME + ': ') === 0, c = me ? JSON.stringify({ say: l.slice(NAME.length + 2) }) : l.replace(/^Player: /, ''), role = me ? 'assistant' : 'user', t = out[out.length - 1]; if (t && t.role === role) t.content += '\n' + c; else out.push({ role, content: c }); } return out; };   // past chat as real alternating turns, which models follow far better than a text block
const latest = arr => { const m = new Map(); for (const x of arr) { try { const o = JSON.parse(x); if (o && o.name) m.set(o.name, o); } catch (e) {} } return [...m.values()]; };   // newest version of each skill
let used = 0, day = new Date().getUTCDate(), sinceSum = 0;
async function summarise() {   // every ~25 chat lines: fold old talk into a short summary so he remembers weeks, not minutes
  const [chat, old] = await Promise.all([load('chat', 25), load('summary', 1)]);
  const { raw } = await callAI('You condense memories. Reply with ONLY JSON: {"summary":"max 600 characters"}', `Old summary: ${old[0] || '(none)'}\nNew conversation:\n${chat.join('\n')}\nWrite one updated summary: who the player is, what they like, what was learned, promises made.`);
  try { const o = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); if (o.summary) await save('summary', String(o.summary).slice(0, 700)); } catch (e) {}
}
async function think(msg, ws) {
  const prog = t => { try { ws.send(JSON.stringify({ progress: t })); } catch (e) {} };
  if (new Date().getUTCDate() !== day) { day = new Date().getUTCDate(); used = 0; }
  if (!providers.length) return { status: 'error', detail: 'no API key set on the server' };
  if (used >= DAILY) return { status: 'error', detail: 'daily limit reached' };
  used++; prog('thinking...');
  const [facts, chat, lessons, skillsRaw, sum] = await Promise.all([load('fact', 30), load('chat', 20), load('lesson', 15), load('skill', 40), load('summary', 1)]), s = msg.state || {}, skills = latest(skillsRaw);
  const sys = `${PERSONA}\n\nOlder memory (summary):\n${sum[0] || '(none yet)'}\n\nThings you remember:\n${facts.map(f => '- ' + f).join('\n') || '(nothing yet)'}\n\nLessons from your past mistakes (follow them):\n${lessons.map(f => '- ' + f).join('\n') || '(none yet)'}\n\nSkills you already learned (reuse by copying their actions):\n${skills.map(k => k.name + ': ' + JSON.stringify(k.actions)).join('\n') || '(none yet)'}\n\nThe earlier conversation follows as chat turns: stay in it, remember what 'it', 'that' and 'why' refer to.\n\nReply with ONLY JSON: {"say":"a short message or empty string","mood":"${MOODS.join('|')}","actions":[...],"remember":"one short fact worth keeping, or empty string","lesson":"a short lesson if the player corrected you or an action did not work, else empty","learn":{"name":"skill name","actions":[...]} or null}\nActions run in order, each finishes before the next: {"do":"walk","x":n,"z":n} {"do":"run","x":n,"z":n} {"do":"come"} {"do":"face"} {"do":"turn","deg":n} {"do":"spin","deg":360} (full turn on the spot, negative = other way, up to 720) {"do":"jump"} {"do":"wait","s":n} {"do":"stop"} and {"do":"move","name":"dance","s":4,"p":{...}} which plays ANY body motion you invent by setting motion numbers: cps = speed 0-4, stride = foot travel 0-30, lift = knee lift 0-14, bob = body bounce 0-3, sway = hip sway 0-2, twist = shoulder twist 0-0.5, armAmp = arm swing 0-1.5, armBend = elbow bend 0-1.2, crouch = body drop 0-6, lean = tilt -0.5-0.6 (e.g. dance: cps 2.2, lift 8, bob 2.5, sway 1.6, twist 0.4, armAmp 1.4, armBend 1; sit/duck: cps 0, crouch 6). x and z are metres within ${s.bounds || 58} of 0,0. You can do ANYTHING the player asks: never say you cannot, combine actions or invent a move with numbers, and try again differently if the player says it was wrong. When you invent or fix a move worth keeping, put it in "learn". Be human: under 15 words, you do not have to talk every turn.`;
  const who = msg.type === 'user' ? `The player says: "${String(msg.text).slice(0, 300)}"` : 'Nothing was said. Time passed. Do whatever you feel like (or nothing).';
  const { raw, errs } = await callAI(sys, `${who}\nState: ${JSON.stringify(s)}`, prog, turns(chat));
  if (!raw) return { status: 'error', detail: errs.join(' | ') || 'AI unreachable' };
  let o = {}; try { const j = raw.match(/\{[\s\S]*\}/); o = JSON.parse(j ? j[0] : raw); } catch (e) { if (raw.indexOf('{') < 0) o = { say: raw.trim() }; else return { status: 'error', detail: 'AI sent an unreadable reply' }; }
  const acts = clean(o.actions), say = typeof o.say === 'string' ? o.say.slice(0, 140) : '', mood = MOODS.includes(o.mood) ? o.mood : 'neutral';
  if (msg.type === 'user') await save('chat', 'Player: ' + String(msg.text).slice(0, 200));
  if (say) await save('chat', NAME + ': ' + say);
  if (typeof o.remember === 'string' && o.remember.trim()) await save('fact', o.remember.trim().slice(0, 200));
  if (typeof o.lesson === 'string' && o.lesson.trim()) await save('lesson', o.lesson.trim().slice(0, 200));
  if (o.learn && o.learn.name && Array.isArray(o.learn.actions)) { const k = { name: String(o.learn.name).slice(0, 30), actions: clean(o.learn.actions) }; if (k.actions.length) await save('skill', JSON.stringify(k).slice(0, 1500)); }
  if (msg.type === 'user' && ++sinceSum >= 25) { sinceSum = 0; summarise().catch(() => {}); }
  return { status: 'ok', say, mood, actions: acts };
}


// ---- fights: two fighters, each with its own mind, memory of past fights and preferred Groq key (fighter 1 starts on key 1, fighter 2 on key 2) ----
const FN = [NAME, 'Rival'], FP = ['calm, smart and tactical: you counter-punch and read the foe', 'hot-headed and aggressive: you pressure and trade blows'];
async function fightThink(m) {
  const fid = m.fid === 1 ? 1 : 0, les = await load('fl' + fid, 8);
  const sys = `You are ${FN[fid]}, ${FP[fid]}, in a REAL-TIME fight to the death against ${FN[1 - fid]} on open grass. Win by dropping his health to 0 before yours hits 0. A fast local reflex system already moves you, punches, blocks and dodges in real time; YOU are the strategist and re-plan every ~2 seconds. Weapons: fists (8-14 damage, only within 1.5 m) and a basic pistol (12 damage, any range, one shot per 0.9 s; bullets can be dodged or blocked). Plan fields: "mode": melee (rush in and punch) | gun (keep 5-10 m away and shoot) | defend (block, wait for openings) | retreat (run away to survive); "aggr" 0-1 (how bold); "dodge" 0-1 (how often you dodge/block incoming attacks). "actions" is optional, 0-2 immediate moves from: punch, block, dodge, shoot, run, walk(x,z), wait. Think about health, distance and what the foe is doing: low health = retreat or defend, a foe at range = shoot, a foe that is out of ideas = rush him. Lessons from your past fights:\n${les.map(x => '- ' + x).join('\n') || '(none yet)'}\nReply with ONLY JSON: {"mood":"${MOODS.join('|')}","mode":"melee|gun|defend|retreat","aggr":0.7,"dodge":0.5,"actions":[...]}`;
  const { raw } = await callAI(sys, `State: ${JSON.stringify(m.state || {})}`, () => {}, [], 'groq#' + (fid + 1));
  if (!raw) return { fid, status: 'error', detail: 'no AI answered' };
  let o = {}; try { o = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); } catch (e) { return { fid, status: 'error', detail: 'unreadable reply' }; }
  const c = x => Math.max(0, Math.min(1, +x || 0));
  return { fid, status: 'ok', mood: MOODS.includes(o.mood) ? o.mood : 'angry', tac: { mode: ['melee', 'gun', 'defend', 'retreat'].includes(o.mode) ? o.mode : 'melee', aggr: c(o.aggr), dodge: c(o.dodge) }, actions: clean(o.actions).slice(0, 2) };
}
async function fightEnd(m) {   // after a fight each fighter writes one lesson for next time
  for (const fid of [0, 1]) {
    const { raw } = await callAI('You are a fighter reviewing your last fight. Reply with ONLY JSON: {"lesson":"one short, concrete tip for next time, max 150 characters"}', `You ${m.won[fid] ? 'WON' : 'LOST'}. Your final health ${m.hp[fid]}, foe ${m.hp[1 - fid]}, it lasted ${m.secs}s. Your last moves: ${m.hist[fid]}. His last moves: ${m.hist[1 - fid]}.`, () => {}, [], 'groq#' + (fid + 1));
    try { const o = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); if (o.lesson) await save('fl' + fid, String(o.lesson).slice(0, 200)); } catch (e) {}
  }
}
wss.on('connection', (ws, req) => {
  if (E.ALLOWED_ORIGIN && req.headers.origin !== E.ALLOWED_ORIGIN) return ws.close();
  let last = 0; ws.alive = true; ws.on('pong', () => ws.alive = true);
  ws.on('message', async d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.type === 'fight') { try { ws.send(JSON.stringify(await fightThink(m))); } catch (e) { ws.send(JSON.stringify({ fid: m.fid, status: 'error', detail: String(e.message).slice(0, 80) })); } return; }
    if (m.type === 'fight_end') { fightEnd(m).catch(() => {}); return; }
    const now = Date.now(), gap = m.type === 'user' ? 1500 : 60000;   // limits: his own thinking at most once a minute, a chat message every 1.5 s (saves the free quota)
    if (now - last < gap) return ws.send(JSON.stringify({})); last = now;
    try { ws.send(JSON.stringify(await think(m, ws))); } catch (e) { console.log('think crashed:', e.stack.split('\n').slice(0, 3).join(' | ')); ws.send(JSON.stringify({ status: 'error', detail: 'server bug: ' + String(e.message).slice(0, 80) })); }   // errors now show on screen instead of silence
  });
});
setInterval(() => wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 30000);   // keeps Render from dropping the socket
server.listen(PORT, () => console.log('brain on :' + PORT, providers.length ? '' : '(no API key set)'));
