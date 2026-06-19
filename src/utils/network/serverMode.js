// Decide whether the configured Odoo server is on the LOCAL network or ONLINE.
//
//   LOCAL  (private LAN IP / localhost / *.local)  → Odoo can reach the printers
//          itself, so it prints directly. The app just calls print_kot.
//   ONLINE (public domain / public IP)             → Odoo (cloud) cannot reach the
//          shop's printers. The app becomes the print agent: it asks Odoo to
//          render the KOT bytes (render_kot) and delivers them to the printers
//          over the LAN itself.
//
// Detection is purely by the server URL host (RFC1918 private ranges).

export function isPrivateHost(host) {
  if (!host) return true; // safest default: treat as local (server prints)
  const h = String(host).trim().toLowerCase();

  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.endsWith('.local')) return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16 (link-local)
    if (a === 127) return true;                      // loopback
    return false;                                    // any other literal IP → public
  }

  // A hostname / domain (e.g. pos.shop.com) → treat as online.
  return false;
}

export function hostFromUrl(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .replace(/^[a-z]+:\/\//i, '') // strip scheme
    .split('/')[0]                // strip path
    .split('@').pop()             // strip credentials
    .split(':')[0]                // strip port
    .toLowerCase();
}

// true  → local server (Odoo prints directly)
// false → online server (app prints directly to the printers)
export function isLocalServerUrl(url) {
  return isPrivateHost(hostFromUrl(url));
}

export default isLocalServerUrl;
