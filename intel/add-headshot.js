#!/usr/bin/env node
'use strict';

/**
 * Put a headshot into the site so the outreach can use it.
 *
 *   node intel/add-headshot.js ~/Desktop/my-photo.jpg
 *   node intel/add-headshot.js ~/Desktop/my-photo.jpg --name yvette-kahn
 *
 * Copies the file into images/, checks it is actually an image and actually
 * suitable for an email signature, and prints the exact commands to finish.
 *
 * The checks are the point. A signature image renders at 120px wide in an
 * inbox, which is unforgiving in ways that are not obvious when you are
 * looking at a full-size photo on a laptop:
 *
 *   - a tall full-body shot shrinks until the face is a few pixels across
 *   - a huge file is a spam signal and slow on a phone
 *   - a small file goes soft on a retina screen
 *
 * Zero dependencies: dimensions are read straight out of the file header.
 */

const fs = require('fs');
const path = require('path');

const TARGET_RENDER_WIDTH = 120;   // what the email actually displays at

/** Read pixel dimensions from the file header. JPEG, PNG, GIF and WebP. */
function dimensions(buf) {
  // PNG: IHDR is always at byte 16.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: little-endian width/height at byte 6.
  if (buf.length > 10 && buf.slice(0, 3).toString('ascii') === 'GIF') {
    return { type: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP (VP8X / VP8 / VP8L all live inside a RIFF container).
  if (buf.length > 30 && buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const fourcc = buf.slice(12, 16).toString('ascii');
    if (fourcc === 'VP8X') {
      return {
        type: 'image/webp',
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    }
    return { type: 'image/webp', width: null, height: null };
  }
  // JPEG: walk the markers to a start-of-frame.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15, skipping the non-frame markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { type: 'image/jpeg', width: null, height: null };
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(`
Add a headshot for outreach emails

  node intel/add-headshot.js <path-to-image> [--name <slug>]

  --name   filename to use in images/ (default: headshot)
`);
    process.exit(args.length ? 0 : 2);
  }

  let src = null, name = 'headshot';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') name = String(argv_at(args, ++i)).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    else src = args[i];
  }

  if (!fs.existsSync(src)) {
    console.error(`No file at ${src}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(src);
  const info = dimensions(buf);

  if (!info) {
    console.error(`${src} is not a JPEG, PNG, GIF or WebP — that is what an email client can render.`);
    process.exit(1);
  }

  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[info.type];
  const dest = path.join('images', name + ext);
  const kb = Math.round(buf.length / 1024);

  console.log(`\n${path.basename(src)} → ${info.type}, ${info.width || '?'}×${info.height || '?'}, ${kb}KB\n`);

  // ---- the checks that matter at 120px ------------------------------------
  const problems = [], warnings = [];

  if (info.width && info.height) {
    const ratio = info.height / info.width;
    if (ratio > 1.3) {
      const faceWidth = Math.round(TARGET_RENDER_WIDTH / ratio);
      problems.push(
        `This is a tall portrait (${info.width}×${info.height}). Rendered at ${TARGET_RENDER_WIDTH}px wide ` +
        `it becomes about ${TARGET_RENDER_WIDTH}×${Math.round(TARGET_RENDER_WIDTH * ratio)}px, and a face that ` +
        `fills a third of a full-body shot ends up roughly ${Math.round(faceWidth / 3)}px across — ` +
        `unrecognisable.\n     Crop to head-and-shoulders, square, before using this.`
      );
    } else if (ratio < 0.77) {
      warnings.push('Wider than it is tall — a square crop reads better as a signature.');
    }

    // 2× the render width keeps it crisp on a retina screen.
    if (info.width < TARGET_RENDER_WIDTH * 2) {
      warnings.push(`Only ${info.width}px wide — it will look soft. Aim for 300–400px.`);
    }
    if (info.width > 1200) {
      warnings.push(`${info.width}px is far larger than needed. Resize to ~400px square.`);
    }
  }

  if (kb > 1500) problems.push(`${kb}KB is heavy enough to be a spam signal. Get it under 200KB.`);
  else if (kb > 250) warnings.push(`${kb}KB — aim for under 200KB.`);

  if (info.type === 'image/gif') {
    warnings.push('Outlook renders only the first frame of a GIF, so the animation has to work as a still.');
  }

  for (const p of problems) console.log(`  ✗  ${p}`);
  for (const w of warnings) console.log(`  !  ${w}`);
  if (!problems.length && !warnings.length) console.log('  ✓  Good size and shape for an email signature.');

  if (problems.length) {
    console.log(`\nNot copied. Fix the above and run again — or pass it anyway with --force if you disagree.`);
    if (!args.includes('--force')) process.exit(1);
  }

  fs.mkdirSync('images', { recursive: true });
  fs.writeFileSync(dest, buf);

  const url = `https://infinityreachmedia.com/${dest}`;
  console.log(`\n  → ${dest}\n`);
  console.log('Next:\n');
  console.log(`  git add ${dest} && git commit -m "Add headshot for outreach" && git push`);
  console.log(`  # wait for the deploy, then:`);
  console.log(`  export OUTREACH_SIGNATURE_IMAGE_URL=${url}`);
  console.log(`  node intel/outreach.js --check-image`);
  console.log(`\nThen add OUTREACH_SIGNATURE_IMAGE_URL as a repository *variable*`);
  console.log(`(Settings → Secrets and variables → Actions → Variables) so the daily job uses it.\n`);
}

function argv_at(args, i) { return args[i] === undefined ? '' : args[i]; }

if (require.main === module) main();

module.exports = { dimensions };
