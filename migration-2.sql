-- THE LEARNER — migration 2 (প্রশ্ন ব্যবস্থাপনা + AI হাব)
-- নিরাপদ: বারবার চালালেও সমস্যা নেই। বিদ্যমান টেবিল/ডেটা মুছে না।
-- চালানোর আগে ব্যাকআপ নিন (Admin Panel → Backup ট্যাব থেকে JSON নামিয়ে নিন)।
-- নিয়ম: প্রতিটি ব্লক আলাদা করে Run করা নিরাপদ। কোনো ফাংশন বা $$ ব্যবহার করা হয়নি।

-- ============ ব্লক ক: প্রশ্নের কাঠামো (বিষয় > অধ্যায় > পাঠ) ============
create table if not exists public.taxonomy (
  id bigint generated always as identity primary key,
  subject text not null,
  grp text not null default '',
  chapter text not null,
  lesson text not null default '',
  keywords text not null default '',
  sort int not null default 0
);
alter table public.taxonomy enable row level security;
drop policy if exists "tx read" on public.taxonomy;
drop policy if exists "tx write" on public.taxonomy;
create policy "tx read" on public.taxonomy for select to authenticated using (true);
create policy "tx write" on public.taxonomy for all to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

-- ============ ব্লক খ: প্রশ্ন পরিবর্তনের ইতিহাস ============
create table if not exists public.question_history (
  id bigint generated always as identity primary key,
  question_id bigint,
  action text not null,
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now(),
  before jsonb,
  after jsonb
);
alter table public.question_history enable row level security;
drop policy if exists "qh admin" on public.question_history;
create policy "qh admin" on public.question_history for all to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

-- প্রশ্ন শুধু অ্যাডমিন যোগ/সম্পাদনা/মুছতে পারবে (শিক্ষার্থীদের প্রকাশের অনুমতি বন্ধ)
drop policy if exists "pq insert" on public.public_questions;
drop policy if exists "pq approve" on public.public_questions;
drop policy if exists "pq delete" on public.public_questions;
create policy "pq insert" on public.public_questions for insert to authenticated
  with check (owner = auth.uid() and exists (select 1 from public.app_admins a where a.user_id = auth.uid()));
create policy "pq approve" on public.public_questions for update to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));
create policy "pq delete" on public.public_questions for delete to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

-- ============ ব্লক গ: AI প্রদানকারী ============
create table if not exists public.ai_categories (
  id bigint generated always as identity primary key,
  slug text unique not null,
  name text not null,
  sort int not null default 0
);
create table if not exists public.ai_providers (
  id bigint generated always as identity primary key,
  slug text unique not null,
  name text not null,
  category text not null default 'general',
  descr text not null default '',
  logo_url text not null default '',
  link text not null default '',
  tos_url text not null default '',
  mode text not null default 'link',
  kind text not null default 'openai',
  base_url text not null default '',
  model text not null default '',
  secret_name text not null default '',
  enabled boolean not null default true,
  daily_limit int not null default 30,
  max_tokens int not null default 1024,
  caps jsonb not null default '{"image":false,"pdf":false}',
  sort int not null default 0
);
create table if not exists public.ai_settings (
  key text primary key,
  value jsonb not null default 'null'
);
alter table public.ai_categories enable row level security;
alter table public.ai_providers enable row level security;
alter table public.ai_settings enable row level security;
drop policy if exists "aic read" on public.ai_categories;
drop policy if exists "aic write" on public.ai_categories;
drop policy if exists "aip read" on public.ai_providers;
drop policy if exists "aip write" on public.ai_providers;
drop policy if exists "ais read" on public.ai_settings;
drop policy if exists "ais write" on public.ai_settings;
create policy "aic read" on public.ai_categories for select to authenticated using (true);
create policy "aip read" on public.ai_providers for select to authenticated using (true);
create policy "ais read" on public.ai_settings for select to authenticated using (true);
create policy "aic write" on public.ai_categories for all to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));
create policy "aip write" on public.ai_providers for all to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));
create policy "ais write" on public.ai_settings for all to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

