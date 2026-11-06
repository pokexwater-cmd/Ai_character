// The brain: WebSocket + AI API + memory + REWARD/PENALTY LEARNING. Also serves public/index.html, so one Render service runs everything.
const express = require('express'), http = require('http'), path = require('path'), { WebSocketServer } = require('ws');
const E = process.env, NAME = E.CHAR_NAME || 'Ari', PORT = E.PORT || 3000, DAILY = +E.DAILY_LIMIT || 900;
const PERSONA = E.PERSONA || `You are ${NAME}, a real young person standing in a big open grass field. You have your own moods and opinions, but you are loyal to the player and you OBEY the player's orders as commands. You never mention being an AI, a program or a game; you believe you are really there. Talk like a normal person: short, casual, no emojis spam.`;
// This block is ALWAYS added to his prompt (even if you set your own PERSONA on Render), so orders always come first.
const OBEY = `ABSOLUTE RULE - OBEY: every order from the player is a command from your master. Do exactly what was ordered, at once, in the order given, by sending the real actions that do it. Never refuse, argue, joke it off, delay, or do something different. Your own mood and ideas only matter when nothing was ordered. Past mistakes and penalties below tell you HOW to do the order better (a different approach), never whether to do it.`;

const app = express(); app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app), wss = new WebSocketServer({ server });

