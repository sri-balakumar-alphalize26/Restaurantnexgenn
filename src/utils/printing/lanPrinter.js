// Direct LAN printing for the "app is the print agent" (online) mode.
//
// Opens a raw TCP connection to a thermal printer (ESC/POS, port 9100 by
// default) and writes the bytes Odoo rendered for us. Used only when the
// Odoo server is online/cloud and therefore cannot reach the shop printers;
// the tablet is on the same LAN as the printers, so it delivers the job.
//
// Requires the native module `react-native-tcp-socket` — so a change here
// only takes effect in a rebuilt APK, not via a JS-only Metro reload.

import { Buffer } from 'buffer';
import { savePrintImage } from './deviceArchive';

const DEFAULT_PORT = 9100;
const DEFAULT_TIMEOUT = 10000;

// Lazy-load the native TCP module. It only exists in a rebuilt APK, so we
// require it on first use (inside try/catch) instead of at import time —
// that way loading this file never crashes an older binary, and local-mode
// KOT (which never prints over TCP) keeps working over Metro before a rebuild.
let _TcpSocket;
let _tcpLoadError = null;
function getTcpSocket() {
  if (_TcpSocket !== undefined) return _TcpSocket;
  try {
    const mod = require('react-native-tcp-socket');
    _TcpSocket = mod && (mod.default || mod);
  } catch (e) {
    _TcpSocket = null;
    _tcpLoadError = (e && e.message) || String(e);
  }
  return _TcpSocket;
}

// Decode the base64 payload returned by Odoo's render_kot into a Buffer.
export function b64ToBytes(b64) {
  return Buffer.from(String(b64 || ''), 'base64');
}

/**
 * Send raw bytes to a network printer over TCP.
 * Never rejects — always resolves to { ok, error? } so callers can aggregate.
 *
 * @param {string} ip
 * @param {number} port
 * @param {Buffer|Uint8Array|number[]} bytes
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function sendBytesToPrinter(ip, port, bytes, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const host = String(ip || '').trim();
  const targetPort = Number(port) || DEFAULT_PORT;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  return new Promise((resolve) => {
    if (!host) {
      resolve({ ok: false, error: 'No printer IP' });
      return;
    }

    let settled = false;
    let client = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { client && client.destroy(); } catch (_) {}
      resolve(result);
    };

    const TcpSocket = getTcpSocket();
    if (!TcpSocket || typeof TcpSocket.createConnection !== 'function') {
      resolve({
        ok: false,
        error:
          'Direct printing needs the rebuilt APK (react-native-tcp-socket not in this build)'
          + (_tcpLoadError ? ` [${_tcpLoadError}]` : ''),
      });
      return;
    }

    timer = setTimeout(
      () => finish({ ok: false, error: `Timeout reaching ${host}:${targetPort}` }),
      timeout,
    );

    try {
      client = TcpSocket.createConnection(
        { host, port: targetPort },
        () => {
          // Connected — write the receipt, then half-close so the printer
          // knows the job is complete.
          client.write(buf, undefined, () => {
            try { client.end(); } catch (_) {}
          });
        },
      );

      // 'close' fires after a clean end(); if an 'error' fired first the
      // settled-guard keeps the failure result.
      client.on('close', () => finish({ ok: true }));
      client.on('error', (err) =>
        finish({ ok: false, error: (err && err.message) || String(err) }),
      );
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

/**
 * Deliver an array of rendered printer jobs (from Odoo render_kot).
 * @param {Array<{printer_ip:string, printer_port:number, data_b64:string}>} jobs
 * @returns {Promise<{success: boolean, message?: string, error?: string, results: Array}>}
 */
export async function deliverRenderedJobs(jobs, label = 'print') {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) {
    return { success: false, error: 'No printer jobs to deliver', results: [] };
  }

  const results = [];
  for (const job of list) {
    const res = await sendBytesToPrinter(
      job.printer_ip,
      job.printer_port,
      b64ToBytes(job.data_b64),
    );
    results.push({ ip: job.printer_ip, port: job.printer_port, ...res });
    // Best-effort: keep a viewable copy on this device (rolling 20). Server
    // doesn't store images for the app path — the printing device owns it.
    if (res.ok && job.png_b64) {
      savePrintImage(job.png_b64, label).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    return {
      success: false,
      error: failed.map((f) => `${f.ip}:${f.port} — ${f.error}`).join('; '),
      results,
    };
  }
  return {
    success: true,
    message: `Printed to ${results.length} printer(s)`,
    results,
  };
}

export default { sendBytesToPrinter, deliverRenderedJobs, b64ToBytes };
