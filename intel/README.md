# Prospect Intel — pre-call briefs

Finds local businesses worth calling, reads what is public about each one,
estimates their Revenue Leak Score from the outside, and writes the brief a rep
reads in the five minutes before the call: what to say, what to ask, what to
lead with, what objections are coming, and what to close on.

```bash
# 1. find them
node intel/discover.js --area orange-county --niches core --dry-run   # cost first
node intel/discover.js --area orange-county --niches core

# 2. research them
node intel/intel.js --batch prospects/prospects.txt --out briefs/

# 3. one prospect, on demand
node intel/intel.js baxterheating.com --industry hvac
```

Zero dependencies. Node 18+. Nothing to install.

## Discovery

Sweeps Google Places across business categories and cities, then filters to
companies that are actually sellable to. Deliberately niche-agnostic: the leak
model does not care whether a business fixes furnaces or teeth, only whether a
missed call costs them money and whether anything on their site catches a lead
after hours. `data/niches.json` is therefore just "appointment-driven local
service business" — 24 categories — and the Revenue Leak Score does the real
ranking afterwards.

What it filters out, all counted and reported at the end of a run:

- directory sites and national franchises (Yelp, Angi, Roto-Rooter, State Farm…)
- businesses with no website — there is nothing to research
- permanently closed listings
- under 10 reviews (too new to have the problem) and over 1500 (usually a
  regional player with staff, or a franchise the filters missed)
- **multiple storefronts of the same company** — one prospect per business, not
  one per location

`--dry-run` prints the query plan and count before spending anything. Every
query is a billed Places request, so a full core sweep of Orange County is
about 540 of them. The sweep uses a reduced field mask (no reviews) to stay on
the cheaper tier; reviews get fetched later, only for prospects worth
researching. Cheap wide sweep, expensive narrow follow-up.

Repeat runs skip what they already found. `prospects/seen-places.json` stores
place IDs only — the one Places field that may be kept indefinitely — and when
a company is kept, every storefront sharing its domain is marked seen too, so
the next sweep cannot resurface it through a second location.

## Daily sync — spreadsheet and CRM

```bash
node intel/sync.js --dry-run                                  # see what it would do
node intel/sync.js --discover --area orange-county            # the full daily job
```

Finds new prospects, researches the ones not researched yet, re-researches
anything older than 30 days, then writes the Google Sheet and pushes into
GoHighLevel.

**The sheet is the state store.** There is no local database: a run reads the
sheet, works out what is new and what has gone stale (three machine columns —
Place ID, Researched, Sync State — carry the bookkeeping), does the work, and
writes the sheet back. Nothing persists on the machine between runs, so the job
can execute anywhere — a laptop today, GitHub Actions tomorrow, both taking
turns — and a fresh process recovers everything from the sheet alone. With no
sheet configured it falls back to a local `prospects.json` with the same
interface, so it still works offline.

Merging is by header *name*, not column position: columns you add to the sheet
survive a sync, reordering is safe, and a blank value never erases a known one
— a failed research pass leaves yesterday's score in place.

**Safe to run twice.** Every write is keyed on the prospect's domain:

- the sheet merges by domain, so a re-run updates a row instead of adding one
- **Status and Owner Notes are never overwritten** — they belong to whoever is
  working the list. A daily job that reset "Booked" to "Not contacted" would be
  worse than no automation.
- First Seen survives every update; Last Updated moves
- rows you added by hand are left alone
- the CRM upserts the contact and reuses an existing opportunity rather than
  creating a second one

Prospects land in GHL tagged `outbound-prospect`, `niche-<x>` and
`leak-band-<x>`, with an opportunity in the configured stage. The deal's
monetary value is the **prospect's** estimated recoverable revenue — the number
the whole call is built around — not a guess at our fee. Only researched
prospects are pushed; an unresearched row has no score and would land in the
CRM as noise.

