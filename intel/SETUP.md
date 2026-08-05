# Setup runbook

Everything is built and tested. What remains is credentials, plus two items
that need calendar time rather than effort.

Interactive version of this checklist: see the artifact link in the chat that
produced it. This file is the canonical copy that travels with the code.

---

## Start today — these gate every email you will ever send

**1. A separate sending domain, warmed. 3–4 weeks.**

Do *not* send cold from `infinityreachmedia.com` — it carries client work, the
GHL sending reputation, and the business that pays for this experiment.

- Buy a lookalike (`infinityreach.co`, `getinfinityreach.com`)
- Two mailboxes on it (Google Workspace or M365)
- SPF, DKIM, DMARC
- Warmup tool running; cap real sending at 30–50/day per mailbox afterwards
- Point the domain at the real site so it is not a dead link

**2. A PO box or virtual office. ~1 week.**

CAN-SPAM requires a physical postal address in every commercial email. The GHL
business address is a home address and must not go on cold mail. Until this is
set, drafts compose but every one is blocked from sending, deliberately.

---

## Google — ~30 min

**3. Places API key** → `GOOGLE_PLACES_API_KEY`

Cloud console → new project → attach billing → enable **Places API (New)**
(not the legacy Places API) → Credentials → API key, restricted to Places.

Check the cost before spending it:
```
node intel/discover.js --area orange-county --niches core --dry-run
```
Prints the query plan (~540 requests for a full core sweep) and calls nothing.

**4. Service account** → `GOOGLE_SERVICE_ACCOUNT_KEY`

Same project → IAM → Service Accounts → Create (no project roles) → enable the
**Google Sheets API** → Keys → Add key → JSON.

**5. Share the sheet with it**

Open the Prospect Pipeline sheet → Share → the service account email
(`…@….iam.gserviceaccount.com`) → **Editor**. That share is the entire grant:
it can touch this one file and nothing else in the Drive.

Delete the `EXAMPLE-ROW-DELETE-ME` row while you are in there.

```
PROSPECT_SHEET_ID = 1DuJK1cEuFKgijT377PWIn9NdLXC8FjRlY_M7_u0PtFU
```

---

## GoHighLevel — ~25 min

**6. Pipeline — done.** "Infinity Reach Media" (New Lead → Contacted →
Proposal Sent → Closed). Config points at it *by name*, so no IDs to copy.

**7. Private Integration token** → `GHL_API_KEY`

Settings → Private Integrations → Create. Scopes:

```
contacts.readonly        contacts.write
opportunities.readonly   opportunities.write
locations.readonly       locations/customFields.write
```

```
GHL_LOCATION_ID = rvvmN3bJOUZYfpydfLy8
```

**8. Custom fields — automatic.** The first run creates all ten via the API.

**9. One email template.** Marketing → Emails → Templates → New.

- Subject: `{{contact.outreach_subject}}`
- Body: `{{contact.outreach_body_html}}`

One template serves every prospect — the personalisation lives on the contact
record, so each business gets its own words from this single asset.

**10. The sending workflow.** Automation → Workflows → Create.

1. Trigger: Contact Tag Added → `outreach-ready`
2. Send Email → the template
3. Wait 3 days → Send Email (step 2)
4. Wait 4 days → Send Email (step 3)

Then add a **removal condition on "Customer Replied"**. That stops the sequence
the moment a human answers — the promise on the suite page, handled natively.

> The sync applies `outreach-draft`. It never applies `outreach-ready`. Only a
> person does, after reading the draft. Approval is deliberately not automated.

**11. Connect the cold domain.** Settings → Email Services → add the *new*
sending domain, not the primary one. Blocked until step 1 exists.

---

## Slack — ~5 min

**12. Incoming Webhook** → `SLACK_WEBHOOK_URL`

api.slack.com/apps → Create New App → From scratch → Incoming Webhooks → on →
Add New Webhook to Workspace → pick the channel. The returned URL is
channel-bound and is the entire integration.