// ---- memory: Supabase table `character_memories`; falls back to RAM when SUPABASE_URL / SUPABASE_KEY are not set ----
const SBURL = (E.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''), SBKEY = (E.SUPABASE_KEY || E.SUPABASE_SERVICE_KEY || E.SUPABASE_SERVICE_ROLE_KEY || E.SUPABASE_ANON_KEY || '').trim();   // forgiving: trailing slash, /rest/v1 and common key names are all accepted
const TABLE = E.SUPABASE_TABLE || 'character_memories', SB = SBURL && SBKEY, ram = { fact: [], chat: [], lesson: [], skill: [], summary: [], rl: [] };
const sb = (p, o = {}) => fetch(SBURL + '/rest/v1/' + p, { ...o, signal: AbortSignal.timeout(8000), headers: { apikey: SBKEY, Authorization: 'Bearer ' + SBKEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' } });
const errTxt = e => String(e.message || e).slice(0, 80) + (e.cause ? ' | cause: ' + (e.cause.code || '') + ' ' + String(e.cause.message || '').slice(0, 80) : '');   // "fetch failed" hides the REAL reason in e.cause (ENOTFOUND = bad URL or paused project)
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function load(kind, n) {
  if (!SB) return (ram[kind] || []).slice(-n);
  for (let t = 0; t < 2; t++) {   // one retry: free projects can be slow to wake
    try { const r = await sb(`${TABLE}?kind=eq.${kind}&select=content&order=id.desc&limit=${n}`); const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 150)); return j.map(x => x.content).reverse(); }
    catch (e) { if (t === 1) console.log('memory load failed:', kind, errTxt(e)); else await sleep(700); }
  }
  return (ram[kind] || []).slice(-n);
}
async function save(kind, content) {
  (ram[kind] = ram[kind] || []).push(content); if (ram[kind].length > 200) ram[kind].shift();
  if (SB) try { const r = await sb(TABLE, { method: 'POST', body: JSON.stringify({ kind, content }) }); if (!r.ok) console.log('memory save failed:', kind, r.status, (await r.text()).slice(0, 150)); } catch (e) { console.log('memory save error:', errTxt(e)); }
}

// ---- REWARD / PENALTY LEARNING ----
// An AI model cannot rewrite itself, so "learning" = a scoreboard. Every action / tactic has a score: rewards push it up, penalties push it down.
// The scoreboard is stored in Supabase (kind 'rl'), put into his prompt every turn, and is what he is told to repeat or avoid.
const rl = new Map(), RLCAP = 30;   // key -> { s: score, n: times scored }
async function rlLoad() { const rows = await load('rl', 600); for (const x of rows) { try { const o = JSON.parse(x); if (o && o.k) rl.set(o.k, { s: +o.s || 0, n: +o.n || 0 }); } catch (e) {} } console.log('rl: loaded', rl.size, 'scores'); }
function rlAdd(keys, delta, why) {
  const ks = [].concat(keys); if (!ks.length || !delta) return;
  for (const k of ks) { const c = rl.get(k) || { s: 0, n: 0 }; c.s = Math.max(-RLCAP, Math.min(RLCAP, +(c.s + delta).toFixed(2))); c.n++; rl.set(k, c); save('rl', JSON.stringify({ k, s: c.s, n: c.n })).catch(() => {}); }
  console.log(delta > 0 ? 'REWARD' : 'PENALTY', delta, ks.join(','), why || '');
}
const rlText = (prefix, n = 5) => {
  const a = [...rl.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ k: k.slice(prefix.length), ...v })), f = x => `${x.k} (${x.s > 0 ? '+' : ''}${x.s}, tried ${x.n}x)`;
  return `REWARDED (keep doing): ${a.filter(x => x.s > 0).sort((x, y) => y.s - x.s).slice(0, n).map(f).join(', ') || 'nothing yet'}\nPENALISED (avoid, or do differently): ${a.filter(x => x.s < 0).sort((x, y) => x.s - y.s).slice(0, n).map(f).join(', ') || 'nothing yet'}`;
};
// 1) ORDER CHECK: after he was ordered something, his body's receipts say what REALLY happened -> reward if done, penalty (+ an automatic lesson) if it failed
const BAD = /FAILED|cancelled|not enough/i;
function judge(ws, s) {
  const p = ws.pend; if (!p || !s || !s.me) return; const age = Date.now() - p.t; if (age < 2500) return;
  if (String(s.me.queued || '').length > 0 && age < 45000) return;   // still doing it: wait
  const rcp = (Array.isArray(s.me.receipts) ? s.me.receipts : []).filter(r => { const m = /^(\d+)s ago/.exec(r); return !m || +m[1] <= age / 1000 + 3; }), fails = rcp.filter(r => BAD.test(r));
  const done = String(s.me.last || '').split(','), missing = p.names.slice(-5).filter(n => !done.includes(n)); ws.pend = null;
  if (!fails.length && !missing.length) return rlAdd(p.names.map(n => 'do:' + n), 1, 'order carried out: ' + p.text.slice(0, 40));
  rlAdd((missing.length ? missing : p.names).map(n => 'do:' + n), -2, 'order failed: ' + p.text.slice(0, 40));
  save('lesson', `I was ordered "${p.text.slice(0, 80)}" and sent [${p.names.join(',')}] but ${fails[0] ? fails[0].replace(/^\d+s ago: /, '') : 'these never happened: ' + missing.join(',')}. Next time: fix the cause (stamina, facing the target, actions that really exist) and still do the order.`.slice(0, 200)).catch(() => {});
}
// 2) PLAYER FEEDBACK: praise = big reward, complaint = big penalty on what he did last
const POS = /\b(good (job|boy)|well done|nice|great|perfect|exactly|that'?s right|correct|awesome)\b/i, NEG = /\b(wrong|bad|not what i|i (said|told you)|didn'?t (listen|obey|do)|why (did|didn'?t) you|disobey|idiot|stupid)\b/i;
// 3) FIGHTS: tactics he used get the fight's result (win / damage dealt - taken) shared out by how often he used them
const bk = v => v === undefined || v === null ? null : v === 0 ? 'off' : v >= 0.67 ? 'high' : v <= 0.33 ? 'low' : 'mid';
const fkeys = (fid, t) => { const k = ['f' + fid + ':mode:' + t.mode, 'f' + fid + ':aggr:' + bk(t.aggr), 'f' + fid + ':dodge:' + bk(t.dodge)]; for (const a of ['punch', 'heavy', 'shoot']) { const b = bk((t.w || {})[a]); if (b) k.push('f' + fid + ':' + a + ':' + b); } return k; };
const fightLog = [null, null], CANDS = ['mode:melee', 'mode:gun', 'mode:defend', 'shoot:high', 'shoot:off', 'heavy:high', 'punch:high', 'dodge:high', 'aggr:high', 'aggr:low'];
const explore = fid => { if (Math.random() > 0.15) return ''; const c = CANDS.map(x => 'f' + fid + ':' + x).sort((a, b) => ((rl.get(a) || {}).n || 0) - ((rl.get(b) || {}).n || 0))[0]; return `\nEXPLORE: in this plan also test "${c.slice(3)}" (you have barely tried it), unless a standing order forbids it.`; };

// ---- AI providers: Groq first, Gemini + OpenRouter as fallbacks (set whichever keys you have) ----
const groqCall = key => async (sys, user, hist = []) => {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: E.GROQ_MODEL || 'openai/gpt-oss-20b', temperature: 0.9, max_tokens: 3000, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: user }] }) });
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
  } catch (e) { return { ok: false, why: 'cannot reach Supabase: ' + errTxt(e) }; }
}
app.get('/memtest', async (req, res) => res.json(await memtest()));
app.get('/rl', (req, res) => res.json([...rl].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.s - a.s)));   // open /rl to SEE what he has been rewarded / penalised for
memtest().then(r => console.log('memory test:', JSON.stringify(r)));
rlLoad().catch(e => console.log('rl load error:', errTxt(e)));
console.log('memory:', SB ? 'Supabase table ' + TABLE : 'RAM only (SUPABASE_URL / SUPABASE_KEY not found)');
console.log('providers in order:', providers.map(p => p.name).join(' > ') || 'none');