**Slack gets a digest, and GHL gets the whole row.** When SLACK_WEBHOOK_URL is
set, each run posts one message to the channel the webhook is bound to: how
many new leads, the five worst scores with band, recoverable revenue and top
leak, and a link to the sheet. A run that found nothing new stays silent so the
channel keeps meaning something — except failures, which always post, because a
job that breaks silently on a Tuesday is still broken in March. On the CRM
side, the sheet's key columns (Leak Score, Leak Band, Recoverable Revenue, Top
Leak, Lead Agent, Prospect Niche) are written to the contact as custom fields —
created automatically via the API on first run — so the intel is on the record
a rep has open while dialling, not in a separate tab.

**The pipeline is resolved by name.** GHL has no API for creating pipelines —
not in the connector, not in their public v2 REST API; they are made in the UI.
So instead of copying opaque IDs out of a URL bar, set `GHL_PIPELINE_NAME`
(and optionally `GHL_STAGE_NAME`, default "New Lead") and the sync looks the
IDs up at runtime. Create the pipeline once in the UI and the next run finds
it. Until it exists, the run degrades to contacts-only and says so, rather
than failing — and the error message lists the pipelines that *do* exist.
Explicit `GHL_PIPELINE_ID`/`GHL_STAGE_ID` still win when set.

### Why the REST APIs and not the connectors

Two capabilities the MCP connectors don't have, which decided the design:

- **Google Sheets** — Drive can create a file and read it, but there is no
  append or update. Daily row updates need the Sheets API.
- **GoHighLevel** — the connector exposes `update-opportunity` but no *create*.
  Putting a prospect "under New Leads" means creating one, so this uses the GHL
  REST API with a Private Integration token.

### Configuration

```bash
export GOOGLE_PLACES_API_KEY=...              # discovery + review data
export GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json
export PROSPECT_SHEET_ID=...                  # the spreadsheet
export GHL_API_KEY=...                        # Private Integration token
export GHL_LOCATION_ID=...
export GHL_PIPELINE_NAME="Outbound Prospecting"   # looked up at runtime
export GHL_STAGE_NAME="New Lead"                  # default if unset
export SLACK_WEBHOOK_URL=...                      # optional: digest channel
```

Anything unset is skipped with a message rather than failing the run, so the
sheet half works before the CRM half is configured. The service account needs
no broad permissions: create it in Google Cloud, then share the one spreadsheet
with its email address as an Editor. That share is the entire grant.

### Running it every day — in the cloud

`.github/workflows/prospect-sync.yml` runs the whole job daily on GitHub
Actions: tests first, then discovery, research, sheet write and CRM push.
Because the sheet carries all the state, the runner needs nothing from the
previous day and writes nothing to the repo — which is exactly right for a
public repo that must never contain prospect data.

Setup is a handful of repository secrets (Settings → Secrets and variables → Actions):
`GOOGLE_PLACES_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY` (the key file's full JSON
body), `PROSPECT_SHEET_ID`, `GHL_API_KEY`, `GHL_LOCATION_ID`, and optionally
`SLACK_WEBHOOK_URL` (the digest channel) and `INTEL_INDUSTRIES_JSON` (the private priors — without it the committed
placeholder priors are used, which shifts dollar estimates but not observed
signals). The workflow can also be fired by hand from the Actions tab.

Locally it is the same command on any scheduler:

```
0 7 * * *  cd /path/to/InfinityReachMedia-Pub && /usr/bin/node intel/sync.js --discover --area orange-county >> ~/prospect-sync.log 2>&1
```

---

## The one rule everything else serves

Every fact in a brief is tagged with how we know it:

| Basis | Means | What a rep does with it |
|---|---|---|
| **observed** | We saw it directly and can show the receipt | Say it out loud |
| **inferred** | A signal implies it | Say it as a hypothesis, confirm on the call |
| **assumed** | Industry prior, nothing more | Never assert. Ask. |

An assumption read aloud as a fact is how you lose a call in the first minute —
the prospect knows their own business, and you have just proved you don't. The
brief prints assumed values under a heading that literally says **Do not say**,
and phrases every gap as *"I couldn't find…"* rather than *"you don't have…"*,
because absence of evidence is a weaker claim and reps should make the weaker
one.

