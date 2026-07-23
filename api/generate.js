// api/generate.js  —  put this file at  <your-project>/api/generate.js  on Vercel.
//
// Daily pipeline in one server-side handler:
//   official feeds -> keyword de-duplication -> rank -> ONE model request -> passages
//
// Works with OpenAI, Google Gemini or Anthropic. Set ONE key and it picks the
// provider automatically:
//
//   OPENAI_API_KEY       -> https://api.openai.com/v1/chat/completions
//   GEMINI_API_KEY       -> https://generativelanguage.googleapis.com/v1beta/...
//   ANTHROPIC_API_KEY    -> https://api.anthropic.com/v1/messages
//
// Optional env:
//   AI_PROVIDER          openai | gemini | anthropic   (overrides auto-detection)
//   AI_MODEL             model id; see "picking a model" below
//   AI_MAX_TOKENS        default 32000
//   APP_SHARED_SECRET    if set, clients must send a matching x-app-secret header
//   DAILY_REQUEST_BUDGET soft cap per warm instance, default 6
//
// PICKING A MODEL
// Model ids change often, so nothing is hardcoded as gospel. Send
//   GET /api/generate?models=1
// and this function will ask your provider what it currently offers, then put
// the id you want in AI_MODEL. The defaults below are a best guess and may be
// stale; the models listing is the authoritative answer.

export const config = { maxDuration: 300 };

const DEFAULT_MODEL = {
  openai: "gpt-5.6-terra",      // cheap bulk-text tier; verify with ?models=1
  gemini: "gemini-3.5-flash",   // verify with ?models=1
  anthropic: "claude-sonnet-5"
};

const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 32000);
const MIN_WORDS = 420;      // hard floor: the app discards anything shorter
const TARGET_WORDS = 500;   // asked-for target, deliberately above the floor because
                            // models undershoot stated word counts almost every time
const MAX_HEADLINES = 10;
const MAX_VARIANTS = 3;
const FEED_TIMEOUT_MS = 8000;
const FEED_MAX_BYTES = 2000000;

