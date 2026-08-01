/**
 * Browser push endpoints are public HTTPS origins. Reject literal IPs,
 * credentials, nonstandard ports, and local/single-label names at the wire
 * boundary; the transport independently verifies DNS results immediately
 * before egress to prevent rebinding into a private network.
 */
export function normalizePushEndpointUrl(value: string): string | null {
  // URL.hash cannot distinguish no fragment delimiter from an empty `#`.
  // Push requests never transmit fragments, so reject either form explicitly.
  if (value.includes('#')) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
    return null;
  if (parsed.port && parsed.port !== '443') return null;

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname)) {
    return null;
  }
  if (!hostname.includes('.')) return null;
  if (/(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname)) return null;

  // Collapse a trailing empty `?`; URL.search reports it as empty even though
  // href otherwise preserves the delimiter and creates a duplicate DB identity.
  if (parsed.search === '') parsed.search = '';

  // URL.href canonicalizes host casing, an explicit default port, dot segments,
  // and percent-encoding. The database identity must match the exact request the
  // sender makes, or syntactic aliases consume slots and receive duplicates.
  return parsed.href;
}

export function isSafePushEndpointUrl(value: string): boolean {
  return normalizePushEndpointUrl(value) !== null;
}
