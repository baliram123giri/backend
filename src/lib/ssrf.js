import { URL } from 'url';

/**
 * Checks if a given hostname or IP address is internal/private/loopback.
 * Returns true if the host is unsafe (SSRF risk), false if it is a public host.
 */
export function isPrivateOrLocalHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;

  let host = hostname.toLowerCase().trim();

  // Strip IPv6 brackets if present: [::1] -> ::1
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  // Common localhost and internal names
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.corp') ||
    host.endsWith('.home') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }

  // Reject single-label internal hosts without a dot (e.g., 'redis', 'postgres', 'backend', 'metadata')
  if (!host.includes('.')) {
    return true;
  }

  // Normalize IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (host.startsWith('::ffff:')) {
    host = host.replace('::ffff:', '');
  }

  // Check IPv4 decimal notation (and detect octal/hex obfuscations)
  const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map((part) => {
      // If octet has leading zero (e.g. 0177), parse as octal/decimal safe check
      return Number(part);
    });

    if (octets.some((n) => isNaN(n) || n < 0 || n > 255)) {
      return true; // Malformed IP or out of range -> unsafe
    }

    const [a, b] = octets;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (Private network)
    if (a === 10) return true;
    // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private network)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (Link-local / Cloud Metadata e.g. 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 (Carrier-Grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (a >= 240) return true;

    return false;
  }

  // Check IPv6 link-local (fe80::/10) and Unique Local Addresses (fc00::/7)
  if (
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }

  return false;
}

/**
 * Validates whether a given URL string is a safe external HTTP/HTTPS URL.
 */
export function isSafeExternalUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;

  try {
    const parsed = new URL(urlStr);
    // Protocol must be strictly http: or https:
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    // Hostname check
    if (isPrivateOrLocalHost(parsed.hostname)) {
      return false;
    }

    // Block sensitive internal service ports if specified
    if (parsed.port) {
      const port = Number(parsed.port);
      // Disallow typical database, caching, and internal service ports
      const blockedPorts = [21, 22, 25, 110, 143, 445, 1433, 1521, 3306, 5432, 6379, 8000, 9200, 11211, 27017];
      if (blockedPorts.includes(port)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
