# Fullerton Heating and Cooling Service — one-page site

Single self-contained file: `index.html`. No build step, no external CSS/JS, no image
files. The only outside request is Google Fonts. Drop it on any host (or move it to the
client's own domain) and it works as-is.

Staging URL on this site: `/demos/fullerton-heating-and-cooling/` (short link: `/fullerton-hvac`).

## Sections

Sticky header → hero → services → why choose us → reviews → service area → quote form →
footer, plus a sticky call/quote bar pinned to the bottom on mobile.

The phone number `(714) 707-4975` is a `tel:` link everywhere it appears: header button,
hero, service-area panel, contact card (twice), form fallback, footer, and sticky bar.

## Before launch — replace these placeholders

| Where | What to replace |
| --- | --- |
| `index.html` head, JSON-LD | `streetAddress`, `postalCode`, `geo` coordinates — currently a stand-in Harbor Blvd address. Use the real Google Business Profile address, or delete the `address`/`geo` blocks if the business doesn't publish one. |
| `<link rel="canonical">`, `og:url`, JSON-LD `url` | Currently `https://fullertonheatingandcooling.com/`. Point at the real domain. |
| Why Choose Us → Licensed & Insured | `CSLB #000000` — insert the real California contractor license number. |
| Reviews section | Three testimonials are representative placeholder copy. Swap in verbatim text and first names from the live Google reviews, and link "Reviews on Google" to the actual profile. |
| Footer → Hours | Confirm real business hours; the 24/7 emergency line claim needs to be true. |
| Hero background | `--hero-image` in the `:root` block is a generated SVG. Swap it for a real photo: `--hero-image:url("/images/hero-fullerton-hvac.jpg");` — the navy scrim keeps the headline readable over any image. |

The `aggregateRating` (4.5 / 13 reviews) matches what's shown on the page. If the Google
rating moves, update the badge, the reviews section, and the JSON-LD together — Google
penalises schema that disagrees with visible content.

## Wiring up the quote form

Set `LEAD_ENDPOINT` in the script block at the bottom of `index.html` to any URL that
accepts a JSON `POST` and returns 2xx. It receives:

```json
{ "name": "", "phone": "", "service": "", "message": "", "source": "" }
```

While `LEAD_ENDPOINT` is empty (the current state), the form still validates and then
opens a pre-filled SMS to the business number, so demo traffic doesn't vanish. A honeypot
field named `company` drops bot submissions silently.

## SEO

Title tag and meta description target "HVAC in Fullerton". The phrases *hvac in
Fullerton*, *Fullerton hvac*, and *emergency hvac Fullerton* appear naturally in the hero
note, service-area copy, and footer. `HVACBusiness` schema carries the rating, service
catalogue, hours, and `areaServed` cities.

`/demos/` is disallowed in the site-root `robots.txt` so this staging copy can't be
indexed against infinityreachmedia.com. Remove that rule from the client's own
`robots.txt` when the site moves to their domain.
