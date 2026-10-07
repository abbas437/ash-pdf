#!/usr/bin/env node
// Generates build/icon.png (512x512, original artwork) from an inline SVG using sharp.
// electron-builder converts it to the Windows .ico at build time.
// Design: deep ink-green rounded square, stone-coloured page with a folded corner,
// brass "ASH" wordmark and three text rules. No third-party marks or imagery.
// sharp is not a project dependency; it is resolved from SHARP_PATH or the sandbox's
// global tools folder. Re-run only when the artwork changes; the PNG is committed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || '/opt/npm-tools/node_modules/sharp');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1f4d3f"/><stop offset="1" stop-color="#123329"/>
    </linearGradient>
    <linearGradient id="brass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d9b25f"/><stop offset="1" stop-color="#a87f2e"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#bg)"/>
  <path d="M136 84 H310 L380 154 V428 H136 Z" fill="#e7e1d4"/>
  <path d="M310 84 V154 H380 Z" fill="#c9bfa9"/>
  <rect x="168" y="196" width="180" height="14" rx="7" fill="#b8ae98"/>
  <rect x="168" y="228" width="140" height="14" rx="7" fill="#b8ae98"/>
  <rect x="168" y="260" width="164" height="14" rx="7" fill="#b8ae98"/>
  <rect x="112" y="312" width="288" height="104" rx="22" fill="url(#brass)"/>
  <text x="256" y="390" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700"
        font-size="76" letter-spacing="10" fill="#123329">ASH</text>
</svg>`;

const out = join(root, 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
const info = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
console.log(`make-icon: wrote build/icon.png ${info.width}x${info.height}`);
