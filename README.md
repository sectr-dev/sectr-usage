# sectr-usage

The collector for [Sectr](https://github.com/sectr-dev/sectr)'s anonymous usage
pings. It's a Cloudflare Worker at `telemetry.sectr.dev`, and this repo is all
of its code, so you can read exactly what happens to a ping.

The `sectr` CLI and self-hosted `sectr-server` send a ping at most once a day.
[Usage pings](https://docs.sectr.dev/reference/telemetry/) in the Sectr docs
says what they send and how to turn them off.

## What it accepts

`POST /v1/ping` with a JSON body of at most 512 bytes that has exactly these
three fields:

```json
{
  "program": "cli",
  "version": "0.2.2",
  "install_id": "3f0e9c1a-6b1d-4c57-9a52-0d6f1c2b7e88"
}
```

| Field | Allowed values |
| -- | -- |
| `program` | `cli` or `server` |
| `version` | a version number such as `0.2.2` or `1.0.0-rc.1` |
| `install_id` | a lowercase UUID |

A valid ping gets a `204`. A body with a missing, extra or invalid field gets a
`400`, and nothing is forwarded. Any other path or method gets a `404`.

## What it forwards

One event to PostHog, built from the three checked fields and nothing else:

```json
{
  "api_key": "<the PostHog project token>",
  "event": "cli_ping",
  "distinct_id": "3f0e9c1a-6b1d-4c57-9a52-0d6f1c2b7e88",
  "properties": {
    "version": "0.2.2",
    "$process_person_profile": false,
    "$geoip_disable": true
  }
}
```

The event is `cli_ping` or `server_ping`. `$process_person_profile: false` tells
PostHog not to create a person profile for the install id, and
`$geoip_disable: true` tells it not to look up a location.

## What it drops

Everything else about the request, including the sender's IP address:

- The request to PostHog is a new one. It has one header, `content-type`, and
  none of the sender's headers. PostHog sees a request from Cloudflare.
- The Worker reads nothing from the request but its method, path and body. It
  never reads the IP address or Cloudflare's location data.
- The Worker logs nothing. Logs are turned off in `wrangler.jsonc`, so
  Cloudflare keeps no request logs for it.
- The PostHog project has "Discard client IP data" turned on as well.

`test/index.test.ts` checks each of these that code can check.

## Run the tests

```sh
npm ci
npm test
```

## Deploy

The Worker's config declares no route. The `telemetry.sectr.dev` route and DNS
record are managed elsewhere, and the route names this Worker, so deploy the
Worker before creating the route.

```sh
npx wrangler deploy
npx wrangler secret put POSTHOG_KEY
```

To run your own collector, deploy this Worker to your own Cloudflare account
with your own PostHog project token, and point Sectr at it with
`SECTR_TELEMETRY_URL`.

## License

Apache-2.0. See [LICENSE](LICENSE).