function pickProvider() {
  const forced = String(process.env.AI_PROVIDER || "").toLowerCase().trim();
  if (forced === "openai" || forced === "gemini" || forced === "anthropic") {
    return { name: forced, key: providerKey(forced) };
  }
  if (process.env.OPENAI_API_KEY) return { name: "openai", key: process.env.OPENAI_API_KEY };
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
    return { name: "gemini", key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) return { name: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  return { name: "", key: "" };
}
function providerKey(name) {
  if (name === "openai") return process.env.OPENAI_API_KEY || "";
  if (name === "gemini") return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (name === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  return "";
}

/* ------------------------------------------------------------------ feeds -- */
const FEEDS = [
  { site: "PIB", weight: 3, url: "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3" },
  { site: "PRS India", weight: 3, url: "https://prsindia.org/theprsblog/feed" },
  { site: "RBI", weight: 2, url: "https://www.rbi.org.in/pressreleases_rss.xml" }
];
const GDELT =
  "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
  encodeURIComponent("sourcecountry:india (policy OR government OR parliament OR economy OR scheme OR court)") +
  "&mode=ArtList&format=json&maxrecords=60&sort=datedesc&timespan=3days";

const KEEP = /\b(cabinet|parliament|lok sabha|rajya sabha|supreme court|high court|budget|policy|scheme|mission|bill|act|amendment|ordinance|rbi|repo|gst|inflation|economy|gdp|export|import|infrastructure|railway|highway|metro|port|education|university|health|vaccine|isro|satellite|launch|defence|army|navy|border|agriculture|farmer|crop|msp|employment|jobs|skill|census|election|commission|ministry|governor|jammu|kashmir|ladakh|energy|solar|nuclear|climate|monsoon|flood|drought|digital|semiconductor|startup|trade|tariff|treaty|summit|g20|united nations|world bank|imf|reform|tax|subsidy|welfare|pension|women|tribal|panchayat|urban|water|river|forest|wildlife|tourism|heritage|judiciary|verdict|guidelines|regulation|framework|corridor|literacy|nutrition|sanitation)\b/i;
const DROP = /\b(box office|movie|film|actor|actress|bollywood|trailer|song|celebrity|astrology|horoscope|ipl|t20|odi|wicket|fifa|dies at|murder|rape|assault|suicide|viral video|watch:|photos:|live updates|betting|lottery|recipe|fashion|gossip|net worth|quiz)\b/i;
const INDIA = /\b(india|indian|bharat|new delhi|centre|union government|jammu|kashmir|ladakh|mumbai|bengaluru|chennai|kolkata|hyderabad|gujarat|maharashtra|punjab|bihar|assam|odisha|kerala|karnataka|rajasthan|uttar pradesh|madhya pradesh|tamil nadu|west bengal|telangana|andhra|haryana|himachal|uttarakhand|jharkhand|chhattisgarh|goa|manipur|nagaland|tripura|meghalaya|mizoram|arunachal|sikkim)\b/i;

const STOP = new Set(("about above after again against all also among and any are been before being between both but " +
  "can could did does down during each else even ever every few for from further had has have here how into its " +
  "just like made make many may more most much must new now off once only other our out over own said same shall " +
  "should since some such take than that the their them then there these they this those through under until upon " +
  "very was were what when where which while who whom why will with within without would year years today " +
  "shri smt says said told over under india indian govt government national union central state states minister " +
  "ministry department launched launches held holds meeting review new").split(" "));

function normalizeHeadline(raw) {
  let t = String(raw || "");
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ");
  t = t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
       .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
       .replace(/&#8217;|&rsquo;/gi, "'").replace(/&#8216;|&lsquo;/gi, "'")
       .replace(/&#8220;|&ldquo;|&#8221;|&rdquo;/gi, '"').replace(/&#8211;|&ndash;|&#8212;|&mdash;/gi, "-");
  t = t.replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019\u201a]/g, "'")
       .replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...")
       .replace(/\u20b9/g, "Rs. ").replace(/\u00a0/g, " ");
  t = t.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(LIVE|BREAKING|EXCLUSIVE|WATCH|VIDEO|OPINION|EDITORIAL|EXPLAINED)\s*[:|-]\s*/i, "");
  t = t.replace(/^["']|["']$/g, "").trim();
  if (t.split(/\s+/).length < 4 || t.length < 20 || t.length > 190) return "";
  if (!/[a-z]/.test(t)) return "";
  return t;
}
function keywordsOf(h) {
  const raw = String(h || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
  const set = new Set();
  for (let w of raw) {
    if (w.length < 4 || STOP.has(w)) continue;
    if (w.length > 5 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    set.add(w);
  }
  return set;
}
function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}
const SIMILAR_AT = 0.6;

function signatureOf(list) {
  const s = list.map((h) => Array.from(keywordsOf(h.headline)).sort().join(".")).sort().join("|");
  let hash = 5381;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
function scoreHeadline(c) {
  let s = c.weight * 3;
  if (KEEP.test(c.headline)) s += 6;
  if (INDIA.test(c.headline)) s += 3;
  const w = c.headline.split(/\s+/).length;
  if (w >= 7 && w <= 22) s += 2;
  s += Math.min(4, c.keywords.size / 2);
  if (c.date) {
    const age = (Date.now() - Date.parse(c.date)) / 3600000;
    if (age <= 24) s += 4; else if (age <= 48) s += 2; else if (age > 168) s -= 3;
  }
  return s;
}

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (typing-practice-tool; headline reader)",
        Accept: "application/rss+xml,application/xml,text/xml,application/json,*/*"
      }
    });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > FEED_MAX_BYTES) return null;
    return Buffer.from(buf).toString("utf-8");
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Only <title> and the date are read; no article body enters this process.
function parseFeedTitles(xml, feed) {
  const out = [];
  const blocks = String(xml || "").match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const tm = b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (!tm) continue;
    const headline = normalizeHeadline(tm[1]);
    if (!headline) continue;
    const dm = b.match(/<(pubDate|published|updated|dc:date)\b[^>]*>([\s\S]*?)<\/\1>/i);
    let date = null;
    if (dm) {
      const d = new Date(dm[2].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
      if (!isNaN(d)) date = d.toISOString();
    }
    out.push({ headline, site: feed.site, weight: feed.weight, date });
  }
  return out;
}

async function collectHeadlines() {
  const status = [];
  const settled = await Promise.all(
    FEEDS.map(async (f) => {
      const xml = await getText(f.url);
      if (!xml) { status.push(f.site + " x"); return []; }
      const items = parseFeedTitles(xml, f);
      status.push(f.site + " " + items.length);
      return items;
    })
  );

  const all = [];
  let dupes = 0;
  const add = (it) => {
    if (DROP.test(it.headline)) return;
    it.keywords = keywordsOf(it.headline);
    if (it.keywords.size < 3) return;
    for (const seen of all) {
      if (overlapRatio(it.keywords, seen.keywords) >= SIMILAR_AT) { dupes++; return; }
    }
    all.push(it);
  };
  for (const list of settled) for (const it of list) add(it);

  if (all.length < 10) {
    const raw = await getText(GDELT);
    let j = null;
    try { j = JSON.parse(raw || "null"); } catch (e) {}
    for (const a of (j && j.articles) || []) {
      const headline = normalizeHeadline(a.title);
      if (!headline) continue;
      let date = null;
      const m = String(a.seendate || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
      if (m) date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString();
      add({ headline, site: "GDELT", weight: 1, date });
    }
    status.push("GDELT " + all.length);
  }
  return { all, status: status.join(" | ") + (dupes ? " | " + dupes + " near-duplicates dropped" : "") };
}

function pickHeadlines(cands, n) {
  const scored = cands.map((c) => ({ c, s: scoreHeadline(c) })).sort((a, b) => b.s - a.s);
  const chosen = [], perSite = {};
  const cap = Math.max(4, Math.ceil(n * 0.7));
  for (const { c } of scored) {
    if (chosen.length >= n) break;
    if ((perSite[c.site] || 0) >= cap) continue;
    perSite[c.site] = (perSite[c.site] || 0) + 1;
    chosen.push(c);
  }
  for (const { c } of scored) { if (chosen.length >= n) break; if (chosen.indexOf(c) < 0) chosen.push(c); }
  return chosen.slice(0, n);
}

/* --------------------------------------------------------------- prompting -- */
const SYSTEM =
  "You write original practice passages for Indian government typing and stenography tests, " +
  "such as the JKSSB Junior Assistant and SSC skill tests. You are given only news headlines. " +
  "You do not have the underlying articles and must never pretend to quote or summarise them. " +
  "Each headline is only a topic seed: you write fresh, self-contained explanatory prose about " +
  "that subject in the register of an Indian newspaper's background or explainer column.";

const ANGLES = [
  { key: "core",
    brief: "the development itself: what the measure or decision is, which body is responsible for it, how the mechanism works in practice, and what it is meant to achieve" },
  { key: "context",
    brief: "the background: how this area of policy or administration developed over time, what earlier arrangements existed, which institutions and laws govern it, and why the subject keeps returning to public attention" },
  { key: "impact",
    brief: "the adjacent ground: who is affected and in what way, the practical difficulties of implementation at district and state level, the related policy areas it touches, and what usually determines whether such efforts succeed" }
];

function buildPrompt(headlines, day, variants) {
  const list = headlines.map((h, i) => i + 1 + ". " + h).join("\n");
  const angles = ANGLES.slice(0, variants)
    .map((a, i) => "  " + (i + 1) + '. angle "' + a.key + '" - ' + a.brief)
    .join("\n");
  const total = headlines.length * variants;
  return [
    "Today is " + day + " (India). Below are " + headlines.length + " headlines.",
    "",
    "HEADLINES",
    list,
    "",
    "WHAT TO PRODUCE",
    "For EACH headline write " + variants + " separate passages, one from each of these angles:",
    angles,
    "",
    "That is " + total + " passages in total. Each one is read on its own by a different candidate, so each must",
    "stand alone and make sense without the others. Passages from the same headline must not repeat each",
    "other's sentences, examples or opening formula, and must not simply restate the same material in",
    "different words. Treat the headline as a starting point and write about the wider subject it belongs to.",
    "",
    "RULES FOR EVERY PASSAGE",
    "1. Length: aim for about " + TARGET_WORDS + " words. The finished passage must NEVER be shorter than " + MIN_WORDS + " words:",
    "   anything shorter is thrown away and the work is wasted. Running slightly long is fine, running short is not.",
    "   Do not wind up early. If you are near the end and short of length, add another substantive paragraph.",
    "2. Completely new, self-contained explanatory writing. Do not summarise any news report and do not merely restate the headline.",
    "3. Tone: neutral, factual, impersonal newspaper prose in clear Indian English. No opinions, no advocacy, no predictions, no rhetorical questions, no direct address to the reader.",
    "4. No quotations of any kind. Never attribute a statement to a named person or body. Do not invent figures, dates, rupee amounts, percentages or case names. Prefer established general background over specific numbers you cannot verify.",
    "5. Plain continuous prose only. No markdown, no headings, no bullet points, no numbered lists, no bold or italic marks, no emoji, no URLs, no parenthetical citations.",
    "6. Plain ASCII characters only: straight quotes and apostrophes, ordinary hyphens, no em dashes, no curly quotes, no rupee symbol (write Rs. instead).",
    "7. Typing-test readability: complete sentences of ordinary length, ordinary punctuation, no long strings of capitals, no more than a light sprinkling of abbreviations, and no tables or figures.",
    "8. Write FIVE paragraphs of roughly 100 words each, which is about six to seven sentences per paragraph.",
    "   Join them into a single continuous string separated by ordinary spaces. Counting paragraphs and sentences",
    "   is more reliable than counting words, so use that as your guide to reaching the length.",
    "",
    "TITLE",
    "Every passage gets its own descriptive title of four to nine words saying what that passage is actually about.",
    "Titles must not repeat the headline, must not be generic labels such as Passage, Article, Part 1 or Current Affairs,",
    "must not end with a full stop, and no two titles in the whole set may be alike.",
    "",
    "DIFFICULTY",
    "Assign Easy, Medium or Hard to each passage using these definitions, and vary them so the whole set contains a mixture:",
    "Easy: average sentence about 13 to 16 words, everyday vocabulary, almost no abbreviations or figures.",
    "Medium: average sentence about 17 to 21 words, some official or administrative vocabulary, one or two abbreviations.",
    "Hard: average sentence about 22 words or more, formal administrative and legal vocabulary, several proper nouns and abbreviations.",
    "",
    "OUTPUT",
    "Reply with JSON only: a single object with one key, passages, holding an array of " + total + " objects",
    "grouped headline by headline in the order listed above. Each object has exactly these keys:",
    '{"passages":[{"headline":"<the exact headline text given to you>","angle":"core|context|impact","title":"<descriptive title>","difficulty":"Easy|Medium|Hard","passage":"<the full passage as one string>"}]}',
    "No text before or after the JSON. No code fences."
  ].join("\n");
}

/* ------------------------------------------------------- response decoding -- */
// Collects every balanced {...} at any depth, so this survives a wrapper object,
// a bare array, or a reply cut short by a token limit.
function balancedObjects(t) {
  const out = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") stack.push(i);
    else if (c === "}" && stack.length) out.push(t.slice(stack.pop(), i + 1));
  }
  return out;
}
function looksLikePassage(o) {
  return o && typeof o === "object" && typeof o.passage === "string" &&
         o.passage.split(/\s+/).filter(Boolean).length >= 200;
}
function normalizeItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of ["passages", "items", "data", "results", "output"]) {
      if (Array.isArray(parsed[k])) return parsed[k];
    }
    if (looksLikePassage(parsed)) return [parsed];
  }
  return null;
}
function extractItems(txt) {
  let t = String(txt || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const n = normalizeItems(JSON.parse(t)); if (n && n.length) return n; } catch (e) {}
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) {
    const slice = t.slice(a, b + 1);
    try { const j = JSON.parse(slice); if (Array.isArray(j) && j.length) return j; } catch (e) {}
    try { const j = JSON.parse(slice.replace(/,\s*([\]}])/g, "$1")); if (Array.isArray(j) && j.length) return j; } catch (e) {}
  }
  const salvaged = [];
  for (const chunk of balancedObjects(t)) {
    try { const o = JSON.parse(chunk); if (looksLikePassage(o)) salvaged.push(o); } catch (e) {}
  }
  return salvaged.length ? salvaged : null;
}

