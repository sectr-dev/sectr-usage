import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { MAX_BODY_BYTES, POSTHOG_URL, parsePing } from "../src/index";

const env = { POSTHOG_KEY: "phc_test" };
const valid = {
  program: "cli",
  version: "0.2.2",
  install_id: "3f0e9c1a-6b1d-4c57-9a52-0d6f1c2b7e88",
};

let forwarded: Request[];
let posthogStatus: number;
let posthogDown: boolean;

beforeEach(() => {
  forwarded = [];
  posthogStatus = 200;
  posthogDown = false;
  vi.stubGlobal("fetch", async (input: Request) => {
    forwarded.push(input);
    if (posthogDown) throw new TypeError("network down");
    return new Response(null, { status: posthogStatus });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Send a request through the Worker and wait for its background work. */
async function send(request: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env, {
    waitUntil: (p) => void pending.push(p),
  });
  await Promise.all(pending);
  return response;
}

function ping(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://telemetry.sectr.dev/v1/ping", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("a valid ping", () => {
  it("is forwarded once, as an event built only from its fields", async () => {
    const response = await send(ping(valid));
    expect(response.status).toBe(204);
    expect(forwarded).toHaveLength(1);
    const [request] = forwarded;
    expect(request.url).toBe(POSTHOG_URL);
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({
      api_key: "phc_test",
      event: "cli_ping",
      distinct_id: valid.install_id,
      properties: {
        version: "0.2.2",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it("names the event after the program", async () => {
    await send(ping({ ...valid, program: "server" }));
    expect(((await forwarded[0].json()) as { event: string }).event).toBe("server_ping");
  });

  it("forwards no header of the sender's", async () => {
    await send(
      ping(valid, {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.7",
        "user-agent": "curl/8.0",
        cookie: "a=b",
      }),
    );
    const [request] = forwarded;
    expect([...request.headers.keys()]).toEqual(["content-type"]);
    expect(await request.text()).not.toContain("203.0.113.7");
  });

  it("is answered 204 when PostHog refuses it", async () => {
    posthogStatus = 500;
    expect((await send(ping(valid))).status).toBe(204);
    expect(forwarded).toHaveLength(1);
  });

  it("is answered 204 when PostHog can't be reached", async () => {
    posthogDown = true;
    expect((await send(ping(valid))).status).toBe(204);
  });

  it("accepts a pre-release or build version", () => {
    for (const version of ["1.0.0-rc.1", "1.0.0+build.5", "10.20.30"]) {
      expect(parsePing(JSON.stringify({ ...valid, version }))).not.toBeNull();
    }
  });
});

describe("anything else", () => {
  const bad: [string, unknown][] = [
    ["an unknown program", { ...valid, program: "worker" }],
    ["a missing program", { version: valid.version, install_id: valid.install_id }],
    ["a version that isn't a version", { ...valid, version: "latest" }],
    ["a version with a long suffix", { ...valid, version: `1.0.0-${"a".repeat(33)}` }],
    ["a version with text after it", { ...valid, version: "1.0.0\nx" }],
    ["a version that isn't a string", { ...valid, version: 1 }],
    ["an install id that isn't a UUID", { ...valid, install_id: "me@example.com" }],
    ["an uppercase install id", { ...valid, install_id: valid.install_id.toUpperCase() }],
    ["an extra field", { ...valid, os: "linux" }],
    ["an array", [valid]],
    ["a string", "cli"],
    ["null", null],
    ["text that isn't JSON", "{not json"],
    ["an empty body", ""],
  ];
  for (const [name, body] of bad) {
    it(`refuses ${name} and forwards nothing`, async () => {
      expect((await send(ping(body))).status).toBe(400);
      expect(forwarded).toHaveLength(0);
    });
  }

  it("refuses a body over the size limit and forwards nothing", async () => {
    // Valid JSON with the three fields, padded past the limit with spaces.
    const body = JSON.stringify(valid) + " ".repeat(MAX_BODY_BYTES);
    expect((await send(ping(body))).status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it("accepts a body at the size limit", async () => {
    const json = JSON.stringify(valid);
    const body = json + " ".repeat(MAX_BODY_BYTES - json.length);
    expect((await send(ping(body))).status).toBe(204);
  });

  it("answers 404 to another method or path", async () => {
    const requests = [
      new Request("https://telemetry.sectr.dev/v1/ping"),
      new Request("https://telemetry.sectr.dev/", { method: "POST", body: JSON.stringify(valid) }),
      new Request("https://telemetry.sectr.dev/v1/ping/", {
        method: "POST",
        body: JSON.stringify(valid),
      }),
      new Request("https://telemetry.sectr.dev/v2/ping", {
        method: "POST",
        body: JSON.stringify(valid),
      }),
    ];
    for (const request of requests) {
      expect((await send(request)).status).toBe(404);
    }
    expect(forwarded).toHaveLength(0);
  });
});
