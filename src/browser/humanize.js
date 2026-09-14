// Mirage — behavioral humanization.
// Pure, seeded generators that turn synthetic CDP input into human-like motion:
// curved pointer trajectories with variable velocity + micro-jitter, keystroke
// cadence with dwell/hold distributions and rare typo-corrections, and eased scroll.
// All functions take an `rng` (see util.rngFor) so they are deterministic and unit-testable;
// the BrowserManager feeds them a per-session rng and spaces the returned events in real time.
import { clamp } from '../util.js';

const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// Box–Muller normal sample.
export function gauss(rng, mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Cubic-Bézier pointer path (x0,y0)->(x1,y1). Slight S-curve bow, per-vertex normal jitter,
// and non-uniform speed (slow near endpoints). Each point carries `delay` = ms to wait before emitting it.
export function pointerPath(rng, x0, y0, x1, y1, opts = {}) {
  const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy) || 1;
  const steps = clamp(Math.round(opts.steps || (7 + dist / 12)), 6, 48);
  const nx = -dy / dist, ny = dx / dist;                 // unit normal
  const amp = (rng.bool() ? 1 : -1) * clamp(dist * (0.06 + Math.abs(gauss(rng, 0, 0.05))), 4, 120);
  // control points offset to opposite sides → gentle S (hands don't move in a straight line)
  const p1x = x0 + dx * 0.33 + nx * amp, p1y = y0 + dy * 0.33 + ny * amp;
  const p2x = x0 + dx * 0.66 - nx * amp * 0.55, p2y = y0 + dy * 0.66 - ny * amp * 0.55;
  const bez = (t) => {
    const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [a * x0 + b * p1x + c * p2x + d * x1, a * y0 + b * p1y + c * p2y + d * y1];
  };
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const raw = i / steps, t = easeInOut(raw);           // ease → variable velocity
    let [px, py] = bez(t);
    px += gauss(rng, 0, 0.7); py += gauss(rng, 0, 0.7);    // hand tremor (sub-pixel)
    // small pauses mid-flight (people don't move perfectly continuously)
    const speedBias = Math.sin(Math.PI * raw);            // ~1 mid-flight, ~0 at ends
    const delay = Math.round(clamp(6 + (1 - speedBias) * 16 + Math.abs(gauss(rng, 0, 6)), 4, 70));
    pts.push({ x: Math.round(clamp(px, 0, 1e5)), y: Math.round(clamp(py, 0, 1e5)), delay });
  }
  return pts;
}

// Per-keystroke plan from a WPM drawn around a base, with dwell (gap before) + hold (down duration).
// Rarely injects a typo + backspace correction so the trace has "self-repair" like a human.
export function keystrokePlan(rng, text, opts = {}) {
  const baseWpm = opts.wpm || clamp(gauss(rng, 46, 12), 18, 110);   // chars-per-minute-ish
  const baseMs = 60000 / (baseWpm * 5);                             // ~avg inter-key ms for 5-char words
  const events = [];
  const chars = Array.from(text);
  const typoKeys = 'qwertyuiopasdfghjkl;zxcvbnm';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], prev = chars[i - 1] || '';
    let dwell = Math.max(20, gauss(rng, baseMs, baseMs * 0.4));
    if (ch === ' ') dwell *= 1.35;                                   // pause before/after words
    if (prev === ch) dwell *= 0.55;                                  // same-letter digraphs are fast
    if (/[.,!?;:]/.test(ch)) dwell *= 1.8;                           // punctuation slows people down
    if (/[aeiou]/.test(ch) && /[aeiou]/.test(prev)) dwell *= 0.85;
    const hold = Math.max(22, gauss(rng, 68, 22));                  // key-down duration
    // 1.5% typo with self-correction (skip on first char / space)
    if (i > 0 && ch !== ' ' && /[a-z0-9]/i.test(ch) && rng.bool(0.015)) {
      const wrong = rng.pick(typoKeys.split(''));
      events.push({ type: 'key', ch: wrong, down: Math.round(clamp(dwell, 20, 260)), hold: Math.round(hold) });
      events.push({ type: 'backspace', down: Math.round(clamp(gauss(rng, 120, 60), 40, 320)), hold: Math.round(gauss(rng, 55, 18)) });
    }
    events.push({ type: 'key', ch, down: Math.round(clamp(dwell, 20, 260)), hold: Math.round(clamp(hold, 22, 160)) });
  }
  return events;
}

// Wheel-scroll plan: several decelerating ticks whose signed magnitudes sum to ~deltaY.
// A real flick is fast at the start and settles — weights decay, then we normalize to the target.
export function scrollPlan(rng, deltaY, opts = {}) {
  const ticks = clamp(Math.round((opts.ticks || 4) + Math.abs(deltaY) / 120 + rng.next() * 3), 2, 16);
  const weights = [];
  let wsum = 0;
  for (let i = 0; i < ticks; i++) { const w = Math.pow(1 - i / ticks, 1.4) + 0.15; weights.push(w); wsum += w; }
  const out = [];
  let emitted = 0;
  for (let i = 0; i < ticks; i++) {
    let d = Math.round(deltaY * (weights[i] / wsum));
    if (i === ticks - 1) d = deltaY - emitted;               // last tick absorbs rounding so the total matches
    if (d === 0) d = (Math.sign(deltaY) || 1);
    emitted += d;
    out.push({ deltaY: d, delay: Math.round(clamp(gauss(rng, 30, 14), 8, 90)) });
  }
  return out;
}

// A short dwell at a spot before clicking (reaction/aim time).
export function clickHold(rng) {
  return { pre: Math.round(clamp(gauss(rng, 60, 28), 12, 220)), post: Math.round(clamp(gauss(rng, 45, 20), 10, 160)) };
}