/* ------------------------------------------------------------- providers --- */
async function callOpenAI(key, model, prompt, signal) {
  // Newer models want max_completion_tokens and reject temperature; older ones
  // want max_tokens. Start modern, then adapt to whatever the API complains about.
  let body = {
    model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    max_completion_tokens: MAX_TOKENS,
    temperature: 0.7,
    response_format: { type: "json_object" }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const j = await r.json();
      const choice = (j.choices || [])[0] || {};
      return {
        text: (choice.message && choice.message.content) || "",
        truncated: choice.finish_reason === "length",
        raw: j
      };
    }
    const detail = ((await r.text()) || "").replace(/\s+/g, " ").slice(0, 400);
    if (r.status === 400 && attempt < 2) {
      const d = detail.toLowerCase();
      if (d.includes("max_completion_tokens") && "max_completion_tokens" in body) {
        delete body.max_completion_tokens; body.max_tokens = MAX_TOKENS; continue;
      }
      if (d.includes("max_tokens") && "max_tokens" in body) {
        delete body.max_tokens; body.max_completion_tokens = MAX_TOKENS; continue;
      }
      if (d.includes("temperature") && "temperature" in body) { delete body.temperature; continue; }
      if (d.includes("response_format") && body.response_format) { delete body.response_format; continue; }
    }
    const err = new Error("openai HTTP " + r.status + " " + detail);
    err.http = r.status;
    throw err;
  }
  throw new Error("openai: request could not be shaped for this model");
}