---

## Photo — ~10 min, optional

**13.** Drop a headshot or GIF into `images/`, push, and it is live at
`https://infinityreachmedia.com/images/<name>`. Add a repository **variable**
(not a secret — it is a public URL) `OUTREACH_SIGNATURE_IMAGE_URL`.

It stays off the first email on purpose: a first touch from a domain with no
history is under maximum scrutiny, an image raises the image-to-text ratio, and
Outlook blocks remote images by default — so the first impression becomes a grey
box. On for steps 2 and 3. `OUTREACH_IMAGE_STEPS=1,2,3` to A/B test it.

GIFs: Outlook renders only the first frame, so the animation must work as a
still. Keep the file small.

---

## Wiring — ~20 min

**14. Restore the private playbook files.** Gitignored, so never pushed:
`intel/data/objection-rules.js`, `industries.json`, `proof.json`. Without them
everything runs on placeholders and every brief is stamped saying so.

**15. Dry run locally first.**

```bash
export GOOGLE_PLACES_API_KEY=...
export GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json
export PROSPECT_SHEET_ID=1DuJK1cEuFKgijT377PWIn9NdLXC8FjRlY_M7_u0PtFU
export GHL_API_KEY=...
export GHL_LOCATION_ID=rvvmN3bJOUZYfpydfLy8
export GHL_PIPELINE_NAME="Infinity Reach Media"
export OUTREACH_POSTAL_ADDRESS="Your PO box, Orange, CA 92869"

node intel/test/all.js       # 124 tests, no credentials needed
node intel/sync.js --dry-run # reads and researches, writes nothing
```

**16. GitHub secrets.** Settings → Secrets and variables → Actions.

| Secret | Value |
|---|---|
| `GOOGLE_PLACES_API_KEY` | the Places key |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | the full JSON key body |
| `PROSPECT_SHEET_ID` | `1DuJK1cEuFKgijT377PWIn9NdLXC8FjRlY_M7_u0PtFU` |
| `GHL_API_KEY` | Private Integration token |
| `GHL_LOCATION_ID` | `rvvmN3bJOUZYfpydfLy8` |
| `OUTREACH_POSTAL_ADDRESS` | the PO box |
| `SLACK_WEBHOOK_URL` | the webhook |
| `INTEL_INDUSTRIES_JSON` | contents of the private `industries.json` |

Plus one **variable**: `OUTREACH_SIGNATURE_IMAGE_URL`.

Secrets are safe in a public repo — never exposed to forks or PRs. What must
never be committed is prospect data, which is why the sheet holds all state and
the runner writes nothing back to the repo.

**17. Run once by hand.** Actions → prospect-sync → Run workflow. Check all
three destinations: rows in the sheet (worst score first), contacts and
opportunities in GHL with custom fields populated, a digest in Slack. Then run
it a second time and confirm nothing duplicates.

**18. Schedule takes over.** Already set for 7am Pacific daily
(`0 14 * * *` UTC).

---

## Before the first email goes out

**Read ten drafts end to end.**
```
node intel/outreach.js baxterheating.com --industry hvac
```
The composer refuses to assert anything it did not verify, but it cannot judge
whether the tone is yours. Edit the templates in `intel/lib/outreach.js`.

**Verify the addresses before volume.** Contact discovery now pulls role
addresses off each company's own contact page during research, at no extra
request cost. They are *unverified* — `verified` is always null. A bounce rate
over 2% damages a sending domain, so run them through ZeroBounce or NeverBounce
(about $20 to start) before sending at scale.

**If you change the email wording**, push it to drafts already waiting:
```
node intel/sync.js --refresh-drafts
```
Only touches drafts still awaiting approval; approved and sent ones are left alone.

**Approve the first batch by hand.** Filter GHL contacts by tag
`outreach-draft`, read each, add `outreach-ready` to the ones you want sent.
Start with ten, not two hundred.
