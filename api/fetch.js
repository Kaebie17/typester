// api/fetch.js  —  put this file at  <your-project>/api/fetch.js  on Vercel.
// Hardened same-origin proxy: only fetches an explicit allowlist of sites,
// blocks internal addresses, caps size, and times out. This removes the
// public-proxy dependency AND the open-proxy / SSRF risks.

const ALLOW_HOSTS = [
  "pib.gov.in",
  "www.pib.gov.in",
  "theconversation.com",
  "india.mongabay.com",
  "news.mongabay.com",
];

const MAX_BYTES = 2_000_000;   // 2 MB cap on relayed content
const TIMEOUT_MS = 8000;

// reject anything that resolves to a private / loopback / link-local range
function isBlockedHost(host) {
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // literal IPv4 in private ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;         // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (host.includes(":")) return true;               // raw IPv6 literal — reject
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    return res.status(405).send("method not allowed");
  }

  const raw = req.query.url;
  if (!raw || typeof raw !== "string") {
    return res.status(400).send("missing url");
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).send("bad url");
  }

  if (target.protocol !== "https:") {
    return res.status(403).send("only https allowed");
  }
  if (isBlockedHost(target.hostname)) {
    return res.status(403).send("blocked host");
  }
  if (!ALLOW_HOSTS.includes(target.hostname)) {
    return res.status(403).send("host not on allowlist");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(target.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (typing-practice-tool)",
        "Accept": "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
      },
    });

    // relay body with a hard size cap
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { controller.abort(); break; }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    clearTimeout(timer);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300"); // 5-min cache to save quota
    return res.status(200).send(buf.toString("utf-8"));
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).send("fetch failed");
  }
}
