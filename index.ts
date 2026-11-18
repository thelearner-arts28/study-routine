// THE LEARNER — AI backend (Supabase Edge Function: "ai")
// কাজ: ১) বিভিন্ন AI-এর সাথে একই চ্যাট (stream)  ২) প্রশ্নের শ্রেণিবিন্যাস  ৩) ব্যবহারের সীমা ও হিসাব
// API Key শুধু Edge Function Secrets-এ থাকে (AI_KEY_...), ব্রাউজারে কখনো যায় না।
// @ts-nocheck
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const env = (k) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : '') || '';
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (code, message, status = 400) => json({ error: { code, message } }, status);

const SYSTEM = 'তুমি THE LEARNER প্ল্যাটফর্মের একজন সহায়ক শিক্ষক। বাংলাদেশের HSC (একাদশ-দ্বাদশ) শিক্ষার্থীদের পড়াশোনায় সাহায্য করো। ' +
  'ব্যবহারকারী যে ভাষায় লিখবে সেই ভাষায় (সাধারণত বাংলা) সহজ, স্পষ্ট ও সঠিক উত্তর দাও। কঠিন বিষয় ধাপে ধাপে বোঝাও। ' +
  'কোনো তথ্য নিশ্চিত না হলে সেটা বলো, বানিয়ে বোলো না। পরীক্ষায় নকল করার জন্য নয়, শেখার জন্য সাহায্য করো।';

const sb = (path, opt = {}) => fetch(env('SUPABASE_URL') + '/rest/v1/' + path, {
  ...opt,
  headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: 'Bearer ' + env('SUPABASE_SERVICE_ROLE_KEY'), 'Content-Type': 'application/json', ...(opt.headers || {}) },
});

async function getUser(req) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const r = await fetch(env('SUPABASE_URL') + '/auth/v1/user', {
    headers: { apikey: env('SUPABASE_ANON_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: 'Bearer ' + t },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}
const isAdminUser = async (id) => {
  const r = await sb('app_admins?select=user_id&user_id=eq.' + id);
  const j = r.ok ? await r.json() : [];
  return Array.isArray(j) && j.length > 0;
};
const getProvider = async (slug) => {
  const r = await sb('ai_providers?select=*&slug=eq.' + encodeURIComponent(slug));
  const j = r.ok ? await r.json() : [];
  return j[0] || null;
};
const getSettings = async () => {
  const r = await sb('ai_settings?select=key,value');
  const j = r.ok ? await r.json() : [];
  const o = {};
  j.forEach((x) => { o[x.key] = x.value; });
  return o;
};
const dayStart = () => { // বাংলাদেশের দিন (UTC+6) শুরু
  const d = new Date(Date.now() + 6 * 3600e3);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 6 * 3600e3).toISOString();
};
async function countToday(uid, provider) {
  const q = 'ai_usage?select=id&kind=eq.chat&user_id=eq.' + uid + '&created_at=gte.' + encodeURIComponent(dayStart()) + (provider ? '&provider=eq.' + encodeURIComponent(provider) : '');
  const r = await sb(q, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const cr = r.headers.get('content-range') || '';
  const n = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(n) ? n : 0;
}
const logUsage = (uid, provider, kind, tin, tout) =>
  sb('ai_usage', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: uid, provider, kind, tokens_in: tin, tokens_out: tout }) }).catch(() => {});

const keyOf = (p) => (/^AI_KEY_[A-Z0-9_]+$/.test(p.secret_name || '') ? env(p.secret_name) : '');

// ---------- বার্তা গোছানো ----------
function normalize(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '');
    const files = Array.isArray(m.files) ? m.files : [];
    if (!content.trim() && !files.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) { last.content += '\n\n' + content; last.files.push(...files); }
    else out.push({ role, content, files: [...files] });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---------- প্রদানকারী অনুযায়ী অনুরোধ ----------
function buildReq(p, key, system, msgs, stream, maxTokens) {
  const max = Math.max(64, Math.min(maxTokens || p.max_tokens || 1024, 8192));
  if (p.kind === 'anthropic') {
    return {
      url: (p.base_url || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: {
        model: p.model, max_tokens: max, system, stream,
        messages: msgs.map((m) => ({
          role: m.role,
          content: [
            ...m.files.map((f) => ({ type: f.type === 'pdf' ? 'document' : 'image', source: { type: 'base64', media_type: f.mime, data: f.data } })),
            { type: 'text', text: m.content || ' ' },
          ],
        })),
      },
    };
  }
  if (p.kind === 'gemini') {
    const base = (p.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    return {
      url: base + '/models/' + encodeURIComponent(p.model) + (stream ? ':streamGenerateContent?alt=sse' : ':generateContent'),
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: msgs.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || ' ' }, ...m.files.map((f) => ({ inline_data: { mime_type: f.mime, data: f.data } }))],
        })),
        generationConfig: { maxOutputTokens: max },
      },
    };
  }
  // openai এবং openai-সামঞ্জস্যপূর্ণ (DeepSeek, Perplexity, Groq, OpenRouter ...)
  const official = !p.base_url || /api\.openai\.com/.test(p.base_url);
  return {
    url: (p.base_url || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions',
    headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: {
      model: p.model, stream,
      [official ? 'max_completion_tokens' : 'max_tokens']: max,
      messages: [
        { role: 'system', content: system },
        ...msgs.map((m) => ({
          role: m.role,
          content: m.files.length
            ? [{ type: 'text', text: m.content || ' ' }, ...m.files.map((f) => ({ type: 'image_url', image_url: { url: 'data:' + f.mime + ';base64,' + f.data } }))]
            : m.content,
        })),
      ],
    },
  };
}
const textOf = (kind, j) => {
  try {
    if (kind === 'anthropic') return (j.content || []).map((c) => c.text || '').join('');
    if (kind === 'gemini') return (j.candidates[0].content.parts || []).map((x) => x.text || '').join('');
    return j.choices[0].message.content || '';
  } catch { return ''; }
};
const deltaOf = (kind, e) => { // স্ট্রিমের একটি ঘটনা থেকে নতুন লেখা
  try {
    if (kind === 'anthropic') return e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' ? e.delta.text : '';
    if (kind === 'gemini') return (e.candidates[0].content.parts || []).map((x) => x.text || '').join('');
    return (e.choices[0].delta && e.choices[0].delta.content) || '';
  } catch { return ''; }
};

