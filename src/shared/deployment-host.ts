/** Hostnames that cannot identify a real public production deployment/inbox. */
export function isReservedDeploymentHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(normalized) ||
    /(?:^|\.)example\.(?:com|org|net|edu)$/.test(normalized)
  );
}
