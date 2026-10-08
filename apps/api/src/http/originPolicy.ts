import { BlockList, isIP } from 'node:net';
import type { ApiConfig } from '../config.js';

export type OriginPolicy = Pick<ApiConfig, 'webOrigin' | 'publicUrl' | 'allowPrivateOrigins'>;

// Include local/link-local access and VPN CGNAT addresses alongside RFC 1918 and IPv6 ULA.
const PRIVATE_IPV4_SUBNETS = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
] as const;
const PRIVATE_IPV6_SUBNETS = [
  ['fc00::', 7],
  ['fe80::', 10],
] as const;

function createPrivateAddressList(): BlockList {
  const addresses = new BlockList();
  for (const [address, prefix] of PRIVATE_IPV4_SUBNETS)
    addresses.addSubnet(address, prefix, 'ipv4');
  for (const [address, prefix] of PRIVATE_IPV6_SUBNETS)
    addresses.addSubnet(address, prefix, 'ipv6');
  addresses.addAddress('::1', 'ipv6');
  return addresses;
}

const privateAddresses = createPrivateAddressList();

export function isAllowedOrigin(origin: string | undefined, policy: OriginPolicy): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Browser Origin headers contain only scheme/host/port, never credentials or a resource path.
  if (!['http:', 'https:'].includes(url.protocol) || origin !== url.origin) return false;
  if ([policy.webOrigin, policy.publicUrl].includes(origin)) return true;
  if (!policy.allowPrivateOrigins) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  // Classify IP literals without DNS: a hostname may resolve differently on a later request.
  const family = isIP(hostname);
  if (family === 0) return false;
  return privateAddresses.check(hostname, family === 4 ? 'ipv4' : 'ipv6');
}
