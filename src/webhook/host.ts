/**
 * Resolve the local IP address advertised to gitea as the webhook target.
 *
 * If `override` is a non-empty trimmed string, that is returned verbatim.
 * Otherwise we walk `os.networkInterfaces()` and pick the first IPv4 that is
 * not internal (loopback) and does not start with `127.`. As a last resort we
 * return `'127.0.0.1'` — the caller will see webhook deliveries fail and the
 * user can override via the `superpowers.webhookHost` setting.
 */

import { networkInterfaces } from 'node:os'

export function detectLocalHost(override?: string): string {
  if (typeof override === 'string') {
    const trimmed = override.trim()
    if (trimmed.length > 0)
      return trimmed
  }

  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    if (!list)
      continue
    for (const iface of list) {
      if (iface.family !== 'IPv4')
        continue
      if (iface.internal)
        continue
      if (iface.address.startsWith('127.'))
        continue
      return iface.address
    }
  }
  return '127.0.0.1'
}