async function callGemini(key, model, prompt, signal) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(model) + ":generateContent";
  const r = await fetch(url, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: MAX_TOKENS,
        responseMimeType: "application/json"
      }
    })
  });
  if (!r.ok) {
    const detail = ((await r.text()) || "").replace(/\s+/g, " ").slice(0, 400);
    const err = new Error("gemini HTTP " + r.status + " " + detail);
    err.http = r.status;
    throw err;
  }
  const j = await r.json();
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
  return { text, truncated: cand.finishReason === "MAX_TOKENS", raw: j };
}

async function callAnthropic(key, model, prompt, signal) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: MAX_TOKENS, temperature: 0.7,
      system: SYSTEM, messages: [{ role: "user", content: prompt }]
    })
  });
  if (!r.ok) {
    const detail = ((await r.text()) || "").replace(/\s+/g, " ").slice(0, 400);
    const err = new Error("anthropic HTTP " + r.status + " " + detail);
    err.http = r.status;
    throw err;
  }
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, truncated: j.stop_reason === "max_tokens", raw: j };
}

async function callModel(provider, key, model, prompt, signal) {
  if (provider === "openai") return callOpenAI(key, model, prompt, signal);
  if (provider === "gemini") return callGemini(key, model, prompt, signal);
  return callAnthropic(key, model, prompt, signal);
}

