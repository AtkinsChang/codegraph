/**
 * Dashboard shell. CG-13 builds the Chart.js views on top of this; for now it
 * just proves the gated API and the vendored chart library are both reachable.
 */

/** Every fetch goes through here so an expired session lands on /login instead
 *  of failing silently mid-render. */
export async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (response.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error('session expired');
  }
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return response.json();
}

function set(id, text, bad = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

const chart = window.Chart;
set('chart-status', chart ? `Chart.js ${chart.version}` : 'Not loaded', !chart);

try {
  const health = await api('/api/health');
  set('db-status', health.ok ? 'Connected' : 'Unavailable', !health.ok);
  set('latest-event', health.database?.latest_event_day ?? 'No events yet');
  set('latest-rollup', health.database?.latest_rollup_day ?? 'No rollups yet');
} catch (err) {
  set('db-status', String(err.message ?? err), true);
}
