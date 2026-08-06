/* ==========================================================================
   FLEET DEMO — the agent fleet, visibly working, on staged data.
   --------------------------------------------------------------------------
   A demo-mode port of the private Jarvis fleet map. Same visual language
   (glowing nodes, sparks travelling the links, pulses on activity), but:

   - The BUSINESS sits at the center, not the conductor. On a sales page the
     point is "this fleet orbits YOUR revenue", so the demo company is the
     sun and the agents work around it.
   - Every event is synthetic and scripted. Nothing here touches an API, a
     ledger, or any client data — it is a looping, staged day compressed to
     ~45 seconds. The caption under the map says so; a demo that pretends to
     be live data would undercut the exact trust the section is arguing for.
   - Layout is fixed-orbital with gentle drift instead of a force sim: on a
     marketing page the map must look composed on every load, not occasionally
     tangled.

   Usage: <div data-fleet-demo></div> + this script. Renders every instance.
   Respects prefers-reduced-motion (static frame, no sparks). Pauses off-screen.
   ========================================================================== */
(function () {
  'use strict';

  var AGENTS = [
    { id: 'speed', label: 'Speed to Lead', desc: 'answers new leads in seconds' },
    { id: 'recep', label: 'AI Receptionist', desc: 'books calls it answers' },
    { id: 'show', label: 'Show-Rate', desc: 'defends booked appointments' },
    { id: 'nurture', label: 'Nurture', desc: 'follows up after silence' },
    { id: 'react', label: 'Reactivation', desc: 'wins back past customers' },
    { id: 'review', label: 'Review Machine', desc: 'turns jobs into reviews' },
  ];

  // One staged day, compressed. Each beat: which agent fires, what the ticker
  // says, and whether money lands (money beats flash the center gold).
  var SCRIPT = [
    { a: 'speed', t: '2:14 AM — missed call captured, instant text sent back', gap: 2600 },
    { a: 'speed', t: 'New website lead — follow-up drafted for approval', gap: 3000 },
    { a: 'recep', t: 'Caller asked for a quote — appointment booked', gap: 3200, money: true },
    { a: 'show', t: '24-hour reminder sent — appointment confirmed', gap: 2800 },
    { a: 'react', t: 'Win-back email to a customer last seen 14 months ago', gap: 3000 },
    { a: 'react', t: 'They replied. Booked for Thursday.', gap: 3400, money: true },
    { a: 'show', t: 'No-show marked — rebook email already out', gap: 2800 },
    { a: 'nurture', t: 'Day-3 follow-up sent to a quiet lead', gap: 2600 },
    { a: 'review', t: 'Job completed — review request sent', gap: 2800 },
    { a: 'review', t: '★★★★★ review just landed on Google', gap: 3400, money: true },
    { a: 'nurture', t: 'Quiet lead came back: "still interested, call me"', gap: 3200, money: true },
    { a: 'speed', t: 'Lead approved & answered — 41 seconds after it arrived', gap: 3600 },
  ];

  var PINK = '#E91E8C', GOLD = '#F0B429', PAPER = '#F7F4EF';
  var TAU = Math.PI * 2;

  function build(host) {
    var W, H, dpr = Math.min(2, window.devicePixelRatio || 1);
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'Animated demo of an AI agent fleet working around a business');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    var ticker = document.createElement('div');
    ticker.className = 'fleet-demo-ticker';
    host.appendChild(canvas);
    host.appendChild(ticker);
    var ctx = canvas.getContext('2d');

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var nodes = [], sparks = [], step = 0, nextAt = 0, running = false, raf = null;
    var centerPulse = 0, centerGold = 0, jobs = 0;

    function layout() {
      W = host.clientWidth; H = Math.max(300, Math.min(430, W * 0.62));
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var rx = Math.min(W * 0.36, 300), ry = H * 0.32;
      nodes = AGENTS.map(function (a, i) {
        var ang = -Math.PI / 2 + (i / AGENTS.length) * TAU;
        return {
          id: a.id, label: a.label,
          bx: W / 2 + Math.cos(ang) * rx, by: H / 2 + Math.sin(ang) * ry,
          x: 0, y: 0, seed: i * 1.7, heat: 0,
        };
      });
    }

    function fire(beat) {
      var n = nodes.find(function (x) { return x.id === beat.a; });
      if (!n) return;
      n.heat = 1;
      jobs++;
      if (!reduced) sparks.push({ from: n, p: 0, money: !!beat.money });
      if (beat.money) centerGold = 1;
      centerPulse = 1;
      ticker.innerHTML = '<b>' + n.label + '</b> — ' + beat.t +
        '<span class="fleet-demo-count">' + jobs + (jobs === 1 ? ' job' : ' jobs') + ' this demo-day</span>';
    }

    function draw(now) {
      raf = running ? requestAnimationFrame(draw) : null;
      var t = now / 1000;
      ctx.clearRect(0, 0, W, H);

      if (!reduced && now >= nextAt) {
        var beat = SCRIPT[step % SCRIPT.length];
        fire(beat);
        step++;
        if (step % SCRIPT.length === 0) jobs = 0; // new demo-day
        nextAt = now + beat.gap;
      }

      var cx = W / 2, cy = H / 2;
      // drift
      nodes.forEach(function (n) {
        n.x = n.bx + Math.sin(t * 0.5 + n.seed) * 6;
        n.y = n.by + Math.cos(t * 0.4 + n.seed * 2) * 5;
        n.heat *= 0.985;
      });

      // links
      nodes.forEach(function (n) {
        ctx.strokeStyle = 'rgba(247,244,239,' + (0.07 + n.heat * 0.25) + ')';
        ctx.lineWidth = 1 + n.heat;
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(cx, cy); ctx.stroke();
      });

      // sparks — work flowing INTO the business
      sparks = sparks.filter(function (s) { return s.p < 1; });
      sparks.forEach(function (s) {
        s.p += 0.016;
        var x = s.from.x + (cx - s.from.x) * s.p, y = s.from.y + (cy - s.from.y) * s.p;
        ctx.fillStyle = s.money ? GOLD : PINK;
        ctx.beginPath(); ctx.arc(x, y, s.money ? 3 : 2.2, 0, TAU); ctx.fill();
      });

      // center: the business
      centerPulse *= 0.96; centerGold *= 0.97;
      var glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, 56 + centerPulse * 18);
      var col = centerGold > 0.35 ? '240,180,41' : '233,30,140';
      glow.addColorStop(0, 'rgba(' + col + ',.85)');
      glow.addColorStop(1, 'rgba(' + col + ',0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, 56 + centerPulse * 18, 0, TAU); ctx.fill();
      ctx.fillStyle = PAPER;
      ctx.beginPath(); ctx.arc(cx, cy, 8 + Math.sin(t * 1.4) * 0.8, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(247,244,239,.92)';
      ctx.font = '700 12px Montserrat, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('YOUR BUSINESS', cx, cy + 30);

      // agent nodes
      nodes.forEach(function (n) {
        var r = 6 + n.heat * 4;
        if (n.heat > 0.02) {
          var g = ctx.createRadialGradient(n.x, n.y, 1, n.x, n.y, r * 3.2);
          g.addColorStop(0, 'rgba(233,30,140,' + (0.55 * n.heat) + ')');
          g.addColorStop(1, 'rgba(233,30,140,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(n.x, n.y, r * 3.2, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(233,30,140,' + (0.5 * n.heat) + ')';
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 + (1 - n.heat) * 16, 0, TAU); ctx.stroke();
        }
        ctx.fillStyle = n.heat > 0.25 ? PINK : 'rgba(247,244,239,.55)';
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(247,244,239,' + (0.55 + n.heat * 0.45) + ')';
        ctx.font = '11px "DM Sans", sans-serif';
        ctx.fillText(n.label, n.x, n.y + (n.by > cy ? 24 : -16));
      });
    }

    function start() {
      if (running) return;
      running = true; nextAt = 0;
      raf = requestAnimationFrame(draw);
    }
    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    }

    layout();
    window.addEventListener('resize', layout);

    if (reduced) {
      // Static composed frame: warm two nodes so it reads as alive, no motion.
      nodes[0].heat = 0.6; nodes[4].heat = 0.4;
      running = true; draw(0); running = false;
      ticker.innerHTML = '<b>Speed to Lead</b> — answered a new lead 41 seconds after it arrived';
      return;
    }
    // Animate only while on screen — this page has videos and blooms already;
    // an off-screen canvas burning battery would be pure waste.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { e.isIntersecting ? start() : stop(); });
      }, { threshold: 0.15 }).observe(host);
    } else {
      start();
    }
  }

  function init() {
    document.querySelectorAll('[data-fleet-demo]').forEach(build);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
