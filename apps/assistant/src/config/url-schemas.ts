import { z } from 'zod';

/**
 * Loopback hostnames (as returned by `new URL(...).hostname`, i.e. IPv6
 * brackets stripped) for which plaintext `http://` is always permitted.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True when `http://` to this host is safe: either a loopback literal or a
 * docker-internal service name. Docker service names are single DNS labels
 * with no dots (e.g. `opsbot`); any dotted hostname is treated as a public
 * (or otherwise routable) host and rejected for plaintext.
 */
function isInternalHttpHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
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
    { message: 'must be https:// (http:// allowed only for docker-internal / loopback host)' },
  );
