/**
 * Request / tool analytics with JSON-file persistence.
 *
 * Same shape as the other TechMavie MCP servers (mcp-github v2), plus:
 *   - clientsByApp: which MCP client is calling (Claude, Cursor, ...)
 *   - toolErrors / toolDurationMs: error counts and timing per tool
 * Privacy: IPs are stored only as truncated SHA-256 hashes, recent calls store no IP,
 * and usr_ keys never appear in endpoint names.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hashIp } from './security.js';

export interface AnalyticsData {
  serverStartTime: string;
  totalRequests: number;
  totalToolCalls: number;
  totalToolErrors: number;
  requestsByMethod: Record<string, number>;
  requestsByEndpoint: Record<string, number>;
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  toolDurationMs: Record<string, number>;
  recentToolCalls: Array<{ tool: string; timestamp: string; ok: boolean; ms: number }>;
  clientsByIp: Record<string, number>;
  clientsByUserAgent: Record<string, number>;
  clientsByApp: Record<string, number>;
  hourlyRequests: Record<string, number>;
}

const MAX_RECENT_CALLS = 100;
const MAX_HOURLY_BUCKETS = 24 * 30; // keep 30 days of hourly buckets
// Caps so analytics.json can't grow without bound (scanners, many clients).
const MAX_ENDPOINT_KEYS = 50;
const MAX_IP_KEYS = 10_000;
const MAX_USER_AGENT_KEYS = 200;

/** Increment a counter, folding new keys into "(other)" once the map is full. */
function bump(map: Record<string, number>, key: string, maxKeys: number): void {
  const k = key in map || Object.keys(map).length < maxKeys ? key : '(other)';
  map[k] = (map[k] || 0) + 1;
}

function emptyAnalytics(): AnalyticsData {
  return {
    serverStartTime: new Date().toISOString(),
    totalRequests: 0,
    totalToolCalls: 0,
    totalToolErrors: 0,
    requestsByMethod: {},
    requestsByEndpoint: {},
    toolCalls: {},
    toolErrors: {},
    toolDurationMs: {},
    recentToolCalls: [],
    clientsByIp: {},
    clientsByUserAgent: {},
    clientsByApp: {},
    hourlyRequests: {},
  };
}

/** Recognise common MCP clients from their User-Agent. */
export function parseClientApp(userAgent: string | undefined): string {
  const ua = (userAgent || '').toLowerCase();
  if (!ua) return 'Unknown';
  if (ua.includes('claude')) return 'Claude';
  if (ua.includes('cursor')) return 'Cursor';
  if (ua.includes('windsurf') || ua.includes('codeium')) return 'Windsurf';
  if (ua.includes('vscode') || ua.includes('visual studio code')) return 'VS Code';
  if (ua.includes('kilo')) return 'Kilo Code';
  if (ua.includes('cline')) return 'Cline';
  if (ua.includes('openwebui') || ua.includes('open-webui')) return 'Open WebUI';
  if (ua.includes('librechat')) return 'LibreChat';
  if (ua.includes('n8n')) return 'n8n';
  if (ua.includes('inspector')) return 'MCP Inspector';
  if (ua.includes('curl')) return 'curl';
  if (ua.includes('python')) return 'Python';
  if (ua.includes('node')) return 'Node.js';
  if (ua.includes('mozilla')) return 'Browser';
  return 'Other';
}

