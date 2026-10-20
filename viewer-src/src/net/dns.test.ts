import { afterEach, expect, test, vi } from 'vitest';
import { DnsError, resolveIPv4 } from './dns';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

test('queries Cloudflare DoH for A records with the JSON accept header', async () => {
  const fetchMock = stubFetch(200, {
    Status: 0,
    Answer: [
      { name: 'functions3.ultraviewer.net', type: 5, data: 'alias.example.' },
      { name: 'alias.example', type: 1, data: '146.59.55.107' },
      { name: 'alias.example', type: 1, data: '51.75.0.1' },
      { name: 'alias.example', type: 1, data: '146.59.55.107' },
    ],
  });
  await expect(resolveIPv4('functions3.ultraviewer.net')).resolves.toEqual(['146.59.55.107', '51.75.0.1']);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://cloudflare-dns.com/dns-query?name=functions3.ultraviewer.net&type=A');
  expect(new Headers(init.headers).get('accept')).toBe('application/dns-json');
});

test('drops A records that are not dotted IPv4', async () => {
  stubFetch(200, { Status: 0, Answer: [{ type: 1, data: '1.2.3' }, { type: 1, data: '999.1.1.1' }, { type: 1, data: 7 }] });
  await expect(resolveIPv4('x.example')).resolves.toEqual([]);
});

test('no Answer => empty list', async () => {
  stubFetch(200, { Status: 0 });
  await expect(resolveIPv4('x.example')).resolves.toEqual([]);
});

test('NXDOMAIN => DnsError(status)', async () => {
  stubFetch(200, { Status: 3 });
  await expect(resolveIPv4('nope.example')).rejects.toMatchObject({ name: 'DnsError', code: 'status' });
});

test('HTTP failure => DnsError(http)', async () => {
  stubFetch(503, {});
  await expect(resolveIPv4('x.example')).rejects.toBeInstanceOf(DnsError);
  await expect(resolveIPv4('x.example')).rejects.toMatchObject({ code: 'http' });
});

test('rejects an invalid host before any request', async () => {
  const fetchMock = stubFetch(200, { Status: 0 });
  await expect(resolveIPv4('a b&type=AAAA')).rejects.toMatchObject({ code: 'invalidHost' });
  expect(fetchMock).not.toHaveBeenCalled();
});