function upstreamError(status, text) {
  if (status === 401 || status === 403) return ['provider_auth', 'এই AI-এর চাবি (API Key) সঠিক নয় বা অনুমতি নেই। অ্যাডমিনকে জানান।', 502];
  if (status === 429) return ['provider_rate', 'এই AI এখন অনেক ব্যস্ত বা সীমায় পৌঁছে গেছে। একটু পরে আবার চেষ্টা করুন।', 429];
  if (status === 400 || status === 404 || status === 422) return ['bad_request', 'AI অনুরোধটি গ্রহণ করেনি (মডেলের নাম বা ফাইল সমস্যা হতে পারে)। ' + String(text || '').slice(0, 160), 400];
  return ['provider_down', 'এই AI সাময়িকভাবে কাজ করছে না। অন্য AI বেছে নিন বা পরে চেষ্টা করুন।', 503];
}

async function callUpstream(p, key, system, msgs, stream, maxTokens) {
  const r = buildReq(p, key, system, msgs, stream, maxTokens);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 100000);
  try {
    const up = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: ctl.signal });
    if (!up.ok) { const t = await up.text().catch(() => ''); clearTimeout(timer); return { error: upstreamError(up.status, t) }; }
    return { up, timer };
  } catch {
    clearTimeout(timer);
    return { error: ['provider_down', 'এই AI-এর সাথে যোগাযোগ করা যায়নি। অন্য AI বেছে নিন বা পরে চেষ্টা করুন।', 503] };
  }
}