export class Analytics {
  private data: AnalyticsData;
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, 'analytics.json');
    this.data = this.load();
  }

  private load(): AnalyticsData {
    try {
      if (fs.existsSync(this.file)) {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<AnalyticsData>;
        // Fill defaults for any field missing from older files.
        return { ...emptyAnalytics(), ...loaded };
      }
    } catch (error) {
      console.warn('Could not load analytics file, starting fresh:', error);
    }
    return emptyAnalytics();
  }

  save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.warn('Could not save analytics file:', error);
    }
  }

  /** Save every `intervalMs`; the timer won't keep the process alive. */
  startAutoSave(intervalMs = 5 * 60_000): NodeJS.Timeout {
    const timer = setInterval(() => this.save(), intervalMs);
    timer.unref?.();
    return timer;
  }

  trackRequest(info: { method: string; endpoint: string; ip: string; userAgent?: string }): void {
    const d = this.data;
    d.totalRequests++;
    bump(d.requestsByMethod, info.method.toUpperCase().slice(0, 10), 20);
    bump(d.requestsByEndpoint, info.endpoint, MAX_ENDPOINT_KEYS);
    bump(d.clientsByIp, hashIp(info.ip || 'unknown'), MAX_IP_KEYS);

    const ua = info.userAgent || 'unknown';
    const shortUa = (ua.split('/')[0] || ua).slice(0, 50);
    bump(d.clientsByUserAgent, shortUa, MAX_USER_AGENT_KEYS);

    const app = parseClientApp(ua);
    d.clientsByApp[app] = (d.clientsByApp[app] || 0) + 1;

    const hour = new Date().toISOString().slice(0, 13) + ':00';
    d.hourlyRequests[hour] = (d.hourlyRequests[hour] || 0) + 1;
    const hours = Object.keys(d.hourlyRequests);
    if (hours.length > MAX_HOURLY_BUCKETS) {
      for (const old of hours.sort().slice(0, hours.length - MAX_HOURLY_BUCKETS)) delete d.hourlyRequests[old];
    }
  }

  trackToolCall(tool: string, isError: boolean, durationMs: number): void {
    const d = this.data;
    d.totalToolCalls++;
    d.toolCalls[tool] = (d.toolCalls[tool] || 0) + 1;
    d.toolDurationMs[tool] = (d.toolDurationMs[tool] || 0) + durationMs;
    if (isError) {
      d.totalToolErrors++;
      d.toolErrors[tool] = (d.toolErrors[tool] || 0) + 1;
    }
    d.recentToolCalls.unshift({ tool, timestamp: new Date().toISOString(), ok: !isError, ms: durationMs });
    if (d.recentToolCalls.length > MAX_RECENT_CALLS) d.recentToolCalls.length = MAX_RECENT_CALLS;
  }

  uptime(): string {
    const diff = Date.now() - new Date(this.data.serverStartTime).getTime();
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  summary(serverName: string) {
    const d = this.data;
    const sortDesc = (obj: Record<string, number>, limit?: number) =>
      Object.fromEntries(Object.entries(obj).sort(([, a], [, b]) => b - a).slice(0, limit));
    const last24Hours = Object.fromEntries(
      Object.entries(d.hourlyRequests)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 24)
        .reverse(),
    );

    return {
      server: serverName,
      uptime: this.uptime(),
      serverStartTime: d.serverStartTime,
      summary: {
        totalRequests: d.totalRequests,
        totalToolCalls: d.totalToolCalls,
        totalToolErrors: d.totalToolErrors,
        uniqueClients: Object.keys(d.clientsByIp).length,
      },
      breakdown: {
        byMethod: d.requestsByMethod,
        byEndpoint: sortDesc(d.requestsByEndpoint),
        byTool: sortDesc(d.toolCalls),
        errorsByTool: sortDesc(d.toolErrors),
      },
      clients: {
        byIp: sortDesc(d.clientsByIp, 20),
        byUserAgent: sortDesc(d.clientsByUserAgent, 20),
        byApp: sortDesc(d.clientsByApp),
      },
      hourlyRequests: last24Hours,
      recentToolCalls: d.recentToolCalls.slice(0, 20),
    };
  }

  toolStats() {
    const d = this.data;
    return {
      totalToolCalls: d.totalToolCalls,
      totalToolErrors: d.totalToolErrors,
      tools: Object.entries(d.toolCalls)
        .sort(([, a], [, b]) => b - a)
        .map(([tool, count]) => ({
          tool,
          count,
          errors: d.toolErrors[tool] || 0,
          avgMs: count ? Math.round((d.toolDurationMs[tool] || 0) / count) : 0,
          percentage: d.totalToolCalls ? `${((count / d.totalToolCalls) * 100).toFixed(1)}%` : '0%',
        })),
      recentCalls: d.recentToolCalls,
    };
  }
}