If a brief ever shows revenue, employee count, ad spend, or review-response
rate as *observed*, something is fabricating data. Those are not obtainable
this way. See "What this deliberately doesn't do".

---

## How it works

```
discover.js  Places sweep by category + city → filtered candidate list
   ↓
collect.js   fetch homepage + a few likely pages, honour robots.txt
   ↓
detect.js    fingerprint what's on the page — pure functions, no model, no network
   ↓
places.js    optional: Google review count + velocity (needs an API key)
   ↓
model.js     signals → the ten scorecard inputs → Revenue Leak Score
   ↓
brief.js     the page a rep actually reads
```

There is no LLM anywhere in this pipeline. Everything here is deterministic, so
the same prospect scored twice a week apart moves only because the *business*
moved. That is a requirement, not a preference: when a prospect asks "why is
this a 55?", the answer has to be the same every time you ask it.

An LLM belongs in exactly two places, and neither is built yet — extracting an
owner's name from an About page, and drafting the outreach message. Both are
narrow, both are constrained to text we already fetched, and both are additions
to this pipeline rather than replacements for any part of it.

## What it computes

The same **Revenue Leak Score** as `/scorecard`, using the same six leak
formulas, ported verbatim from `scorecard.html`. A pre-call estimate and the
prospect's own scorecard result can disagree because the inputs differ — never
because the arithmetic does. **If the scorecard math changes, change
`intel/lib/model.js` in the same commit.** A test asserts they match.

### The property that makes this work

Every leak term is linear in lead volume (`L`) and customer value (`V`), and so
is current revenue. They cancel in the ratio. So:

- **The score does not depend on `L` or `V` at all.** We can compute it
  correctly without knowing how many leads they get or what a customer is
  worth — which is exactly what we can't know before the call.
- **Only the dollar figures need them.** Until the prospect supplies both,
  dollars are shown per 100 monthly leads and the brief says so.

Lead with the score. It is defensible before they tell you anything.

### Discovery questions are ranked by sensitivity

For every input we didn't observe, the model re-runs itself across that input's
plausible range and measures how far the answer moves. Questions are ordered by
that, not by convention — ask the one where being wrong costs the most.

Inputs are split by what their answer actually changes:

- **Diagnostic** — moves the score. These are the discovery questions.
- **Scaling** — `leads` and `avgValue`, which multiply every dollar figure but
  cancel out of the score. Still must be asked before quoting a number, but
  they belong in their own bucket. Ranking them by dollar swing would park them
  permanently at the top of the list ahead of questions that change the
  diagnosis, which is backwards.

The split is computed empirically (`scoreSwing === 0`), not hardcoded, so a
future input lands in the right bucket on its own.

## What it detects

From the page source: chat widgets, online booking, CRM and email platforms, ad
pixels, analytics, call tracking, review tooling, site platform, social
profiles, phone numbers, forms, structured data, and copy claims (24/7,
financing, memberships, "text us", hiring — including whether the open roles
are front-office).

Roughly 60 vendor fingerprints across those classes, each carrying the exact
source snippet that matched. That snippet is the receipt.

## Google Places (optional)

```bash
export GOOGLE_PLACES_API_KEY=...
```

Adds review count, rating, and a velocity estimate from the five most recent
reviews. Without it the system still runs — review volume just moves from
"say this" to "ask this".

Two things to know before building further on it:

1. **Places exposes no owner-response field.** Review-response rate is a real
   buying signal but it is not automatically observable. The Business Profile
   API needs the business to grant access, which a prospect obviously has not.
   We route it to the call as a question rather than pretending to measure it.
2. **Places terms allow storing place IDs indefinitely, not other content.**
   Every record carries `cachedAt` so a retention job can expire the rest.
   Don't build a permanent local mirror of Places content.

A Places result is only accepted when the listing's website matches the domain
we researched. A near-miss is worse than nothing — it puts another business's
review count in front of a rep who is about to quote it out loud.