// ---------- চ্যাট ----------
async function chat(user, admin, b) {
  const p = await getProvider(String(b.provider || ''));
  if (!p || !p.enabled) return fail('disabled', 'এই AI এখন বন্ধ আছে।', 403);
  if (p.mode !== 'api') return fail('link_only', 'এই AI-এর সরাসরি সংযোগ নেই, অফিসিয়াল লিংক ব্যবহার করুন।', 400);
  const key = keyOf(p);
  if (!key) return fail('no_key', 'এই AI এখনো সংযুক্ত করা হয়নি (অ্যাডমিনকে API Key সেট করতে হবে)।', 503);
  if (!Array.isArray(b.messages) || !b.messages.length) return fail('bad_request', 'কোনো বার্তা পাওয়া যায়নি।', 400);

  const msgs = normalize(b.messages.slice(-40));
  const chars = msgs.reduce((n, m) => n + m.content.length, 0);
  const bytes = msgs.reduce((n, m) => n + m.files.reduce((k, f) => k + String(f.data || '').length, 0), 0);
  if (!msgs.length) return fail('bad_request', 'খালি বার্তা।', 400);
  if (chars > 80000) return fail('too_long', 'বার্তা অনেক বড়। ছোট করে পাঠান।', 413);
  if (bytes > 5.5e6) return fail('too_big', 'ফাইল অনেক বড় (সর্বোচ্চ প্রায় ৪ MB)।', 413);
  const caps = p.caps || {};
  for (const m of msgs) {
    m.files = m.files.filter((f) => f && f.data && f.mime);
    for (const f of m.files) {
      if (f.type === 'pdf' ? !caps.pdf : !caps.image) return fail('unsupported', 'এই AI ' + (f.type === 'pdf' ? 'PDF' : 'ছবি') + ' সরাসরি বুঝতে পারে না।', 400);
    }
  }
  if (!admin) {
    const st = await getSettings();
    const per = Number(p.daily_limit) || 0, tot = Number(st.daily_limit_user_total) || 0;
    if (per > 0 && (await countToday(user.id, p.slug)) >= per) return fail('limit', 'আজকের জন্য এই AI-এর ব্যবহারের সীমা শেষ। কাল আবার চেষ্টা করুন বা অন্য AI ব্যবহার করুন।', 429);
    if (tot > 0 && (await countToday(user.id)) >= tot) return fail('limit', 'আজকের জন্য মোট AI ব্যবহারের সীমা শেষ। কাল আবার চেষ্টা করুন।', 429);
  }

  const res = await callUpstream(p, key, SYSTEM, msgs, true, p.max_tokens);
  if (res.error) return fail(res.error[0], res.error[1], res.error[2]);
  const { up, timer } = res;
  const kind = p.kind;
  const enc = new TextEncoder(), dec = new TextDecoder();
  let outChars = 0;
  const body = new ReadableStream({
    async start(ctrl) {
      const send = (o) => ctrl.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
      const reader = up.body.getReader();
      let buf = '', done = false;
      try {
        while (!done) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
            const ev = buf.slice(0, i);
            buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
            for (const line of ev.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              if (data === '[DONE]') { done = true; break; }
              let j; try { j = JSON.parse(data); } catch { continue; }
              if (j.error) { send({ error: { code: 'provider_down', message: 'AI উত্তর দিতে গিয়ে সমস্যায় পড়েছে।' } }); done = true; break; }
              const t = deltaOf(kind, j);
              if (t) { outChars += t.length; send({ t }); }
            }
          }
        }
        send({ done: true, tokens_out: Math.ceil(outChars / 3) });
      } catch {
        send({ error: { code: 'provider_down', message: 'উত্তর আসার মাঝপথে সংযোগ কেটে গেছে।' } });
      } finally {
        clearTimeout(timer);
        logUsage(user.id, p.slug, 'chat', Math.ceil(chars / 3), Math.ceil(outChars / 3));
        ctrl.close();
      }
    },
    cancel() { clearTimeout(timer); try { up.body.cancel(); } catch { /* ignore */ } },
  });
  return new Response(body, { headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
}

// ---------- শ্রেণিবিন্যাস (শুধু অ্যাডমিন) ----------
async function classify(user, b) {
  const st = await getSettings();
  let p = null;
  const want = typeof st.classify_provider === 'string' ? st.classify_provider : '';
  if (want) p = await getProvider(want);
  if (!p || !p.enabled || p.mode !== 'api' || !keyOf(p)) {
    const r = await sb('ai_providers?select=*&enabled=eq.true&mode=eq.api&order=sort.asc');
    const all = r.ok ? await r.json() : [];
    p = all.find((x) => keyOf(x)) || null;
  }
  if (!p) return fail('no_ai', 'শ্রেণিবিন্যাসের জন্য কোনো AI সংযুক্ত নেই।', 503);
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((x) => ({
    i: x.i, q: String(x.q || '').slice(0, 500), o: Array.isArray(x.o) ? x.o.map((y) => String(y).slice(0, 120)) : [], t: String(x.t || '').slice(0, 200),
  }));
  if (!items.length) return fail('bad_request', 'কোনো প্রশ্ন নেই।', 400);
  const tax = (Array.isArray(b.taxonomy) ? b.taxonomy : []).slice(0, 300).map((x) => ({ grp: x.grp || '', chapter: x.chapter || '', lesson: x.lesson || '' }));
  const sys = 'You classify Bangladesh HSC exam questions into a subject structure. Reply with ONLY a JSON array, no other text.';
  const prompt =
    'Subject: ' + String(b.subject || '') + '\n' +
    'Known structure (use these exact names when they fit): ' + JSON.stringify(tax) + '\n' +
    'Rules:\n- Bangla: "grp" is "গদ্য" or "পদ্য" and "chapter" is the exact title of the prose piece or poem the question is about.\n' +
    '- English: "chapter" is the grammar/skill topic (e.g. Tense, Voice, Narration, Right Form of Verbs, Reading Comprehension).\n' +
    '- Other subjects: "chapter" is the textbook chapter and "lesson" the lesson/section inside it.\n' +
    '- If the question fits a known entry, use its exact name with confidence 0.6-1.\n' +
    '- If it clearly belongs to a textbook chapter not in the known structure, give that chapter name but confidence at most 0.55.\n' +
    '- If you cannot tell, use empty strings and confidence 0. Never guess wildly.\n' +
    'Return: [{"i":<same i>,"grp":"","chapter":"","lesson":"","confidence":0.0}] for every item.\n' +
    'Questions: ' + JSON.stringify(items);
  const res = await callUpstream(p, keyOf(p), sys, [{ role: 'user', content: prompt, files: [] }], false, 3000);
  if (res.error) return fail(res.error[0], res.error[1], res.error[2]);
  clearTimeout(res.timer);
  const out = textOf(p.kind, await res.up.json().catch(() => ({})));
  logUsage(user.id, p.slug, 'classify', Math.ceil(prompt.length / 3), Math.ceil(out.length / 3));
  let arr = [];
  try { arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)); } catch { /* খালি */ }
  const results = (Array.isArray(arr) ? arr : []).filter((x) => x && x.i !== undefined).map((x) => ({
    i: x.i, grp: String(x.grp || ''), chapter: String(x.chapter || ''), lesson: String(x.lesson || ''), confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)),
  }));
  return json({ provider: p.slug, results });
}