/** Dashboard HTML: the page is public, the data behind it needs the X-API-Key. */
export function dashboardHtml(serverName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverName} - Analytics</title>
  <!-- Pinned version + SRI hash: the page holds the analytics key, so the CDN script must not change. -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" integrity="sha384-e6nUZLBkQ86NJ6TVVKAeSaK8jWa3NhkYWZFomE39AvDbQWeie9PlQqM3pmYW5d1g" crossorigin="anonymous"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #0b1220 0%, #111a2e 100%); min-height: 100vh; color: #e6edf3; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 30px; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 16px; }
    header h1 { font-size: 2rem; background: linear-gradient(90deg, #38bdf8, #34d399); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
    header p { color: #94a3b8; }
    .auth-card { max-width: 400px; margin: 60px auto; padding: 32px; background: rgba(255,255,255,0.05); border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); text-align: center; }
    .auth-card h2 { margin-bottom: 16px; font-size: 1.25rem; }
    .auth-card input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: #e6edf3; font-size: 1rem; margin-bottom: 12px; }
    .auth-card button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #38bdf8; color: #0b1220; font-weight: 600; cursor: pointer; font-size: 1rem; }
    .auth-card button:hover { background: #7dd3fc; }
    .auth-error { color: #f87171; margin-top: 8px; font-size: 0.875rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 24px; text-align: center; border: 1px solid rgba(255,255,255,0.1); }
    .stat-card h3 { color: #94a3b8; font-size: 0.875rem; margin-bottom: 8px; }
    .stat-card .value { font-size: 2rem; font-weight: bold; color: #38bdf8; }
    .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr)); gap: 20px; margin-bottom: 30px; }
    .chart-card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; border: 1px solid rgba(255,255,255,0.1); }
    .chart-card h3 { margin-bottom: 16px; }
    .recent-calls { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; border: 1px solid rgba(255,255,255,0.1); }
    .recent-calls h3 { margin-bottom: 16px; }
    .call-item { display: flex; justify-content: space-between; gap: 12px; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .call-item:last-child { border-bottom: none; }
    .call-tool { color: #38bdf8; font-weight: 500; }
    .call-tool.err { color: #f87171; }
    .call-time { color: #94a3b8; font-size: 0.875rem; white-space: nowrap; }
    .refresh-note { text-align: center; color: #94a3b8; margin-top: 20px; font-size: 0.875rem; }
    #dashboard { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${serverName}</h1>
      <p>Usage analytics</p>
    </header>
    <div id="authSection">
      <div class="auth-card">
        <h2>API key required</h2>
        <p style="color:#94a3b8;margin-bottom:16px;">Enter the server's MCP_API_KEY to view analytics.</p>
        <input type="password" id="apiKeyInput" placeholder="MCP API key" />
        <button id="loginButton">View dashboard</button>
        <p class="auth-error" id="authError" style="display:none;"></p>
      </div>
    </div>
    <div id="dashboard">
      <div class="stats-grid" id="stats"></div>
      <div class="charts-grid">
        <div class="chart-card"><h3>Tool usage</h3><canvas id="toolChart"></canvas></div>
        <div class="chart-card"><h3>Hourly requests (last 24h)</h3><canvas id="hourlyChart"></canvas></div>
        <div class="chart-card"><h3>Clients by app</h3><canvas id="appChart"></canvas></div>
        <div class="chart-card"><h3>Requests by endpoint</h3><canvas id="endpointChart"></canvas></div>
      </div>
      <div class="recent-calls"><h3>Recent tool calls</h3><div id="recentCalls"></div></div>
      <p class="refresh-note">Auto-refreshes every 30 seconds</p>
    </div>
  </div>
  <script>
    var charts = {};
    var colors = ['#38bdf8', '#34d399', '#a78bfa', '#fb923c', '#f87171', '#fbbf24', '#818cf8', '#2dd4bf', '#e879f9', '#94a3b8'];
    var axis = { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.08)' } };

    function getKey() { try { return sessionStorage.getItem('mcp_api_key') || ''; } catch (e) { return ''; } }
    function setKey(k) { try { k ? sessionStorage.setItem('mcp_api_key', k) : sessionStorage.removeItem('mcp_api_key'); } catch (e) {} }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    async function fetchData() {
      var basePath = window.location.pathname.replace(/\\/analytics\\/dashboard\\/?$/, '');
      var res = await fetch(basePath + '/analytics', { headers: { 'X-API-Key': getKey() } });
      if (!res.ok) throw new Error('Unauthorized');
      return res.json();
    }

    function draw(id, config) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), config); }

    function render(data) {
      var s = data.summary;
      document.getElementById('stats').innerHTML = [
        ['Total requests', s.totalRequests.toLocaleString()],
        ['Tool calls', s.totalToolCalls.toLocaleString()],
        ['Tool errors', s.totalToolErrors.toLocaleString()],
        ['Unique clients', s.uniqueClients.toLocaleString()],
        ['Uptime', data.uptime]
      ].map(function (c) { return '<div class="stat-card"><h3>' + c[0] + '</h3><div class="value">' + esc(c[1]) + '</div></div>'; }).join('');

      var tools = Object.entries(data.breakdown.byTool).slice(0, 10);
      draw('toolChart', { type: 'doughnut', data: { labels: tools.map(function (t) { return t[0].replace('forgejo_', ''); }), datasets: [{ data: tools.map(function (t) { return t[1]; }), backgroundColor: colors }] }, options: { plugins: { legend: { position: 'right', labels: { color: '#e6edf3' } } } } });

      var hours = Object.entries(data.hourlyRequests);
      draw('hourlyChart', { type: 'bar', data: { labels: hours.map(function (h) { return h[0].slice(11, 16); }), datasets: [{ data: hours.map(function (h) { return h[1]; }), backgroundColor: '#38bdf8' }] }, options: { scales: { x: axis, y: Object.assign({ beginAtZero: true }, axis) }, plugins: { legend: { display: false } } } });

      var apps = Object.entries(data.clients.byApp).slice(0, 8);
      draw('appChart', { type: 'bar', data: { labels: apps.map(function (a) { return a[0]; }), datasets: [{ data: apps.map(function (a) { return a[1]; }), backgroundColor: colors }] }, options: { indexAxis: 'y', scales: { x: Object.assign({ beginAtZero: true }, axis), y: axis }, plugins: { legend: { display: false } } } });

      var eps = Object.entries(data.breakdown.byEndpoint).slice(0, 10);
      draw('endpointChart', { type: 'bar', data: { labels: eps.map(function (e) { return e[0]; }), datasets: [{ data: eps.map(function (e) { return e[1]; }), backgroundColor: colors }] }, options: { scales: { x: axis, y: Object.assign({ beginAtZero: true }, axis) }, plugins: { legend: { display: false } } } });

      var calls = data.recentToolCalls.slice(0, 15);
      document.getElementById('recentCalls').innerHTML = calls.length ? calls.map(function (c) {
        return '<div class="call-item"><span class="call-tool' + (c.ok === false ? ' err' : '') + '">' + esc(c.tool) + (c.ok === false ? ' (error)' : '') + '</span><span class="call-time">' + (c.ms != null ? c.ms + ' ms &middot; ' : '') + new Date(c.timestamp).toLocaleString() + '</span></div>';
      }).join('') : '<p style="color:#94a3b8;text-align:center;padding:20px;">No tool calls yet</p>';
    }

    async function load() { try { render(await fetchData()); return true; } catch (e) { return false; } }

    async function show() {
      document.getElementById('authSection').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      setInterval(load, 30000);
    }

    async function login() {
      var key = document.getElementById('apiKeyInput').value.trim();
      if (!key) return;
      setKey(key);
      if (await load()) { show(); } else {
        setKey('');
        var err = document.getElementById('authError');
        err.textContent = 'Invalid API key. Please try again.';
        err.style.display = 'block';
      }
    }

    document.getElementById('loginButton').addEventListener('click', login);
    document.getElementById('apiKeyInput').addEventListener('keypress', function (e) { if (e.key === 'Enter') login(); });
    (async function () { if (getKey() && await load()) show(); else setKey(''); })();
  </script>
</body>
</html>`;
}
