// IPv4 lookup over DNS-over-HTTPS (the Worker only accepts raw public IPv4 targets).

export class DnsError extends Error {
  readonly code: 'invalidHost' | 'http' | 'status' | 'response';
  constructor(code: DnsError['code'], message: string = code) {
    super(message);
    this.name = 'DnsError';
    this.code = code;
  }
}

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const HOSTNAME = /^(?=.{1,253}\.?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A records (type 1) for `host`, deduplicated, in answer order. Empty when the name has none. */
export async function resolveIPv4(host: string): Promise<string[]> {
  if (!HOSTNAME.test(host)) throw new DnsError('invalidHost');
  const url = `${DOH_URL}?name=${encodeURIComponent(host)}&type=A`;
  const response = await fetch(url, { headers: { accept: 'application/dns-json' } });
  if (!response.ok) throw new DnsError('http', `DoH HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DnsError('response', 'DoH response is not JSON');
  }
  if (typeof body !== 'object' || body === null) throw new DnsError('response');
  const { Status, Answer } = body as { Status?: unknown; Answer?: unknown };
  if (Status !== 0) throw new DnsError('status', `DoH status ${String(Status)}`);
  if (!Array.isArray(Answer)) return [];
  const ips: string[] = [];
  for (const record of Answer as unknown[]) {
    const { type, data } = (record ?? {}) as { type?: unknown; data?: unknown };
    if (type === 1 && typeof data === 'string' && IPV4.test(data) && !ips.includes(data)) ips.push(data);
  }
  return ips;
}
