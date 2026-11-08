// Snap points for the measure tools. Pure: no DOM, no pdf.js, so test/measure-snap-lib.test.js runs it in Node.
//
//   snapPointsFromOps(opList, OPS, {max})  pdf.js page.getOperatorList() -> [[x, y], ...] in PDF page
//                       space: both ends of every straight segment (lineTo, closePath) of stroked paths,
//                       de-duplicated to 0.01 pt. Curve ends count only when a straight segment also ends there.
//   nearestSnap(points, x, y, tol)  the closest point within tol of (x, y), or null.
import { mul } from './table-extract.js';

export function snapPointsFromOps({ fnArray, argsArray }, OPS, { max = 50000 } = {}) {
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const seen = new Set(), out = [];
  const add = ([x, y]) => {
    const rx = Math.round(x * 100), ry = Math.round(y * 100);
    const key = `${rx},${ry}`;
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push([rx / 100, ry / 100]);
  };
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < fnArray.length && out.length < max; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const [paint, [data] = []] = args ?? [];
      if (!data || !STROKE.has(paint)) continue;
      const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      let cur = null, start = null; // current point, subpath start (page space)
      for (let k = 0; k < data.length;) {
        const op = data[k++];
        if (op === 0) { cur = start = pt(data[k++], data[k++]); } // moveTo
        else if (op === 1) { // lineTo
          const p = pt(data[k++], data[k++]);
          if (cur) { add(cur); add(p); } else start = p;
          cur = p;
        } else if (op === 2) { cur = pt(data[k + 4], data[k + 5]); k += 6; } // curveTo: end is not a snap point
        else if (op === 3) { cur = pt(data[k + 2], data[k + 3]); k += 4; } // quadraticCurveTo
        else if (op === 4) { if (cur && start) { add(cur); add(start); } cur = start; } // closePath
        else break;
      }
    }
  }
  return out;
}

export function nearestSnap(points, x, y, tol) {
  let best = null, bestD = tol * tol;
  for (const p of points) {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best ? [best[0], best[1]] : null;
}
