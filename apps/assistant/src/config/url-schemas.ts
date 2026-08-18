import { z } from 'zod';

/**
 * Loopback hostnames (as returned by `new URL(...).hostname`, i.e. IPv6
 * brackets stripped) for which plaintext `http://` is always permitted.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True for an address in 100.64.0.0/10 — the CGNAT range the Tailscale mesh
 * uses. AGENT-0210: services moved between hosts (Ops Bot arcana-prod ->
 * arcana-agents) are reached over the mesh, which is a private network no more
 * public than the docker bridge. The range is second-octet 64..127 inclusive;
 * a naive `startsWith('100.')` would also match public 100.0.0.0/10 space.
 */
function isMeshAddress(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * True when `http://` to this host is safe: a loopback literal, a mesh address,
 * or a docker-internal service name. Docker service names are single DNS labels
 * with no dots (e.g. `opsbot`); any other dotted hostname is treated as a public
 * (or otherwise routable) host and rejected for plaintext.
 */
function isInternalHttpHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (isMeshAddress(hostname)) return true;
  return hostname.length > 0 && !hostname.includes('.');
}

/**
 * URL schema that requires `https://` for any public host but allows plaintext
 * `http://` ONLY to docker-internal service names (no dot) or loopback
 * literals. Fail-closed: an unparseable URL or a non-http(s) protocol rejects.
 *
 * Rationale (ARCA-0154): the proactive briefing reaches OpsBot `/metrics` over
 * the internal docker network (`http://opsbot:3600`), which the public
 * `https://ops.arcanada.one` endpoint blocks with 403. The relaxed scheme must
 * not weaken the no-plaintext-to-public-host guarantee — only carve out the
 * container-to-container path.
 */
export const internalHttpOrHttpsUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      if (url.protocol === 'https:') return true;
      if (url.protocol === 'http:') return isInternalHttpHost(url.hostname);
      return false;
    },
    {
      message: 'must be https:// (http:// allowed only for docker-internal / loopback / mesh host)',
    },
  );
