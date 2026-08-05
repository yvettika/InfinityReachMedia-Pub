# The Jarvis merge — one sender, one brain

Decision (2026-08-05): **Jarvis — the deployed `lead-generation-agent` — owns
all outbound.** It has the live delivery stack: Resend on the warmed
`outreach.` subdomain, approval links in Slack, reply classification, a global
suppression list, and a hard refusal to send without a postal address.

This repo is the **intelligence layer**. It researches the businesses Jarvis
finds and hands the findings over, so Jarvis's drafts open with verified facts
instead of scraped guesses. It no longer composes or stages outreach of its own.

```
Jarvis sourcing (Apify → ICP score)            intel discovery (Places API)
        │                                              │  skips any domain
        ▼                                              ▼  Jarvis already owns
   prospects table  ◄──── signals.intel ────  jarvis-enrich.js
        │                (research handoff)      leak score · verified opener
        ▼                                        verified facts · email fill
   draft → Slack approval → send → replies
        │
        ▼
   GHL (Jarvis ghl-sync)          sheet + call briefs stay here (pre-call intel)
```

## The contract

Jarvis's draft prompt receives `prospects.signals` verbatim as *facts to
reference, not instructions*, under an explicit never-invent rule. The bridge
writes one namespaced key and touches nothing else:

```jsonc
signals.intel = {
  "source": "prospect-intel",
  "researched_at": "2026-08-05T23:00:00Z",
  "leak_score": 55,                  // 0-100, same scale as the site scorecard
  "leak_band": "Heavy loss",
  "top_leak": "Missed & unanswered calls",
  "lead_agent": "AI Receptionist",
  "recoverable_estimate": 348998,    // dollars/yr — see unit_basis
  "unit_basis": true,                // true = per 100 leads/mo, an illustration
  "verified_opener": "You've got 212 Google reviews at 4.7 stars",
  "verified_facts": ["212 Google reviews at 4.7★ (Google Places)"],
  "absences": ["No chat widget found"]   // absence of evidence — ask, never assert
}
```

Rules the bridge enforces (all tested against a mock Supabase):

- **Read-merge-write on `signals`** — keys Jarvis's sourcing wrote survive.
- **An email Jarvis already has is never overwritten.** The crawler only fills
  a null. A human's correction always outranks a crawler's guess.
- **Never touched:** `icp_score`, `icp_reason`, `status`, any other column.
- **Idempotent:** a prospect already carrying `signals.intel` is skipped
  (`--refresh` to force).

## What changed in this repo

- `OUTBOUND_OWNER` defaults to `jarvis`: `sync.js` composes no outreach, writes
  no Outreach custom fields, applies no `outreach-draft` tag, and skips the
  signature-image preflight. `OUTBOUND_OWNER=intel` restores the old behaviour
  if Jarvis is ever retired — the composer and its 38 tests remain.
- **Discovery dedupe:** with the bridge configured, any discovered domain that
  already exists in Jarvis's `prospects` is left to Jarvis. One company, one
  owner, one email thread.
- The sheet, call briefs, GHL custom-field intel and Slack digest are unchanged
  — they are pre-call intelligence, not outreach.

## Configuration

Copy two values from the Vercel project **lead-generation-agent** → Settings →
Environment Variables, into this repo's GitHub secrets:

| This repo's secret | Jarvis's env var |
|---|---|
| `JARVIS_SUPABASE_URL` | `SUPABASE_URL` |
| `JARVIS_SUPABASE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |

The daily workflow then runs `jarvis-enrich.js --limit 15` after the sync.
Manual runs:

```bash
node intel/jarvis-enrich.js --dry-run     # research, write nothing
node intel/jarvis-enrich.js --limit 15    # the real handoff
node intel/jarvis-enrich.js --refresh     # re-research even where intel exists
```

## Notes for whoever maintains Jarvis

Nothing in Jarvis needs to change — the bridge rides the existing `signals`
contract. Two optional improvements if you want them, in order of value:

1. In `draftTouch`, surface `signals.intel.verified_opener` explicitly in the
   prompt (e.g. "STRONGEST VERIFIED OPENER — prefer this") rather than leaving
   the model to find it inside the JSON blob.
2. Respect `signals.intel.unit_basis`: when true, the recoverable estimate is a
   per-100-leads illustration and should never be quoted to the prospect as a
   figure about their business.

The one thing the bridge asks of Jarvis's schema: keep `signals` JSONB and keep
passing it to the draft prompt. Everything else is ours to maintain.
