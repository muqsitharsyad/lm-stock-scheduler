import http from 'http';
import { AppConfig } from '../../app/config/env';
import { readJson } from '../../app/utils/file';
import { StockSnapshot } from '../../app/types/stock';
import { logger } from '../../app/utils/logger';

export interface BotStatus {
  startedAt: Date;
  lastCheckAt: Date | null;
  lastCheckSuccess: boolean;
  checkCount: number;
  errorCount: number;
}

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}j ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDate(d: Date | null): string {
  if (!d) return '-';
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
}

function buildHtml(status: BotStatus, config: AppConfig, snapshot: StockSnapshot | null): string {
  const uptime = formatUptime(status.startedAt);
  const lastCheck = formatDate(status.lastCheckAt);
  const startedAt = formatDate(status.startedAt);

  const locations =
    config.lmTargetLocations.length > 0 ? config.lmTargetLocations.join(', ') : 'Semua butik';
  const weights =
    config.lmTargetWeights.length > 0
      ? config.lmTargetWeights.map((w) => `${w} gr`).join(', ')
      : 'Semua gramasi';

  // Build stock table rows from snapshot
  let stockRows = '';
  if (snapshot && snapshot.length > 0) {
    for (const loc of snapshot) {
      const availableItems = loc.items.filter((i) => i.qty > 0);
      const statusBadge =
        availableItems.length > 0
          ? `<span class="badge available">${availableItems.length} tersedia</span>`
          : `<span class="badge empty">Habis</span>`;
      const itemList =
        availableItems.length > 0
          ? availableItems.map((i) => `<span class="tag">${i.weight}</span>`).join(' ')
          : '<span class="none">—</span>';
      stockRows += `<tr>
        <td>${loc.location}</td>
        <td>${statusBadge}</td>
        <td>${itemList}</td>
      </tr>`;
    }
  } else {
    stockRows = '<tr><td colspan="3" class="none">Belum ada data snapshot</td></tr>';
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>LM Stock Scheduler — Status</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 0.85rem; margin-bottom: 24px; }
    .cards { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 28px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; min-width: 160px; }
    .card-label { font-size: 0.72rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .card-value { font-size: 1.1rem; font-weight: 600; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e;
           box-shadow: 0 0 0 3px #dcfce7; margin-right: 6px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{box-shadow:0 0 0 3px #dcfce7} 50%{box-shadow:0 0 0 6px #bbf7d0} }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px;
            border: 1px solid #e2e8f0; overflow: hidden; }
    th { background: #f1f5f9; font-size: 0.78rem; text-transform: uppercase; letter-spacing:.04em;
         color: #64748b; padding: 10px 14px; text-align: left; }
    td { padding: 10px 14px; border-top: 1px solid #f1f5f9; font-size: 0.88rem; }
    tr:hover td { background: #f8fafc; }
    .badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
    .badge.available { background: #dcfce7; color: #15803d; }
    .badge.empty { background: #fee2e2; color: #b91c1c; }
    .tag { display: inline-block; font-size: 0.78rem; background: #f1f5f9; color: #475569;
           padding: 2px 7px; border-radius: 5px; margin: 1px; }
    .none { color: #94a3b8; font-style: italic; }
    .refresh { font-size: 0.78rem; color: #94a3b8; margin-top: 14px; }
    h2 { font-size: 1rem; margin-bottom: 12px; color: #374151; }
  </style>
</head>
<body>
  <h1>🟡 Logam Mulia Stock Scheduler</h1>
  <p class="subtitle">Halaman ini auto-refresh setiap 30 detik</p>

  <div class="cards">
    <div class="card">
      <div class="card-label">Status</div>
      <div class="card-value"><span class="dot"></span>Running</div>
    </div>
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value">${uptime}</div>
    </div>
    <div class="card">
      <div class="card-label">Cek Terakhir</div>
      <div class="card-value" style="font-size:.88rem">${lastCheck}</div>
    </div>
    <div class="card">
      <div class="card-label">Total Cek</div>
      <div class="card-value">${status.checkCount}× <span style="font-size:.75rem;color:#ef4444">(${status.errorCount} error)</span></div>
    </div>
    <div class="card">
      <div class="card-label">Interval</div>
      <div class="card-value">${config.checkIntervalSeconds}s</div>
    </div>
    <div class="card">
      <div class="card-label">Mulai Sejak</div>
      <div class="card-value" style="font-size:.88rem">${startedAt}</div>
    </div>
  </div>

  <div style="margin-bottom:8px;display:flex;gap:16px;flex-wrap:wrap;">
    <span style="font-size:.82rem;color:#64748b">📍 <b>Lokasi:</b> ${locations}</span>
    <span style="font-size:.82rem;color:#64748b">⚖️ <b>Gramasi:</b> ${weights}</span>
  </div>

  <br>
  <h2>📦 Snapshot Stok Terakhir</h2>
  <table>
    <thead>
      <tr><th>Lokasi</th><th>Status</th><th>Gramasi Tersedia</th></tr>
    </thead>
    <tbody>${stockRows}</tbody>
  </table>

  <p class="refresh">⏱ Data snapshot dari: ${snapshot?.[0]?.scrapedAt ? formatDate(new Date(snapshot[0].scrapedAt)) : '-'}</p>
</body>
</html>`;
}

export function startStatusServer(status: BotStatus, config: AppConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      // JSON health endpoint for uptime monitors (e.g. UptimeRobot)
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            uptime: Math.floor((Date.now() - status.startedAt.getTime()) / 1000),
            checkCount: status.checkCount,
            lastCheckAt: status.lastCheckAt?.toISOString() ?? null,
          }),
        );
        return;
      }

      // HTML status page
      const snapshot = await readJson<StockSnapshot>(config.snapshotFile);
      const html = buildHtml(status, config, snapshot);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
      logger.error('[StatusServer] Request error:', err);
    }
  });

  server.listen(config.statusPort, () => {
    logger.info(`[StatusServer] Status page available at http://localhost:${config.statusPort}`);
  });

  return server;
}
