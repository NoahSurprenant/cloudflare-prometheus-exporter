// Production runner: serves the bundled Worker straight from Miniflare instead of `wrangler dev`.
//
// `wrangler dev` puts a second workerd process (its ProxyWorker and InspectorProxyWorker) in front
// of the Worker and forwards every request across workers. workerd never reclaims the native
// memory of cross-worker subrequests on Linux (cloudflare/workerd#6894), so that proxy grew by
// ~375 MB a day at one scrape a minute. Here requests reach the Worker without the proxy hop, and
// no inspector is started.
//
// Bindings, Durable Objects and compatibility settings still come from wrangler.jsonc. Persisted
// state keeps wrangler dev's layout (<persist-to>/v3/...), so existing data is picked up as is.
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

// wrangler's own Miniflare, so the runtime always matches the options wrangler builds (the top-level
// miniflare package is a different major, pulled in by the test tooling).
const { Log, LogLevel, Miniflare } = createRequire(
	createRequire(import.meta.url).resolve("wrangler"),
)("miniflare");

// The Worker variables that may come from the environment; Kubernetes' injected service
// variables must not reach the Worker.
const ENV_VARS = [
	"CLOUDFLARE_API_TOKEN",
	"QUERY_LIMIT",
	"SCRAPE_DELAY_SECONDS",
	"TIME_WINDOW_SECONDS",
	"METRIC_REFRESH_INTERVAL_SECONDS",
	"ACCOUNT_LIST_CACHE_TTL_SECONDS",
	"ZONE_LIST_CACHE_TTL_SECONDS",
	"SSL_CERTS_CACHE_TTL_SECONDS",
	"HEALTH_CHECK_CACHE_TTL_SECONDS",
	"LOG_FORMAT",
	"LOG_LEVEL",
	"CF_ACCOUNTS",
	"CF_ZONES",
	"CF_FREE_TIER_ACCOUNTS",
	"METRICS_DENYLIST",
	"EXCLUDE_HOST",
	"CF_HTTP_STATUS_GROUP",
	"COLO_METRICS_PACKED_STORAGE",
	"HOST_METRICS_ALLOWLIST",
	"HOST_METRICS_DELAY_SECONDS",
	"METRICS_PATH",
	"DISABLE_UI",
	"DISABLE_CONFIG_API",
	"BASIC_AUTH_USER",
	"BASIC_AUTH_PASSWORD",
];

const { values: args } = parseArgs({
	options: {
		ip: { type: "string", default: "0.0.0.0" },
		port: { type: "string", default: "8787" },
		"persist-to": { type: "string", default: ".wrangler/state" },
	},
});

const { workerOptions } = unstable_getMiniflareWorkerOptions("wrangler.jsonc");
const fromEnv = Object.fromEntries(
	ENV_VARS.filter((name) => process.env[name] !== undefined).map((name) => [
		name,
		process.env[name],
	]),
);

const mf = new Miniflare({
	...workerOptions,
	name: "cloudflare-prometheus-exporter",
	modules: true,
	scriptPath: "dist/worker.js",
	bindings: { ...workerOptions.bindings, ...fromEnv },
	host: args.ip,
	port: Number(args.port),
	defaultPersistRoot: path.join(args["persist-to"], "v3"),
	log: new Log(LogLevel.INFO),
});

const url = await mf.ready;
console.log(`Ready on ${url}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, async () => {
		await mf.dispose();
		process.exit(0);
	});
}
