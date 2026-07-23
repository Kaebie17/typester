# Daily current-affairs passages

The app fetches nothing. Once a day it makes **one POST to `/api/generate`** and gets back
finished practice passages. Everything else — headline feeds, ranking, the model call —
happens server side.

`api/fetch.js` has been deleted. The proxy only existed so the browser could read
cross-origin RSS; with feed reading moved to the server, there is no CORS to work around
and no arbitrary-URL fetcher to defend against SSRF.

## File layout on Vercel

```
your-project/
  index.html          <- jkssb-typing-practice.html, renamed
  api/
    generate.js       <- api-generate.js, renamed
```

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | never reaches the browser |
| `ANTHROPIC_MODEL` | no | defaults to `claude-sonnet-5` |
| `APP_SHARED_SECRET` | no | if set, `/api/generate` demands a matching `x-app-secret` header |
| `ANTHROPIC_MAX_TOKENS` | no | defaults to 32000 |
| `DAILY_REQUEST_BUDGET` | no | soft cap per warm instance, default 6 |

**Output size.** 10 headlines × 3 angles × ~460 words is roughly 20,000 output tokens, which
is why `AI_MAX_TOKENS` defaults to 32000. If a reply is cut off anyway, the response is not
lost: `balancedObjects()` walks the JSON brace by brace (string- and escape-aware) collecting
every closed object at any depth, so it recovers whole passages from inside a wrapper object
even when the wrapper itself never closes. The panel then says the
reply hit the token limit. Verified against truncated, fenced, trailing-comma and
brace-inside-string inputs.

**Function duration.** `api/generate.js` sets `export const config = { maxDuration: 300 }`.
Feeds plus a 3,500-word generation take well over Vercel's 10-second default, so without
this the request dies mid-generation. Check the ceiling your plan allows.

## The daily round trip

The browser sends `{ day, count, knownSignature }` and gets one of two answers:

- **`unchanged: true`** — the server fetched the feeds, ranked them, and found the same
  headline set the client already has. No model request was made. Cheap.
- **the passages** — plus `signature`, `headlines` and `feeds` for the status line.

Server side, in order: fetch four feeds in parallel with an 8s timeout each → regex out
`<item>`/`<entry>` blocks and read only `<title>` and `<pubDate>` → drop
entertainment/sport/crime → **de-duplicate on keyword overlap** → rank → take the top 10 →
one model request for the whole set.

### Sources

| Feed | Outlet | Weight |
|---|---|---|
| `pib.gov.in/RssMain.aspx?...Regid=3` (×2 sections) | PIB — govt press releases | 3 |
| `prsindia.org/theprsblog/feed` | PRS India — legislative analysis | 3 |
| `rbi.org.in/pressreleases_rss.xml` | RBI | 2 |

Official only. Newspaper feeds were dropped: their URLs move often, and PIB/PRS carry the
policy and legislative material that JKSSB and SSC passages are actually built from. GDELT
is queried only if fewer than 10 usable headlines survive, so usually not at all.

### Repetition control

`keywordsOf()` strips stopwords plus boilerplate that carries no topic signal (`ministry`,
`launched`, `shri`, `union`…) and crudely singularises. Two headlines are near-duplicates
when their shared keywords exceed 60% **of the smaller set** — so a short headline wholly
contained in a longer one still counts as a repeat, which plain Jaccard would miss. The day's
signature is built from these keyword sets, so trivial rewording of the same story does not
look like a new set and does not trigger a regeneration.

### Angles

Each headline is written up from up to three angles, so 10 headlines make 20–30 passages:

- **core** — what the measure is, which body runs it, how the mechanism works
- **context** — how the policy area developed, earlier arrangements, governing law
- **impact** — who is affected, district-level implementation, adjacent policy areas

Each passage is read alone by a candidate, so the prompt requires each to stand on its own
and forbids reusing sentences, examples or opening formulas between variants of one headline.

## What the client still does

The parts worth keeping local, because they are the app's own judgement rather than the
model's:

- **Sanitising** — strips markdown, flattens curly quotes, `₹`, em dashes and non-ASCII,
  normalises spacing around punctuation.
- **Word-count enforcement** — anything under 420 words is discarded, never padded.
- **Title validation** — five-step fallback if the model's title is too short, generic, a
  headline echo, or a reordering of another title's keywords. The last resorts append an
  angle-appropriate tail ("in wider context", "and its practical effects") rather than a hash.
  Note the duplicate check rejects only *identical* keyword sets: variants of one headline
  legitimately share most of their keywords and must not be blocked.
- **Difficulty validation** — `difficultyScore()` re-scores the finished text and overrules
  the model, except within 4 points of a band boundary where a one-step disagreement
  defers to the model.
- **Headline re-matching** — the model echoes each headline back; the client matches it to
  the one that was sent by keyword overlap rather than exact string equality, so light
  rewording does not orphan a passage.
- **Caching and the day gate** — `jk_ai_day` (Asia/Kolkata) plus `jk_ai_sig`. On a new day
  the client sends its stored signature so the server can skip the model if nothing moved.

## Running with no server at all

If `/api/generate` is missing or errors, the page falls back to GDELT headlines fetched in
the browser (the one headline source that reliably allows cross-origin reads) plus a
provider, model id and key set in the **API key** row. All three providers are supported
here too, with the same OpenAI parameter adaptation.

Two caveats. Browser-side calls to OpenAI or Gemini may be refused by CORS depending on the
provider's current policy — if that happens the panel says so explicitly and tells you to
deploy the server route rather than showing a bare network error. And a key in a public page
is a billable key anyone can read, so this path is for personal use on your own machine.

## Notes

- If passages look thin toward the end of the set, lower **Headlines / day** or **Passages
  each**. Thirty passages in one reply is the demanding end of the design; 6–7 headlines × 3
  is the comfortable end.
- Generation is per-device. Two browsers each spend one request per day. Put a date-keyed
  cache in front of `/api/generate` if that matters.
- Headlines are topic seeds only. No article page is ever requested and no article body is
  ever parsed, so there is no newspaper copy to reproduce.
- The bundled exam-style passages and **My passages** work with no network at all.
