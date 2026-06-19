// Save a viewable copy of each printed document (KOT / receipt / invoice) on
// THIS device, when the app is the one printing (online mode). Keeps only the
// newest MAX_KEEP images — oldest removed first (rolling buffer), mirroring the
// server-side archive. The server does NOT store images for the app path; the
// printing device owns the copy.

import * as FileSystem from 'expo-file-system';

const DIR = (FileSystem.documentDirectory || '') + 'print_archive/';
const MAX_KEEP = 20;

async function ensureDir() {
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  } catch (_) {}
}

async function pruneOld() {
  try {
    const files = (await FileSystem.readDirectoryAsync(DIR)).filter((f) => f.endsWith('.png'));
    if (files.length <= MAX_KEEP) return;
    files.sort(); // names start with a numeric timestamp → ascending = oldest first
    for (const f of files.slice(0, files.length - MAX_KEEP)) {
      try { await FileSystem.deleteAsync(DIR + f, { idempotent: true }); } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Save a base64 PNG to the device archive (best-effort, never throws).
 * @param {string} pngB64
 * @param {string} label  e.g. 'kot' | 'receipt' | 'invoice'
 */
export async function savePrintImage(pngB64, label = 'print') {
  if (!pngB64) return;
  try {
    await ensureDir();
    const safe = String(label).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'print';
    const path = `${DIR}${Date.now()}_${safe}.png`;
    await FileSystem.writeAsStringAsync(path, pngB64, { encoding: FileSystem.EncodingType.Base64 });
    await pruneOld();
  } catch (e) {
    console.log('[deviceArchive] save failed:', e && e.message);
  }
}

export function archiveDir() {
  return DIR;
}

export default { savePrintImage, archiveDir };
