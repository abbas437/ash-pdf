// Stamp catalogue and pure helpers shared by the Stamp tool (renderer/ui/tools-stamp.js) and tests.
import { formatDate } from './siglib.js';

const GREEN = '#1b7f3b', RED = '#b42318', BLUE = '#1d4ed8', GREY = '#4b5563';
/** Standard stamps: [text, colour, borderWidth]. */
export const STANDARD_STAMPS = [
  ['APPROVED', GREEN, 2], ['APPROVED AS NOTED', GREEN, 2], ['NOT APPROVED', RED, 2], ['REJECTED', RED, 3],
  ['REVISE AND RESUBMIT', RED, 2], ['DRAFT', GREY, 2], ['FINAL', GREEN, 3], ['CONFIDENTIAL', RED, 3],
  ['FOR COMMENT', BLUE, 2], ['FOR INFORMATION', BLUE, 2], ['RECEIVED', BLUE, 2], ['REVIEWED', GREEN, 2],
  ['REVISED', BLUE, 2], ['VOID', RED, 3], ['COMPLETED', GREEN, 2], ['PAID', GREEN, 3], ['COPY', GREY, 2],
  ['ORIGINAL', BLUE, 3], ['SIGN HERE', RED, 2], ['WITNESS', BLUE, 2],
].map(([text, color, borderWidth]) => ({ id: 'std-' + text.toLowerCase().replace(/\s+/g, '-'), text, color, borderWidth }));
/** Stamps whose second line is filled at placement. */
export const DYNAMIC_STAMPS = ['APPROVED', 'REVIEWED', 'RECEIVED', 'REJECTED', 'REVISED', 'COMPLETED']
  .map((t) => ({ ...STANDARD_STAMPS.find((s) => s.text === t), dynamic: true }))
  .map((s) => ({ ...s, id: s.id.replace('std-', 'dyn-') }));

/**
 * Second line of a dynamic stamp, e.g. "by A. Example · 2026-10-07 14:05".
 * opts: {author, showAuthor=true, showDate=true, showTime=false, dateFormat='YYYY-MM-DD'}.
 */
export function stampSubtext(date, { author = '', showAuthor = true, showDate = true, showTime = false, dateFormat = 'YYYY-MM-DD' } = {}) {
  const p = (n) => String(n).padStart(2, '0');
  const parts = [];
  if (showAuthor && String(author).trim()) parts.push(`by ${String(author).trim()}`);
  const when = [];
  if (showDate) when.push(formatDate(`${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`, dateFormat));
  if (showTime) when.push(`${p(date.getHours())}:${p(date.getMinutes())}`);
  if (when.length) parts.push(when.join(' '));
  return parts.join(' · ');
}

/**
 * Text layout of a stamp box in visible space (y down). `w1`/`sw1` = width of text / subtext at
 * size 1, `capH` = cap height per unit size. Returns {size, base, subSize, subBase}.
 */
export function stampLayout(o, w1, sw1, capH) {
  const bw = Number.isFinite(o.borderWidth) ? o.borderWidth : 3, pad = bw + 4;
  const iw = Math.max(1, o.w - 2 * pad), ih = Math.max(1, o.h - 2 * pad);
  if (!o.subtext) {
    const size = Math.max(1, Math.min(iw / (w1 || 1), ih / capH));
    return { size, base: o.y + o.h / 2 + (capH * size) / 2 };
  }
  const size = Math.max(1, Math.min(iw / (w1 || 1), (ih * 0.6) / capH));
  const subSize = Math.max(1, Math.min(iw / (sw1 || 1), (ih * 0.28) / capH, size * 0.6));
  const gap = capH * size * 0.3, total = capH * (size + subSize) + gap;
  const base = o.y + (o.h - total) / 2 + capH * size;
  return { size, base, subSize, subBase: base + gap + capH * subSize };
}