-- ============ ব্লক ঘ: চ্যাট ইতিহাস ও ব্যবহারের হিসাব ============
create table if not exists public.ai_chats (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  title text not null default 'নতুন চ্যাট',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.ai_messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null references public.ai_chats(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  role text not null,
  provider text not null default '',
  model text not null default '',
  content text not null default '',
  files jsonb not null default '[]',
  grp text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  provider text not null,
  kind text not null default 'chat',
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.ai_chats enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_usage enable row level security;
drop policy if exists "chat own" on public.ai_chats;
drop policy if exists "msg own" on public.ai_messages;
drop policy if exists "use own read" on public.ai_usage;
drop policy if exists "use admin read" on public.ai_usage;
create policy "chat own" on public.ai_chats for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "msg own" on public.ai_messages for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "use own read" on public.ai_usage for select to authenticated using (user_id = auth.uid());
create policy "use admin read" on public.ai_usage for select to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));
-- ai_usage-এ লেখে শুধু ব্যাকএন্ড ফাংশন (service role), তাই লেখার নিয়ম নেই।

-- ============ ব্লক ঙ: শুরুর তথ্য (নিজে বদলাতে পারবেন) ============
insert into public.ai_categories (slug, name, sort) values
  ('general', 'সাধারণ সহায়ক', 1),
  ('research', 'গবেষণা ও উৎসসহ উত্তর', 2),
  ('study', 'পড়াশোনা-কেন্দ্রিক', 3)
on conflict (slug) do nothing;

insert into public.ai_providers (slug, name, category, descr, link, tos_url, mode, kind, base_url, model, secret_name, caps, sort) values
  ('chatgpt', 'ChatGPT (OpenAI)', 'general', 'সব ধরনের প্রশ্নের উত্তর, লেখা, ব্যাখ্যা ও কোড সাহায্য।', 'https://chatgpt.com', 'https://openai.com/policies/terms-of-use', 'api', 'openai', '', 'gpt-4o-mini', 'AI_KEY_OPENAI', '{"image":true,"pdf":false}', 1),
  ('gemini', 'Google Gemini', 'general', 'গুগলের AI; ছবি ও দীর্ঘ লেখা বুঝতে ভালো।', 'https://gemini.google.com', 'https://policies.google.com/terms', 'api', 'gemini', '', 'gemini-2.5-flash', 'AI_KEY_GEMINI', '{"image":true,"pdf":true}', 2),
  ('claude', 'Claude (Anthropic)', 'general', 'বিস্তারিত ব্যাখ্যা ও দীর্ঘ লেখা বিশ্লেষণে দক্ষ।', 'https://claude.ai', 'https://www.anthropic.com/legal/consumer-terms', 'api', 'anthropic', '', 'claude-haiku-5-5', 'AI_KEY_ANTHROPIC', '{"image":true,"pdf":true}', 3),
  ('deepseek', 'DeepSeek', 'general', 'যুক্তি ও গণিতের সমস্যায় জনপ্রিয় AI।', 'https://chat.deepseek.com', 'https://www.deepseek.com', 'api', 'openai', 'https://api.deepseek.com', 'deepseek-chat', 'AI_KEY_DEEPSEEK', '{"image":false,"pdf":false}', 4),
  ('perplexity', 'Perplexity AI', 'research', 'ইন্টারনেট থেকে উৎস উল্লেখ করে উত্তর দেয়।', 'https://www.perplexity.ai', 'https://www.perplexity.ai/hub/legal/terms-of-service', 'api', 'openai', 'https://api.perplexity.ai', 'sonar', 'AI_KEY_PERPLEXITY', '{"image":false,"pdf":false}', 5),
  ('notebooklm', 'Google NotebookLM', 'study', 'নিজের বই, PDF ও নোট থেকে উৎস-ভিত্তিক উত্তর, সারাংশ, স্টাডি গাইড, অডিও ওভারভিউ ও মাইন্ড ম্যাপ।', 'https://notebooklm.google.com', 'https://policies.google.com/terms', 'link', 'openai', '', '', '', '{"image":false,"pdf":false}', 6),
  ('copilot', 'Microsoft Copilot', 'general', 'মাইক্রোসফটের AI সহায়ক, অফিস ও ওয়েব সার্চের সাথে যুক্ত।', 'https://copilot.microsoft.com', 'https://www.microsoft.com/servicesagreement', 'link', 'openai', '', '', '', '{"image":false,"pdf":false}', 7),
  ('khanmigo', 'Khanmigo (Khan Academy)', 'study', 'শিক্ষার্থীর জন্য তৈরি টিউটর-ধাঁচের AI (গণিত, বিজ্ঞান ইত্যাদি)।', 'https://www.khanmigo.ai', 'https://www.khanacademy.org/about/tos', 'link', 'openai', '', '', '', '{"image":false,"pdf":false}', 8)
