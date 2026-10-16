import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage, ClientRequest } from "node:http";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4],
];
function inV4Range(ip: string, network: string, bits: number): boolean {
  const toInt = (value: string) => value.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(network) & mask);
}
export function isPublicProviderAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !IPV4_BLOCKED.some(([network,bits]) => inV4Range(ip,network,bits));
  if (family !== 6) return false;
  const v = ip.toLowerCase().split("%", 1)[0]!;
  if (v.startsWith("::ffff:")) return false;
  // Require global-unicast 2000::/3; exclude protocol assignments, documentation,
  // benchmarking and transition ranges from the IANA special-purpose registries.
  if (!/^2[0-9a-f]{3}:/.test(v)) return false;
  const [first, second = "0"] = v.split(":");
  const secondValue = Number.parseInt(second, 16);
  return !(first === "2001" && (secondValue <= 0x1ff || secondValue === 0xdb8)) && first !== "2002" && first !== "3fff";
}

export interface PublicProviderHttpOptions {
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest;
  timeoutMs?: number;
}
export function createPinnedPublicProviderFetch(options: PublicProviderHttpOptions = {}): typeof fetch {
  const resolve = options.resolve ?? (async host => dnsLookup(host, { all: true, verbatim: true }));
  const requestImpl = options.request ?? httpsRequest;
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443") throw new TypeError("provider_url_invalid");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("provider_timeout")), options.timeoutMs ?? 60_000);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    try {
    const records = await new Promise<Array<{ address: string; family: number }>>((accept, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: Array<{ address: string; family: number }>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        if (error) reject(error); else accept(value!);
      };
      const aborted = () => finish(signal.reason ?? new Error("aborted"));
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => resolve(url.hostname)).then(value => finish(undefined, value), error => finish(error));
    });
    if (!records.length || records.some(record => !isPublicProviderAddress(record.address))) throw new TypeError("provider_address_not_public");
    const selected = records[0]!;
    const body = typeof init.body === "string" ? init.body : "";
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw new TypeError("request_too_large");
    if ((init.method ?? "POST") !== "POST") throw new TypeError("method_invalid");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const headers = new Headers(init.headers);
    if ([...headers.keys()].some(name => !["authorization", "content-type", "accept"].includes(name.toLowerCase()))) throw new TypeError("headers_invalid");
    const response = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolveResponse, reject) => {
      let request: ClientRequest;
      const requestOptions: RequestOptions = {
        protocol: "https:", hostname: url.hostname, port: 443, method: init.method ?? "POST", path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers.entries()), servername: url.hostname, rejectUnauthorized: true,
        lookup: ((_host: string, opts: { all?: boolean }, callback: (...args: any[]) => void) => opts?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family)) as RequestOptions["lookup"],
      };
      const onAbort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      try {
        request = requestImpl(requestOptions, (res: IncomingMessage) => {
          const chunks: Buffer[] = []; let size = 0;
          const contentLength = Number(res.headers["content-length"]);
          if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) { request.destroy(new Error("response_too_large")); return; }
          res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) request.destroy(new Error("response_too_large")); else chunks.push(Buffer.from(chunk)); });
          res.on("error", reject);
          res.on("end", () => resolveResponse({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        });
      } catch (error) { reject(error); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      request.setTimeout(options.timeoutMs ?? 60_000, () => request.destroy(new Error("provider_timeout")));
      request.on("error", reject);
      request.on("close", () => signal?.removeEventListener("abort", onAbort));
      request.end(body);
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
    const responseBody = [204, 205, 304].includes(response.status) ? null : new Uint8Array(response.body);
    return new Response(responseBody, { status: response.status, headers: responseHeaders });
    } finally { clearTimeout(timer); }
  };
}
