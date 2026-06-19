// Timing helpers — measures tap-to-render latency, fails the test if any
// step exceeds SLOW_THRESHOLD_MS so lag regressions are caught automatically.

const SLOW_THRESHOLD_MS = 4000;
const _timings = [];

async function timed(label, fn) {
  const t0 = Date.now();
  let result;
  try {
    result = await fn();
  } finally {
    const dt = Date.now() - t0;
    _timings.push({ label, dt });
    const tag = dt > SLOW_THRESHOLD_MS ? '⚠ SLOW' : 'ok';
    console.log(`  [${tag}] ${label} took ${dt}ms`);
  }
  return result;
}

function timings() {
  return _timings.slice();
}

function reportSummary() {
  if (!_timings.length) return;
  const slow = _timings.filter((t) => t.dt > SLOW_THRESHOLD_MS);
  const avg = Math.round(_timings.reduce((s, t) => s + t.dt, 0) / _timings.length);
  console.log(`\n  ── timing summary ──`);
  console.log(`     ${_timings.length} steps, avg ${avg}ms`);
  if (slow.length) {
    console.log(`     ⚠ ${slow.length} slow steps (> ${SLOW_THRESHOLD_MS}ms):`);
    for (const s of slow) console.log(`       - ${s.label}: ${s.dt}ms`);
  } else {
    console.log(`     no slow steps`);
  }
}

function failIfAnySlow() {
  const slow = _timings.filter((t) => t.dt > SLOW_THRESHOLD_MS);
  if (slow.length) {
    throw new Error(
      `Lag regression: ${slow.length} step(s) exceeded ${SLOW_THRESHOLD_MS}ms — ` +
        slow.map((s) => `${s.label}=${s.dt}ms`).join(', ')
    );
  }
}

module.exports = { SLOW_THRESHOLD_MS, timed, timings, reportSummary, failIfAnySlow };