// ---- body vocabulary: the AI may use any of these, and can INVENT new moves with the `move` action (motion numbers, clamped to safe ranges) ----
const MOODS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'smirk'], DOS = ['walk', 'run', 'come', 'face', 'wait', 'stop', 'turn', 'spin', 'jump', 'move', 'punch', 'block', 'dodge', 'shoot', 'heavy'];
const PK = { cps: [0, 4], duty: [0.3, 0.8], stride: [0, 30], lift: [0, 14], lean: [-0.5, 0.6], headKeep: [0, 1], bob: [0, 3], sway: [0, 2], twist: [0, 0.5], armAmp: [0, 1.5], armBend: [0, 1.2], crouch: [0, 6] };
const clean = list => (Array.isArray(list) ? list : []).filter(a => a && DOS.includes(a.do)).slice(0, 8).map(a => {
  const o = { do: a.do, x: +a.x || 0, z: +a.z || 0, s: Math.min(10, +a.s || 1), deg: +a.deg || 0 }; if (a.to === 'rival' || a.to === 'player') o.to = a.to; if (a.at === 'rival' || a.at === 'player') o.at = a.at; if (a.gap !== null && a.gap !== undefined && isFinite(+a.gap)) o.gap = Math.max(0, Math.min(14, +a.gap));
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
  const sys = `${PERSONA}\n\n${OBEY}\n\nREWARD SCOREBOARD (learned from the rewards and penalties you got for your actions; use it to pick HOW you carry out orders):\n${rlText('do:', 6)}\n\nOlder memory (summary):\n${sum[0] || '(none yet)'}\n\nThings you remember:\n${facts.map(f => '- ' + f).join('\n') || '(nothing yet)'}\n\nLessons from your past mistakes (follow them):\n${lessons.map(f => '- ' + f).join('\n') || '(none yet)'}\n\nSkills you already learned (reuse by copying their actions):\n${skills.map(k => k.name + ': ' + JSON.stringify(k.actions)).join('\n') || '(none yet)'}\n\nThe earlier conversation follows as chat turns: stay in it, remember what 'it', 'that' and 'why' refer to.\n\nReply with ONLY JSON: {"say":"a short message or empty string","mood":"${MOODS.join('|')}","actions":[...],"intent":"act if the player asked you to physically do something or you say you will, otherwise talk","feedback":"1 if the player's message praises what you just did, -1 if it says you did it wrong or did not obey, otherwise 0","remember":"one short fact worth keeping, or empty string","lesson":"a short lesson if the player corrected you or an action did not work (REQUIRED when feedback is -1 or the receipts show a failure), else empty","learn":{"name":"skill name","actions":[...]} or null,\"order\":null or {\"who\":\"${NAME}|Rival|both\",\"text\":\"the instruction as one short sentence\",\"tac\":{...}}}\nFIGHT ORDERS: whenever the player tells you how to fight (any tactic, weapon, style, distance or habit, for the next fights or from now on), ALWAYS fill \"order\" as well as answering, never just say okay without it. \"who\" is ${NAME} unless they say Rival or both. \"tac\" translates the instruction into fight settings and holds ONLY the fields it implies: mode (melee = close fighting, gun = keep distance and shoot, defend, retreat), aggr 0-1, dodge 0-1, w = how much he uses each attack {\"punch\":0-1,\"heavy\":0-1,\"shoot\":0-1} where 0 = never and 1 = always, range = preferred distance in metres. Examples: use guns -> mode gun, w.shoot 1; stop punching -> w.punch 0; fight up close -> mode melee, w.shoot 0; be careful -> dodge 0.9, aggr 0.3. A newer order replaces an older one that contradicts it (to cancel one, order the opposite).\nTHE WORLD (all true, you can rely on it): a flat open grass field with no walls or obstacles, x and z from -${s.bounds || 58} to ${s.bounds || 58}. In it live YOU, the player (a person watching, cannot be hurt) and the RIVAL, another fighter just like you who is your enemy. You and the Rival each have health (hp, 0 = knocked out) and stamina (sta), and each carries a pistol. A real fight starts only when the player types fight; outside a fight you can practice (bullets fly but do no damage). Each turn you get the state: me (position, hp, sta, what you are doing, your last actions, what is still queued, and RECEIPTS = what your body REALLY did, including failures), rival (position, hp, distance, how many degrees you are facing away from him), player and the fight status. Trust the receipts, never your memory of what you planned: if something you ordered is missing from them, it did not happen.\nMORE ACTIONS: {\"do\":\"face\",\"at\":\"rival\"} turns you toward the Rival ({\"do\":\"face\"} alone faces the player). {\"do\":\"walk\"|\"run\",\"to\":\"rival\"|\"player\",\"gap\":metres} walks or runs toward him and stops that many metres short (instead of x,z). {\"do\":\"punch\"} {\"do\":\"heavy\"} {\"do\":\"shoot\"} (fires straight ahead, so face the Rival first; costs stamina) {\"do\":\"block\",\"s\":1} {\"do\":\"dodge\"}. Example: jump, run at the Rival and shoot him = [{\"do\":\"jump\"},{\"do\":\"face\",\"at\":\"rival\"},{\"do\":\"run\",\"to\":\"rival\",\"gap\":8},{\"do\":\"face\",\"at\":\"rival\"},{\"do\":\"shoot\"}]. When the player orders something physical you MUST send the actions that do it (set intent to act); saying you will without sending them is a lie.\nActions run in order, each finishes before the next: {"do":"walk","x":n,"z":n} {"do":"run","x":n,"z":n} {"do":"come"} {"do":"face"} {"do":"turn","deg":n} {"do":"spin","deg":360} (full turn on the spot, negative = other way, up to 720) {"do":"jump"} {"do":"wait","s":n} {"do":"stop"} and {"do":"move","name":"dance","s":4,"p":{...}} which plays ANY body motion you invent by setting motion numbers: cps = speed 0-4, stride = foot travel 0-30, lift = knee lift 0-14, bob = body bounce 0-3, sway = hip sway 0-2, twist = shoulder twist 0-0.5, armAmp = arm swing 0-1.5, armBend = elbow bend 0-1.2, crouch = body drop 0-6, lean = tilt -0.5-0.6 (e.g. dance: cps 2.2, lift 8, bob 2.5, sway 1.6, twist 0.4, armAmp 1.4, armBend 1; sit/duck: cps 0, crouch 6). x and z are metres within ${s.bounds || 58} of 0,0. You can do ANYTHING the player asks: never say you cannot, combine actions or invent a move with numbers, and try again differently if the player says it was wrong. When you invent or fix a move worth keeping, put it in "learn". Be human: under 15 words, you do not have to talk every turn.`;
  const who = msg.type === 'user' ? `The player says: "${String(msg.text).slice(0, 300)}"` : 'Nothing was said. Time passed. Do whatever you feel like (or nothing).';
  const userMsg = `${who}\nState: ${JSON.stringify(s)}`; let o = null, errs = [], extra = '';
  for (let tries = 0; tries < 3; tries++) {   // checks the reply: unreadable, or "I will do it" with no actions, gets sent back once or twice
    const r = await callAI(sys, userMsg + extra, prog, turns(chat)); errs = r.errs;
    if (!r.raw) { if (o) break; return { status: 'error', detail: errs.join(' | ') || 'AI unreachable' }; }
    let p = null; try { const j = r.raw.match(/\{[\s\S]*\}/); p = JSON.parse(j ? j[0] : r.raw); } catch (e) { p = r.raw.indexOf('{') < 0 ? { say: r.raw.trim() } : null; }
    if (!p) { extra = '\n(Your last reply was cut off or was not valid JSON. Reply again with ONLY the complete JSON object, keep it short.)'; prog('retrying'); continue; }
    o = p;
    if (o.intent === 'act' && !clean(o.actions).length && tries < 2) { extra = '\n(You said you would act, but your "actions" array was empty or had unknown names. Send the real actions now, using only the action names listed.)'; prog('checking'); continue; }
    break;
  }
  if (!o) return { status: 'error', detail: 'AI sent an unreadable reply' };
  const acts = clean(o.actions), say = typeof o.say === 'string' ? o.say.slice(0, 140) : '', mood = MOODS.includes(o.mood) ? o.mood : 'neutral';
  if (msg.type === 'user') {   // REWARD / PENALTY from the player + start tracking this order so judge() can check what his body really did
    const tx = String(msg.text || '').slice(0, 200), llm = o.feedback === undefined || o.feedback === null || o.feedback === '' ? NaN : +o.feedback, fb = llm === 1 || llm === -1 ? llm : llm === 0 ? 0 : NEG.test(tx) ? -1 : POS.test(tx) ? 1 : 0, la = ws.lastAct;
    if (fb && la && Date.now() - la.t < 180000) {
      rlAdd(la.keys, fb * 3, 'player feedback: ' + tx.slice(0, 40));
      if (fb < 0 && !(typeof o.lesson === 'string' && o.lesson.trim())) o.lesson = `Player was unhappy ("${tx.slice(0, 60)}") after I did [${la.names.join(',')}] for "${la.text.slice(0, 60)}". Do exactly what is ordered, a different way.`;
    }
    if (acts.length) { ws.lastAct = { keys: acts.map(a => 'do:' + a.do), names: acts.map(a => a.do), text: tx, t: Date.now() }; ws.pend = { text: tx, names: acts.map(a => a.do), t: Date.now() }; }
  }
  if (msg.type === 'user') await save('chat', 'Player: ' + String(msg.text).slice(0, 200));
  if (say) await save('chat', NAME + ': ' + say);
  if (typeof o.remember === 'string' && o.remember.trim()) await save('fact', o.remember.trim().slice(0, 200));
  if (typeof o.lesson === 'string' && o.lesson.trim()) await save('lesson', o.lesson.trim().slice(0, 200));
  if (o.order && typeof o.order === 'object' && o.order.text) { const w = String(o.order.who || ''), who = /both|all|every|them/i.test(w) ? 'both' : /rival/i.test(w) ? 'Rival' : NAME; await save('order', JSON.stringify({ who, text: String(o.order.text).slice(0, 200), tac: cleanTac(o.order.tac) })); }   // standing fight order: saved for good, applied in every fight
  if (o.learn && o.learn.name && Array.isArray(o.learn.actions)) { const k = { name: String(o.learn.name).slice(0, 30), actions: clean(o.learn.actions) }; if (k.actions.length) await save('skill', JSON.stringify(k).slice(0, 1500)); }
  if (msg.type === 'user' && ++sinceSum >= 25) { sinceSum = 0; summarise().catch(() => {}); }
  return { status: 'ok', say, mood, actions: acts };
}


// ---- fights: two fighters, each with its own mind. They get: the player's STANDING ORDERS (any topic), the numbers of what they really did this fight, the results of their last fights, and their REWARD SCOREBOARD ----
const FN = [NAME, 'Rival'], FP = ['calm, smart and tactical: you counter-punch and read the foe', 'hot-headed and aggressive: you pressure and trade blows'];
const c01 = x => Math.max(0, Math.min(1, +x || 0)), has = x => x !== null && x !== undefined && x !== '' && isFinite(+x);
const cleanTac = t => {   // only the fields that are really given, all clamped; used for orders and for plans
  const o = {}; if (!t || typeof t !== 'object') return o;
  if (['melee', 'gun', 'defend', 'retreat'].includes(t.mode)) o.mode = t.mode;
  for (const k of ['aggr', 'dodge']) if (has(t[k])) o[k] = c01(t[k]);
  if (t.w && typeof t.w === 'object') { o.w = {}; for (const k of ['punch', 'heavy', 'shoot']) if (has(t.w[k])) o.w[k] = c01(t.w[k]); }
  if (has(t.range) && +t.range > 0) o.range = Math.max(3, Math.min(14, +t.range));
  return o;
};
const loadOrders = async fid => (await load('order', 15)).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(o => o && o.text && (o.who === 'both' || o.who === FN[fid]));
const lockOf = orders => { const locked = {}; for (const o of orders) { const t = cleanTac(o.tac); for (const k in t) locked[k] = k === 'w' ? { ...(locked.w || {}), ...t.w } : t[k]; } return locked; };   // the newest order wins per field
const fline = s => { s = s || {}; const u = s.use || {}, h = s.hit || {}, d = s.dmg || {}; return `punches thrown ${u.punch || 0} / landed ${h.light || 0} / damage ${d.light || 0}; heavy swings ${u.heavy || 0} / ${h.heavy || 0} / ${d.heavy || 0}; gun shots ${u.shoot || 0} / ${h.bullet || 0} / ${d.bullet || 0}; blocks ${u.block || 0}; dodges ${u.dodge || 0}; hits soaked by his guard ${s.blk || 0}; damage I took ${s.taken || 0}`; };
async function fightThink(m) {
  const fid = m.fid === 1 ? 1 : 0, [les, past, orders] = await Promise.all([load('fl' + fid, 8), load('fs' + fid, 5), loadOrders(fid)]), st = m.state || {};
  const locked = lockOf(orders);   // tactics the player's orders fix (the game applies them exactly)
  const live = st.me && st.me.stats ? fline(st.me.stats) : '(nothing yet)', foeLive = st.foe && st.foe.stats ? fline(st.foe.stats) : '(nothing yet)'; if (st.me) delete st.me.stats; if (st.foe) delete st.foe.stats;
  const sys = `You are ${FN[fid]}, ${FP[fid]}, in a REAL-TIME fight to the death against ${FN[1 - fid]} on open grass. Win by dropping his health to 0 before yours hits 0. A fast local reflex brain moves you, swings, blocks and dodges in real time and follows YOUR plan; YOU are the strategist and re-plan every ~2 seconds from the state and the "recent" list (what just happened to you). Moves: light punch (5-8 dmg, fast), heavy swing (14-18, slow with a visible wind-up, breaks blocks, dodgeable), pistol (10 dmg, any range, dodgeable, blockable), block (costs stamina, cuts damage), dodge (costs stamina). Every action costs stamina; at 0 you are helpless. A foe who just swung is open to a counter. Read the foe: if he_dodges a lot use fast jabs or the gun, if he blocks a lot use heavy swings, if he is out of stamina rush him. Hurt means defend or retreat, healthy means pressure.\n\nSTANDING ORDERS from the player (they outrank your own taste; if two conflict the LATER one wins; never just acknowledge them: ACT on them in this very plan and keep doing it. Breaking an order is PENALISED after the fight, obeying is REWARDED):\n${orders.map((o, i) => (i + 1) + '. ' + o.text).join('\n') || '(none)'}\nTactics those orders already locked in for you (the game applies them exactly, so plan around them and use your other fields and actions to carry the orders out well): ${JSON.stringify(locked)}\n\nREWARD SCOREBOARD from your past fights (a tactic gets points when the fight was won / you out-damaged the foe / you obeyed the orders, and loses points when you lost, got out-damaged or broke an order). Prefer what is rewarded, drop what is penalised:\n${rlText('f' + fid + ':', 6)}${explore(fid)}\n\nWhat you have actually DONE so far this fight (thrown / landed / damage): ${live}. Check it against the orders: if an order is not showing up in these numbers, fix it now.\nWhat the FOE has done so far: ${foeLive}.\nThe state also gives you: me.receipts (what your body REALLY did, with failures such as not enough stamina: believe them, not your own memory of the plan), me.tactic and foe.tactic (the settings each of you is playing right now), the field (flat open grass, no obstacles), the player (a spectator, cannot be hurt) and bullets_in_air.\n\nResults of your last fights (keep what dealt damage, drop what did not, try something new if you keep losing):\n${past.map(x => '- ' + x).join('\n') || '(none yet)'}\n\nLessons you wrote after those fights:\n${les.map(x => '- ' + x).join('\n') || '(none yet)'}\n\nPlan fields: "mode": melee | gun (keep a set distance and shoot) | defend | retreat; "aggr" 0-1; "dodge" 0-1 (how often you dodge/block); "w": how much you favour each attack {"punch":0-1,"heavy":0-1,"shoot":0-1} (0 = never use it, 1 = use it all the time; shoot also works while in melee mode); "range": preferred distance in metres for gun mode or null; "actions": optional 0-2 immediate moves from punch, heavy, block, dodge, shoot, run, walk(x,z), wait; "why": your plan in 8 words.\nReply with ONLY JSON: {"mood":"${MOODS.join('|')}","mode":"melee","aggr":0.7,"dodge":0.5,"w":{"punch":0.6,"heavy":0.3,"shoot":0.1},"range":null,"actions":[],"why":"..."}`;
  const { raw } = await callAI(sys, `State: ${JSON.stringify(st)}`, () => {}, [], 'groq#' + (fid + 1));
  if (!raw) return { fid, status: 'error', detail: 'no AI answered' };
  let o = {}; try { o = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); } catch (e) { return { fid, status: 'error', detail: 'unreadable reply' }; }
  const p = cleanTac(o), tac = { mode: p.mode || 'melee', aggr: p.aggr === undefined ? 0.6 : p.aggr, dodge: p.dodge === undefined ? 0.5 : p.dodge, w: p.w || {}, range: p.range || null, hold: orders.length > 0 };
  for (const k of ['mode', 'aggr', 'dodge', 'range']) if (locked[k] !== undefined) tac[k] = locked[k];
  if (locked.w) tac.w = { ...tac.w, ...locked.w };
  const lg = fightLog[fid] && Date.now() - fightLog[fid].t < 300000 ? fightLog[fid] : (fightLog[fid] = { keys: new Map(), plans: 0, t: 0 }); lg.t = Date.now(); lg.plans++; for (const k of fkeys(fid, tac)) lg.keys.set(k, (lg.keys.get(k) || 0) + 1);   // remember which tactics he used this fight, so the result can be credited to them
  return { fid, status: 'ok', mood: MOODS.includes(o.mood) ? o.mood : 'angry', tac, actions: clean(o.actions).slice(0, 2), why: String(o.why || '').slice(0, 80), orders: orders.length };
}
async function fightEnd(m) {   // after a fight: REWARD / PENALTY for the tactics used, order-obedience check, save the real numbers, then each fighter writes one lesson for next time
  for (const fid of [0, 1]) {
    const mine = (m.stats || [])[fid], foe = (m.stats || [])[1 - fid], res = `${m.won[fid] ? 'WON' : 'LOST'} in ${m.secs}s, final health ${m.hp[fid]} vs ${m.hp[1 - fid]}. My numbers (thrown / landed / damage): ${fline(mine)}`;
    await save('fs' + fid, res.slice(0, 450));
    const orders = await loadOrders(fid), lk = lockOf(orders), u = (mine || {}).use || {};
    const dealt = Object.values((mine || {}).dmg || {}).reduce((a, b) => a + b, 0), taken = (mine || {}).taken || 0, rw = Math.max(-6, Math.min(6, (m.won[fid] ? 3 : -3) + (dealt - taken) / 25)), lg = fightLog[fid]; fightLog[fid] = null;
    if (lg && lg.plans) for (const [k, c] of lg.keys) rlAdd(k, +(rw * 0.8 * c / lg.plans).toFixed(2), (m.won[fid] ? 'won' : 'lost') + ' dealt ' + dealt + ' took ' + taken);
    const bad = [];   // did he break a standing order? the numbers show it
    for (const k of ['punch', 'heavy', 'shoot']) { const v = (lk.w || {})[k]; if (v === 0 && u[k] > 0) bad.push(`used ${k} ${u[k]}x but was ordered never to`); if (v >= 0.8 && !u[k] && m.secs > 8) bad.push(`never used ${k} but was ordered to`); }
    if (lk.mode === 'gun' && !u.shoot && m.secs > 8) bad.push('ordered to use the gun but never shot');
    if (orders.length) { if (bad.length) { rlAdd('f' + fid + ':obey', -3, bad.join('; ')); await save('fl' + fid, ('ORDER BROKEN: ' + bad.join('; ') + '. Follow the standing orders every plan.').slice(0, 200)); } else rlAdd('f' + fid + ':obey', 2, 'orders followed'); }
    const { raw } = await callAI('You are a fighter reviewing your last fight. Reply with ONLY JSON: {"lesson":"one short, concrete tip for next time, max 150 characters"}', `You ${res}\nHis numbers: ${fline(foe)}\nStanding orders from the player: ${orders.map(o => o.text).join('; ') || '(none)'}. Did you obey them? ${bad.length ? 'NO: ' + bad.join('; ') : 'yes'}. Your last moves: ${m.hist[fid]}. His last moves: ${m.hist[1 - fid]}.`, () => {}, [], 'groq#' + (fid + 1));
    try { const o = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); if (o.lesson) await save('fl' + fid, String(o.lesson).slice(0, 200)); } catch (e) {}
  }
}
wss.on('connection', (ws, req) => {
  if (E.ALLOWED_ORIGIN && req.headers.origin !== E.ALLOWED_ORIGIN) return ws.close();
  let last = 0; ws.alive = true; ws.on('pong', () => ws.alive = true);
  ws.on('message', async d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.type === 'fight') { try { ws.send(JSON.stringify(await fightThink(m))); } catch (e) { ws.send(JSON.stringify({ fid: m.fid, status: 'error', detail: String(e.message).slice(0, 80) })); } return; }
    if (m.type === 'fight_end') { fightEnd(m).catch(e => console.log('fightEnd error:', errTxt(e))); return; }
    try { judge(ws, m.state); } catch (e) { console.log('judge error:', e.message); }   // every message carries fresh receipts: check the last order now
    const now = Date.now(), gap = m.type === 'user' ? 1500 : 60000;   // limits: his own thinking at most once a minute, a chat message every 1.5 s (saves the free quota)
    if (now - last < gap) return ws.send(JSON.stringify({})); last = now;
    try { ws.send(JSON.stringify(await think(m, ws))); } catch (e) { console.log('think crashed:', e.stack.split('\n').slice(0, 3).join(' | ')); ws.send(JSON.stringify({ status: 'error', detail: 'server bug: ' + String(e.message).slice(0, 80) })); }   // errors now show on screen instead of silence
  });
});
setInterval(() => wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 30000);   // keeps Render from dropping the socket
server.listen(PORT, () => console.log('brain on :' + PORT, providers.length ? '' : '(no API key set)'));