## What this deliberately doesn't do

- **No LinkedIn, Instagram, or Facebook scraping.** Their terms forbid it and
  LinkedIn enforces. Meta's Ad Library API is public and legitimate and is the
  right way to add "are they running ads" — that's a good next addition.
- **No revenue or employee-count estimates.** Nobody has real revenue figures
  for a private local business; vendors who show one are showing you a model
  output. Size is inferred from observable proxies or asked on the call.
- **No 0–100 "AI opportunity score" per product.** Instead each agent gets its
  actual *share of recoverable revenue*, which is arithmetic on the leak table
  and can be defended line by line. A per-product 0–100 would be invented
  precision.
- **No contact scraping.** This tool researches businesses, not people. Adding
  email discovery means verification, suppression lists, CAN-SPAM compliance,
  and sending infrastructure — a separate build with separate obligations.

## Collection etiquette

Identifies itself in the User-Agent with a contact address, honours
`robots.txt` Disallow rules, waits between requests to the same host, caps
itself at five pages per prospect, and reads only public pages. Failures are
recorded rather than swallowed: "we couldn't check" and "we checked and it
wasn't there" are different claims on a sales call.

## Setup — the playbook is private

**This repo is public.** The engine is fine to publish; the playbook is not.
Three files hold the parts a competitor would actually want, and they are
gitignored:

| Private (gitignored) | Committed placeholder |
|---|---|
| `data/objection-rules.js` | `data/objection-rules.example.js` |
| `data/industries.json` | `data/industries.example.json` |
| `data/proof.json` | `data/proof.example.json` |

`lib/playbook.js` prefers the real file and falls back to the `.example`
sibling, so a fresh clone still runs and the tests still pass — on placeholder
content. Any brief generated that way is stamped with a warning at the top,
because a placeholder brief looks exactly as authoritative as a real one and
someone will otherwise read example testimonials onto a live call.

On a new machine:

```bash
cd intel/data
cp objection-rules.example.js objection-rules.js
cp industries.example.json     industries.json
cp proof.example.json          proof.json
# then fill them in
```

The seam falls at rules-vs-engine rather than at whole files: the objection
*matching logic* stays in `lib/objections.js`, in git, so a fix to it reaches
every machine. Only the rules themselves are private.

## Tuning

- `data/industries.json` — priors per vertical. Every value is a placeholder
  until closed-won data replaces it. `customersPerReview` is the weakest number
  in the system and drives the lead-volume inference; treat it as a guess.
- `data/proof.json` — testimonials. **Nothing in this file may be invented or
  paraphrased into a stronger claim than the client made.** A test asserts
  every quote in a rendered brief appears here verbatim.
- `data/objection-rules.js` — signal-triggered objection rules.

## Tests

```bash
node intel/test/all.js           # 99 tests, no network or API key needed
```

They run the real collector over real HTTP against a local fixture server —
fetch, robots, detection, model, brief — because the bugs worth catching in
this system live in the seams. They also verify the private playbook files stay gitignored. They cover robots compliance, the scale
invariance above, exact parity with the scorecard formulas, the
diagnostic/scaling split, and that no brief can cite a testimonial that isn't
in `proof.json`.

## Not built yet

In the order I'd build them:

1. **Contact discovery.** Places gives the business, website and phone — not a
   person or an inbox. Role addresses off their own contact page (`info@`,
   `office@`) are free, legal, and for a 12-truck contractor often reach the
   same person a paid enrichment record would.
2. **Snapshot + diff.** Store each run, re-run weekly, alert on change. "They
   just posted a CSR job" is a far better outreach trigger than any static
   score. This is just a diff over a table.
3. **Meta Ad Library API** — public and free, answers "are they running ads"
   properly instead of inferring it from a pixel.
4. **LLM extraction** for owner and decision-maker names from About pages,
   constrained to fetched text, with the source URL attached.
5. **CRM write-back** to GoHighLevel so the brief lands on the contact record.
