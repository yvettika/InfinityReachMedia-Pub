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
// Contact form → GoHighLevel (GHL) Inbound Webhook
// -------------------------------------------------------------------
// SETUP (one time, in your GHL account):
//   1. Go to Automation → Workflows → Create Workflow.
//   2. Add the trigger "Inbound Webhook" and copy the webhook URL it gives you.
//   3. Paste that URL between the quotes below (replace the placeholder).
//   4. In the workflow, add an action "Create/Update Contact" and map the
//      incoming fields (first_name, last_name, email, phone, company_name,
//      service, message) to the matching contact fields.
//   5. Optionally add "Send Internal Notification" so you get an email/SMS
//      for every new lead.
// Until a real URL is pasted, the form runs in demo mode (no data is sent).
// ===================================================================
const GHL_WEBHOOK_URL = "PASTE_YOUR_GHL_INBOUND_WEBHOOK_URL_HERE";

const form = document.querySelector('#contact-form');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = form.querySelector('.form-note');
    const submitBtn = form.querySelector('button[type="submit"]');

    // Collect form fields into a plain object
    const data = Object.fromEntries(new FormData(form).entries());
    data.source = 'Website Contact Form';
    data.page = window.location.href;

    // Demo mode if the webhook URL hasn't been set yet
    if (!GHL_WEBHOOK_URL || GHL_WEBHOOK_URL.startsWith('PASTE_')) {
      note.textContent = "Demo mode — add your GHL webhook URL in js/main.js to start receiving leads.";
      note.style.color = 'var(--color-accent-2)';
      form.reset();
      return;
    }

    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = 'Sending…';
    note.textContent = '';

    try {
      await fetch(GHL_WEBHOOK_URL, {
        method: 'POST',
        mode: 'no-cors', // GHL webhook returns no CORS headers; fire-and-forget
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      // In no-cors mode the response is opaque, so a completed request (no
      // network error) is treated as a successful submission.
      note.textContent = "Thanks! We've received your message and will reply within one business day.";
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