// Transient server-side failures: the model is up, it is just busy right now.
// 429 is deliberately NOT here. At one request per day a per-minute rate limit is
// unreachable, so a 429 means the daily quota is gone and retrying only burns time.
const RETRY_STATUS = new Set([500, 502, 503, 504, 529]);
// EVERY attempt counts against a per-day request quota, even one the provider
// turns away. On a free tier that is the scarce resource, so retry once and no
// more. Raise AI_RETRIES only if your plan is metered by tokens, not requests.
const RETRIES = Math.max(0, Math.min(3, Number(process.env.AI_RETRIES ?? 1)));
const RETRY_WAITS = [6000, 15000, 30000].slice(0, RETRIES);

async function callModelWithRetry(provider, key, model, prompt, signal) {
  let attempts = 0, last = null;
  for (let i = 0; i <= RETRY_WAITS.length; i++) {
    try {
      attempts++;
      const out = await callModel(provider, key, model, prompt, signal);
      out.attempts = attempts;
      return out;
    } catch (e) {
      last = e;
      if (e && e.name === "AbortError") throw e;
      if (i < RETRY_WAITS.length && RETRY_STATUS.has(e && e.http)) {
        await new Promise((r) => setTimeout(r, RETRY_WAITS[i]));
        continue;
      }
      if (last) last.attempts = attempts;
      throw last;
    }
  }
  throw last;
}

