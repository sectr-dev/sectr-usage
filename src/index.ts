// The collector for Sectr's anonymous usage pings.
//
// The `sectr` CLI and self-hosted `sectr-server` send one small JSON body here
// at most once a day. This Worker checks it and passes it on to PostHog as an
// event. It forwards only the fields it has checked: the request to PostHog is
// built from scratch, so nothing else about the sender (IP address, headers,
// location) goes with it. Nothing is logged (see wrangler.jsonc).

export interface Env {
  /** The PostHog project token. A Worker secret: `wrangler secret put POSTHOG_KEY`. */
  POSTHOG_KEY: string;
}

/** The part of `ExecutionContext` this Worker uses. */
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Ping {
  program: "cli" | "server";
  version: string;
  install_id: string;
}

export const POSTHOG_URL = "https://us.i.posthog.com/i/v0/e/";
export const MAX_BODY_BYTES = 512;

const VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]{1,32})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The request body as text, or null once it passes `MAX_BODY_BYTES`. */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A ping, if `text` is JSON with exactly the three fields, each valid. */
export function parsePing(text: string): Ping | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { program, version, install_id } = body as Record<string, unknown>;
  if (Object.keys(body).length !== 3) return null;
  if (program !== "cli" && program !== "server") return null;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (typeof install_id !== "string" || !UUID.test(install_id)) return null;
  return { program, version, install_id };
}

/** The request to PostHog: built only from the checked fields. */
export function posthogRequest(ping: Ping, key: string): Request {
  return new Request(POSTHOG_URL, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      api_key: key,
      event: `${ping.program}_ping`,
      distinct_id: ping.install_id,
      properties: {
        version: ping.version,
        // No person profile for the install id, and no location lookup.
        $process_person_profile: false,
        $geoip_disable: true,
      },
    }),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/v1/ping") {
      return new Response(null, { status: 404 });
    }
    const text = await readBody(request);
    const ping = text === null ? null : parsePing(text);
    if (!ping) return new Response(null, { status: 400 });
    // The sender gets its answer without waiting for PostHog, and the same
    // answer whatever PostHog says: a ping is never retried the same day.
    ctx.waitUntil(fetch(posthogRequest(ping, env.POSTHOG_KEY)).catch(() => undefined));
    return new Response(null, { status: 204 });
  },
};