on conflict (slug) do nothing;

insert into public.ai_settings (key, value) values
  ('daily_limit_user_total', '60'),
  ('classify_provider', '"claude"')
on conflict (key) do nothing;

-- ============ ব্লক চ: কাঠামোর শুরুর তালিকা (ICT, English, গন্তব্য কাবুল) ============
-- বাকি বিষয়ের অধ্যায় আপনার সিলেবাস অনুযায়ী Admin Panel → Structure ট্যাবে যোগ করুন।
insert into public.taxonomy (subject, grp, chapter, lesson, keywords, sort)
select v.subject, v.grp, v.chapter, v.lesson, v.keywords, v.sort
from (values
  ('ICT', '', 'অধ্যায় ১: তথ্য ও যোগাযোগ প্রযুক্তি – বিশ্ব ও বাংলাদেশ প্রেক্ষিত', '', 'বিশ্বগ্রাম,ভার্চুয়াল রিয়েলিটি,রোবটিক্স,কৃত্রিম বুদ্ধিমত্তা,ই-কমার্স,বায়োমেট্রিক্স,ন্যানো,ক্রায়োসার্জারি,তথ্য ও যোগাযোগ প্রযুক্তি,জিনোম,মহাকাশ,ডিজিটাল বাংলাদেশ', 1),
  ('ICT', '', 'অধ্যায় ২: কমিউনিকেশন সিস্টেমস ও কম্পিউটার নেটওয়ার্কিং', '', 'নেটওয়ার্ক,ডেটা কমিউনিকেশন,ব্যান্ডউইথ,ট্রান্সমিশন,টপোলজি,রাউটার,ক্লাউড কম্পিউটিং,ওয়াইফাই,ব্লুটুথ,মডেম,সিম্প্লেক্স,ফাইবার অপটিক,ওয়্যারলেস,মোবাইল যোগাযোগ,জিপিএস', 2),
  ('ICT', '', 'অধ্যায় ৩: সংখ্যা পদ্ধতি ও ডিজিটাল ডিভাইস', '', 'বাইনারি,দ্বিঅঙ্কিক,অক্টাল,হেক্সাডেসিমাল,বুলিয়ান,লজিক গেট,অ্যাডার,এনকোডার,ডিকোডার,ফ্লিপ-ফ্লপ,ASCII,ইউনিকোড,বাইট,বিট,সংখ্যা পদ্ধতি,পরিপূরক,রেজিস্টার,কাউন্টার', 3),
  ('ICT', '', 'অধ্যায় ৪: ওয়েব ডিজাইন পরিচিতি ও HTML', '', 'HTML,ট্যাগ,হাইপারলিংক,ওয়েব পেজ,ওয়েবসাইট,ওয়েব ডিজাইন,ব্রাউজার,URL,হোম পেজ,WWW,ওয়েব সার্ভার,CSS,ওয়েব পোর্টাল', 4),
  ('ICT', '', 'অধ্যায় ৫: প্রোগ্রামিং ভাষা', '', 'প্রোগ্রামিং,অ্যালগরিদম,ফ্লোচার্ট,কম্পাইলার,ইন্টারপ্রেটার,ভেরিয়েবল,লুপ,সোর্স কোড,অ্যাসেম্বলি,মেশিন ভাষা,printf,scanf,C ভাষা,ডিবাগিং', 5),
  ('ICT', '', 'অধ্যায় ৬: ডেটাবেজ ম্যানেজমেন্ট সিস্টেম', '', 'ডেটাবেজ,ডেটাবেস,DBMS,টেবিল,রেকর্ড,ফিল্ড,প্রাইমারি কি,SQL,রিলেশনাল,এন্টিটি,ডেটা ম্যানেজমেন্ট', 6),
  ('ইংরেজি', '', 'Tense', '', 'tense,present indefinite,past indefinite,future,perfect,continuous,has been,have been,had been,will have,পূর্ণ বর্তমান', 1),
  ('ইংরেজি', '', 'Voice', '', 'voice,passive,active,is being,was being,by the,changed into passive,কর্মবাচ্য', 2),
  ('ইংরেজি', '', 'Narration', '', 'narration,direct speech,indirect speech,said to,told,asked,exclaimed,reported speech,উক্তি', 3),
  ('ইংরেজি', '', 'Transformation of Sentences', '', 'transformation,simple sentence,complex sentence,compound sentence,assertive,interrogative,exclamatory,negative,affirmative,বাক্য রূপান্তর', 4),
  ('ইংরেজি', '', 'Right Form of Verbs', '', 'right form of verbs,right form,fill in the blank,___,____,verb in bracket,gerund,infinitive,participle', 5),
  ('ইংরেজি', '', 'Parts of Speech', '', 'parts of speech,noun,pronoun,adjective,adverb,preposition,conjunction,interjection,article', 6),
  ('ইংরেজি', '', 'Reading Comprehension', '', 'reading,passage,comprehension,according to the passage,paragraph,unseen', 7),
  ('ইংরেজি', '', 'Vocabulary', '', 'synonym,antonym,meaning of,vocabulary,word meaning,idiom,phrase,proverb', 8),
  ('ইংরেজি', '', 'Writing', '', 'writing,paragraph writing,composition,letter,application,email,essay,story writing', 9),
  ('বাংলা', 'গদ্য', 'গন্তব্য কাবুল', '', 'গন্তব্য কাবুল,সৈয়দ মুজতবা আলী,মুজতবা,কাবুল,পেশাওয়ার,খাইবার,সর্দারজি,আফগান,জালালাবাদ,দেশে বিদেশে,ফিরিঙ্গি,পুস্তিন,টাঙা,হাওড়া স্টেশন,বুখারা,শিলওয়ার', 1)
) as v(subject, grp, chapter, lesson, keywords, sort)
where not exists (select 1 from public.taxonomy t where t.subject = v.subject and t.chapter = v.chapter and t.grp = v.grp);

-- ============ ব্লক ছ: "প্রশ্ন-সহ অফিসিয়াল সাইট খোলা" লিংক (বিনামূল্যের লঞ্চারের জন্য) ============
-- না চালালেও লঞ্চার চলে (অ্যাপের ভেতরে ডিফল্ট আছে); চালালে অ্যাডমিন প্যানেল থেকে লিংক বদলানো যাবে।
alter table public.ai_providers add column if not exists launch_url text not null default '';
update public.ai_providers set launch_url = 'https://chatgpt.com/?q={q}' where slug = 'chatgpt' and launch_url = '';
update public.ai_providers set launch_url = 'https://claude.ai/new?q={q}' where slug = 'claude' and launch_url = '';
update public.ai_providers set launch_url = 'https://www.perplexity.ai/search?q={q}' where slug = 'perplexity' and launch_url = '';
update public.ai_providers set launch_url = 'https://copilot.microsoft.com/?q={q}' where slug = 'copilot' and launch_url = '';