/* Ask the provider what model ids it currently offers. */
async function listModels(provider, key) {
  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer " + key } });
    if (!r.ok) return { error: "HTTP " + r.status };
    const j = await r.json();
    return { models: (j.data || []).map((m) => m.id).sort() };
  }
  if (provider === "gemini") {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": key }
    });
    if (!r.ok) return { error: "HTTP " + r.status };
    const j = await r.json();
    return {
      models: (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0)
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .sort()
    };
  }
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
  });
  if (!r.ok) return { error: "HTTP " + r.status };
  const j = await r.json();
  return { models: (j.data || []).map((m) => m.id).sort() };
}

const budget = { day: "", used: 0 };
const LIMIT = Number(process.env.DAILY_REQUEST_BUDGET || 6);
function istDay() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }

/* ---------------------------------------------------------------- handler -- */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-secret");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { name: provider, key } = pickProvider();
  const model = process.env.AI_MODEL || DEFAULT_MODEL[provider] || "";
  const modelSource = process.env.AI_MODEL ? "AI_MODEL" : "built-in default";

  if (!provider || !key) {
    return res.status(501).json({
      error: "no provider key set",
      hint: "set OPENAI_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY in the deployment environment"
    });
  }

  // GET /api/generate?models=1  -> what can AI_MODEL be set to right now
  if (req.method === "GET") {
    const wantsModels = String((req.query && req.query.models) || "") ||
                        (String(req.url || "").indexOf("models=") >= 0 ? "1" : "");
    if (!wantsModels) return res.status(405).json({ error: "use POST, or GET ?models=1" });
    const out = await listModels(provider, key);
    return res.status(out.error ? 502 : 200).json({ provider, configuredModel: model, modelSource, ...out });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const secret = process.env.APP_SHARED_SECRET;
  if (secret && req.headers["x-app-secret"] !== secret) return res.status(401).json({ error: "unauthorised" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: "bad JSON body" }); }
  }
  body = body || {};

  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || "")) ? body.day : istDay();
  const count = Math.max(3, Math.min(MAX_HEADLINES, Number(body.count) || MAX_HEADLINES));
  const variants = Math.max(1, Math.min(MAX_VARIANTS, Number(body.variants) || 2));
  const knownSignature = String(body.knownSignature || "");

  // A caller that already has today's headlines (because a previous attempt got
  // that far and then failed at the model step) can send them back, so a retry
  // costs no feed requests at all.
  let picked = null, status = "";
  const supplied = Array.isArray(body.headlines) ? body.headlines : null;
  if (supplied && supplied.length >= 3) {
    picked = supplied
      .map((x) => {
        const headline = normalizeHeadline(typeof x === "string" ? x : (x && x.headline));
        if (!headline) return null;
        const site = String((x && x.site) || "cached").slice(0, 40);
        const date = (x && x.date && !isNaN(new Date(x.date))) ? new Date(x.date).toISOString() : null;
        return { headline, site, weight: 1, date, keywords: keywordsOf(headline) };
      })
      .filter(Boolean)
      .slice(0, MAX_HEADLINES);
    if (picked.length < 3) picked = null;
    else status = "supplied by client (" + picked.length + " cached headlines, no feeds fetched)";
  }

  if (!picked) {
    const got = await collectHeadlines();
    status = got.status;
    if (!got.all.length)
      return res.status(502).json({ error: "no headline feed could be reached", stage: "feeds", feeds: status });
    picked = pickHeadlines(got.all, count);
  }
  const signature = signatureOf(picked);
  const headlineOut = picked.map((h) => ({ headline: h.headline, site: h.site, date: h.date }));

  if (knownSignature && knownSignature === signature) {
    return res.status(200).json({ day, signature, unchanged: true, feeds: status, provider, model, modelSource,
                                 headlines: headlineOut, count: 0, passages: [] });
  }

  if (budget.day !== day) { budget.day = day; budget.used = 0; }
  if (budget.used >= LIMIT) return res.status(429).json({ error: "daily generation budget reached on this instance", stage: "budget", feeds: status, signature, headlines: headlineOut });
  budget.used++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 280000);
  try {
    const prompt = buildPrompt(picked.map((h) => h.headline), day, variants);
    const out = await callModelWithRetry(provider, key, model, prompt, controller.signal);
    clearTimeout(timer);

    const items = extractItems(out.text);
    if (!items) {
      return res.status(502).json({
        error: "model did not return usable JSON",
        stage: "model", provider, model, modelSource, feeds: status, signature, headlines: headlineOut,
        sample: String(out.text || "").replace(/\s+/g, " ").slice(0, 200)
      });
    }

    const passages = items
      .map((it) => ({
        headline: String((it && it.headline) || "").slice(0, 190),
        angle: /^(core|context|impact)$/.test(String(it && it.angle)) ? it.angle : "",
        title: String((it && it.title) || "").slice(0, 120),
        difficulty: /^(Easy|Medium|Hard)$/.test(String(it && it.difficulty)) ? it.difficulty : "Medium",
        passage: String((it && (it.passage || it.text || it.body)) || "")
      }))
      // Floor only. Nothing is rejected for being long: the client applies the real
      // 420-word gate, and an over-length passage is simply more typing practice.
      .filter((p) => p.passage.split(/\s+/).filter(Boolean).length >= 250);

    if (!passages.length) {
      const counts = items.map((it) => String((it && (it.passage || it.text || it.body)) || "")
        .split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
      return res.status(502).json({
        error: "no usable passages in model output", stage: "model", provider, model, modelSource, feeds: status,
        signature, headlines: headlineOut, returned: items.length, wordCounts: counts
      });
    }

    return res.status(200).json({
      day, signature, unchanged: false,
      provider, model, modelSource, feeds: status, variants,
      expected: picked.length * variants,
      truncated: !!out.truncated,
      headlines: headlineOut,
      count: passages.length,
      passages
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === "AbortError";
    const msg = String((e && e.message) || e);
    // A wrong or retired model id is the most common failure, so say so plainly.
    const http = (e && e.http) || 0;
    const badModel = /\b404\b|not\s*found|does not exist|unsupported\s+model|invalid\s+model|no\s+such\s+model|is not supported/i.test(msg);
    const retryable = RETRY_STATUS.has(http) || /high demand|overload|unavailable|try again later|temporarily/i.test(msg);
    return res.status(aborted ? 504 : 502).json({
      error: aborted ? "model request timed out" : msg.slice(0, 400),
      stage: "model", provider, model, modelSource, feeds: status, signature, headlines: headlineOut,
      providerStatus: http || undefined,
      attempts: (e && e.attempts) || 1,
      retryable: retryable || undefined,
      hint: badModel ? "check the model id with GET /api/generate?models=1 and set AI_MODEL" : undefined
    });
  }
}
