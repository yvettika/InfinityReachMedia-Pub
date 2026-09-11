// Mobile nav toggle
const toggle = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
if (toggle && links) {
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'sitemenu');
  links.id = links.id || 'sitemenu';
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
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

    // Name every problem field explicitly. A generic "please fill in this field"
    // tells someone using a screen reader nothing about which field or why.
    const rules = [
      ['first_name', 'First Name', (v) => v.trim() !== '', 'Enter your first name.'],
      ['last_name',  'Last Name',  (v) => v.trim() !== '', 'Enter your last name.'],
      ['email',      'Email',      (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
                                   'Enter an email address in the form name@example.com.'],
    ];
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
    form.querySelectorAll('[aria-invalid]').forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    });

    const problems = [];
    rules.forEach(([name, label, ok, msg]) => {
      const input = form.querySelector('[name="' + name + '"]');
      if (!input || ok(raw[name] || '')) return;
      const id = 'err-' + name;
      const p = document.createElement('p');
      p.className = 'field-error';
      p.id = id;
      p.textContent = msg;
      input.insertAdjacentElement('afterend', p);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', id);
      problems.push({ label, input });
    });

    if (problems.length) {
      note.className = 'form-note form-note-error';
      note.setAttribute('role', 'alert');
      note.textContent = problems.length === 1
        ? 'One field needs attention: ' + problems[0].label + '.'
        : problems.length + ' fields need attention: ' + problems.map((p) => p.label).join(', ') + '.';
      problems[0].input.focus();
      return;
    }
    note.className = 'form-note';
    note.removeAttribute('role');

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
      note.textContent = "Something went wrong. Please email info@infinityreachmedia.com directly.";
      note.style.color = 'var(--color-accent)';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}