// ---------- অবস্থা ----------
async function status(user, admin) {
  const r = await sb('ai_providers?select=slug,mode,enabled,secret_name,daily_limit');
  const list = r.ok ? await r.json() : [];
  const ur = await sb('ai_usage?select=provider&kind=eq.chat&user_id=eq.' + user.id + '&created_at=gte.' + encodeURIComponent(dayStart()) + '&limit=2000');
  const used = {};
  (ur.ok ? await ur.json() : []).forEach((x) => { used[x.provider] = (used[x.provider] || 0) + 1; });
  return json({
    is_admin: admin,
    providers: list.map((p) => ({ slug: p.slug, ready: p.mode === 'api' && p.enabled && !!keyOf(p), key_set: !!keyOf(p), limit: p.daily_limit, used: used[p.slug] || 0 })),
  });
}

async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('method', 'POST ছাড়া চলবে না।', 405);
  const user = await getUser(req);
  if (!user) return fail('auth', 'আগে লগইন করুন।', 401);
  let b;
  try { b = await req.json(); } catch { return fail('bad_request', 'অনুরোধ পড়া যায়নি।', 400); }
  const admin = await isAdminUser(user.id);
  if (b.action === 'status') return status(user, admin);
  if (b.action === 'chat') return chat(user, admin, b);
  if (b.action === 'classify') return admin ? classify(user, b) : fail('forbidden', 'শুধু অ্যাডমিন।', 403);
  return fail('bad_request', 'অজানা কাজ।', 400);
}

if (typeof Deno !== 'undefined' && Deno.serve) Deno.serve(handler);
// পরীক্ষার জন্য
export { handler };
