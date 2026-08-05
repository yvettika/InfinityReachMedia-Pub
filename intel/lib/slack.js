'use strict';

/**
 * Slack notifications — a daily digest of what the sync actually did.
 *
 * Posts via an Incoming Webhook (SLACK_WEBHOOK_URL) rather than a Slack app
 * connector, because the job runs on a headless cloud runner where one secret
 * URL is the whole integration. Create it at api.slack.com/apps → Incoming
 * Webhooks → pick the channel; the URL that comes back is channel-bound, so
 * there is nothing else to configure.
 *
 * Two deliberate choices:
 *
 *   1. A digest, not a firehose. One message per run summarising what is NEW —
 *      never a message per lead. A channel that pings two hundred times a day
 *      is muted by Friday, and then it alerts nobody about anything.
 *
 *   2. Silence is meaningful. A run that found nothing new posts nothing, so
 *      when the channel does light up it is worth looking at. Failures are the
 *      exception: those always post, because a job that breaks silently on a
 *      Tuesday is still broken in March.
 */

const hook = () => process.env.SLACK_WEBHOOK_URL || null;

const money = n => '$' + Math.round(n).toLocaleString('en-US');

/**
 * Build the digest message. Pure function — everything testable lives here,
 * the network call below stays trivial.
 *
 * @param {object} run
 *   newLeads    prospects first seen this run
 *   researched  prospects scored this run (includes new ones)
 *   failures    array of strings — research or CRM errors worth flagging
 *   totals      { prospects, synced }
 *   sheetUrl    link to the spreadsheet
 */
function buildDigest(run) {
  const { newLeads = [], researched = [], failures = [], totals = {}, sheetUrl } = run;

  if (!newLeads.length && !researched.length && !failures.length) return null;

  const lines = [];

  if (newLeads.length) {
    lines.push(`*${newLeads.length} new lead${newLeads.length === 1 ? '' : 's'} found*`);
  }
  if (researched.length) {
    lines.push(`${researched.length} researched and scored`);
  }
  if (totals.prospects) {
    lines.push(`${totals.prospects} prospects tracked · ${totals.synced ?? 0} in GoHighLevel`);
  }

  // Worst score first — same call-order logic as everywhere else in the
  // system: the biggest leak is the warmest door.
  const showable = [...(newLeads.length ? newLeads : researched)]
    .filter(p => p.score != null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  const rows = showable.map(p => {
    const bits = [
      `*${p.name}*`,
      p.niche || null,
      p.score != null ? `${p.score}/100 ${p.band || ''}`.trim() : 'not yet scored',
      p.recoverableAnnual != null ? `~${money(p.recoverableAnnual)}/yr recoverable` : null,
      p.topLeak ? `top leak: ${p.topLeak}` : null,
      p.phone || null,
    ].filter(Boolean);
    return '• ' + bits.join(' · ');
  });

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:mag: *Prospect sync*\n${lines.join('\n')}` },
    },
  ];
  if (rows.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: rows.join('\n') },
    });
  }
  if (failures.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: ${failures.length} problem${failures.length === 1 ? '' : 's'}:\n` +
          failures.slice(0, 5).map(f => `• ${f}`).join('\n'),
      },
    });
  }
  if (sheetUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${sheetUrl}|Open the prospect sheet>` }],
    });
  }

  // `text` is the notification fallback on phones and in muted channels.
  const text = newLeads.length
    ? `Prospect sync: ${newLeads.length} new lead${newLeads.length === 1 ? '' : 's'}`
    : failures.length
      ? `Prospect sync: ${failures.length} problem(s)`
      : `Prospect sync: ${researched.length} researched`;

  return { text, blocks };
}

/** Post the digest. Returns 'posted' | 'skipped-empty' | 'skipped-no-webhook'. */
async function postDigest(run) {
  const url = hook();
  if (!url) return 'skipped-no-webhook';

  const message = buildDigest(run);
  if (!message) return 'skipped-empty';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Slack webhook failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  return 'posted';
}

module.exports = { buildDigest, postDigest };
