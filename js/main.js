// Mobile nav toggle
const toggle = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
if (toggle && links) {
  toggle.addEventListener('click', () => links.classList.toggle('open'));
}

// FAQ accordion
document.querySelectorAll('.faq-q').forEach((q) => {
  q.addEventListener('click', () => {
    const item = q.closest('.faq-item');
    item.classList.toggle('open');
  });
});

// ===================================================================
// Contact form → Speed to Lead Agent
// Every submission is captured, gets an instant acknowledgment email, and
// an AI-drafted follow-up is posted to Slack for approval.
// ===================================================================
const AGENT_LEAD_URL = "https://speed-to-lead-agent-two.vercel.app/api/lead";

const form = document.querySelector('#contact-form');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = form.querySelector('.form-note');
    const submitBtn = form.querySelector('button[type="submit"]');

    const raw = Object.fromEntries(new FormData(form).entries());

    // Bots fill the hidden honeypot; humans never do.
    if (raw.company_website) { form.reset(); return; }

    const fullName = [raw.first_name, raw.last_name].filter(Boolean).join(' ');
    const parts = [];
    if (raw.company_name) parts.push(`Business: ${raw.company_name}.`);
    if (raw.service) parts.push(`Interested in: ${raw.service}.`);
    if (raw.message) parts.push(raw.message);
    const payload = {
      name: fullName,
      email: raw.email,
      phone: raw.phone || '',
      source: 'Website Contact Form',
      message: parts.join(' ') || 'No message provided.',
      company_website: '', // honeypot passthrough
    };

    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = 'Sending…';
    note.textContent = '';

    try {
      const res = await fetch(AGENT_LEAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Request failed');
      // Only count a conversion once the lead actually landed.
      if (typeof window.irmTrack === 'function') {
        window.irmTrack('generate_lead', { form_location: 'contact_page', service: raw.service || '' });
      }
      note.textContent = "Thanks! Check your inbox — we just sent you a confirmation and will follow up shortly.";
      note.style.color = 'var(--color-accent-2)';
      form.reset();
    } catch (err) {
      note.textContent = "Something went wrong. Please email yvette@infinityreachmedia.com directly.";
      note.style.color = 'var(--color-accent)';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}
