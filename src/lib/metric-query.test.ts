import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChunkedValueStorage } from "./chunked-storage";
import { createLogger } from "./logger";
import {
	MetricQuery,
	type MetricQueryContext,
	nextRefreshTime,
} from "./metric-query";
import { getEnvDefaults, type ResolvedConfig } from "./runtime-config";
import type { MetricExporterIdString, TimeRange } from "./types";

class MemoryStorage implements ChunkedValueStorage {
	readonly values = new Map<string, unknown>();
	getFailures = 0;

	async get(key: string): Promise<unknown> {
		return this.values.get(key);
	}

	async getMany(keys: string[]): Promise<Map<string, unknown>> {
		if (this.getFailures > 0) {
			this.getFailures--;
			throw new Error("state storage unavailable");
		}
		const result = new Map<string, unknown>();
		for (const key of keys) {
			if (this.values.has(key)) result.set(key, this.values.get(key));
		}
		return result;
	}

	async putMany(entries: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) {
			this.values.set(key, structuredClone(value));
		}
	}

	async deleteMany(keys: string[]): Promise<void> {
		for (const key of keys) this.values.delete(key);
	}
}

const zone = {
	id: "zone-id",
	name: "example.com",
	status: "active",
	plan: { id: "paid", name: "Paid" },
	account: { id: "account-id", name: "Account" },
};

function zonesFor(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		...zone,
		id: index === 0 ? zone.id : `zone-${index}`,
		name: index === 0 ? zone.name : `zone-${index}.example.com`,
	}));
}

function context(zones = [zone]): MetricQueryContext {
	return {
		accountId: "account-id",
		accountName: "Account",
		zones,
		firewallRules: {},
	};
}

function minuteRange(minute: number): TimeRange {
	return {
		mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
		maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
	};
}

function createEnv(overrides: Record<string, unknown> = {}): Env {
	const env = {
		LOG_FORMAT: "json",
		LOG_LEVEL: "error",
		CLOUDFLARE_API_TOKEN: "token",
		CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
		// A fresh limiter per query: the client singleton is cached per limiter.
		CF_API_RATE_LIMITER: {
			limit: vi.fn().mockResolvedValue({ success: true }),
		},
		...overrides,
	};
	// SAFETY: Only the bindings above are read by MetricQuery and the client.
	return env as unknown as Env;
}

function configFor(
	env: Env,
	overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
	return { ...getEnvDefaults(env), ...overrides };
}

async function createQuery(
	id: MetricExporterIdString,
	storage: ChunkedValueStorage = new MemoryStorage(),
	env: Env = createEnv(),
): Promise<MetricQuery> {
	const query = new MetricQuery(id, storage, env);
	await query.load();
	return query;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});
}

const logger = createLogger("test", { level: "error" });

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("MetricQuery state", () => {
	it("retries a transient load instead of starting over empty", async () => {
		const storage = new MemoryStorage();
		const env = createEnv();
		const seed = await createQuery(
			"account:account-id:worker-totals",
			storage,
			env,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockResolvedValue(
				jsonResponse({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{
											dimensions: { scriptName: "worker" },
											sum: { requests: 42, errors: 0 },
											quantiles: null,
										},
									],
								},
							],
						},
					},
				}),
			),
		);
		await seed.refresh(context(), minuteRange(1), configFor(env), logger);

		storage.getFailures = 1;
		const query = new MetricQuery(
			"account:account-id:worker-totals",
			storage,
			env,
		);
		await expect(query.load()).rejects.toThrow("state storage unavailable");
		expect(() => query.export()).toThrow("State not loaded");
		await query.load();

		expect(query.export()).toEqual(seed.export());
		expect(query.export()).not.toEqual([]);
	});

	it("is due immediately when new and at the next interval boundary after a refresh", async () => {
		const env = createEnv();
		const config = configFor(env);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockResolvedValue(
				jsonResponse({
					data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } },
				}),
			),
		);
		const query = await createQuery(
			"account:account-id:worker-totals",
			new MemoryStorage(),
			env,
		);
		expect(query.isDue()).toBe(true);

		await query.refresh(context(), minuteRange(1), config, logger);

		expect(query.isDue()).toBe(false);
		expect(query.nextRefresh).toBeGreaterThan(Date.now());
		expect(query.nextRefresh).toBe(nextRefreshTime(config));
	});

	it("does not double-count when the same window is refreshed twice", async () => {
		const env = createEnv();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
				jsonResponse({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{
											dimensions: { scriptName: "worker" },
											sum: { requests: 42, errors: 0 },
											quantiles: null,
										},
									],
								},
							],
						},
					},
				}),
			),
		);
		const query = await createQuery(
			"account:account-id:worker-totals",
			new MemoryStorage(),
			env,
		);

		await query.refresh(context(), minuteRange(1), configFor(env), logger);
		await query.refresh(context(), minuteRange(1), configFor(env), logger);

		const requests = query
			.export()
			.find((metric) => metric.name === "cloudflare_worker_requests_total");
		expect(requests?.values[0]?.value).toBe(42);
	});
});

describe("MetricQuery refresh", () => {
	it("backs off only a denied zone chunk while refreshing successful chunks", async () => {
		const env = createEnv();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					errors: [
						{
							message: "zone does not have access to the path",
							extensions: { code: "FORBIDDEN" },
						},
					],
				}),
			)
			.mockImplementation(async () =>
				jsonResponse({ data: { viewer: { zones: [] } } }),
			);
		vi.stubGlobal("fetch", fetch);
		const query = await createQuery(
			"account:account-id:adaptive-metrics",
			new MemoryStorage(),
			env,
		);
		const ctx = context(zonesFor(11));

		await query.refresh(ctx, minuteRange(1), configFor(env), logger);
		await query.refresh(ctx, minuteRange(2), configFor(env), logger);

		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("delays the next refresh of a product without access", async () => {
		const env = createEnv();
		const config = configFor(env);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
				jsonResponse({
					errors: [
						{
							message: "zone does not have access to the path",
							extensions: { code: "FORBIDDEN" },
						},
					],
				}),
			),
		);
		const query = await createQuery(
			"account:account-id:adaptive-metrics",
			new MemoryStorage(),
			env,
		);

		await query.refresh(context(), minuteRange(1), config, logger);

		expect(query.nextRefresh).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
	});

	it("skips account queries until zones are known", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		const env = createEnv();
		const query = await createQuery(
			"account:account-id:http-metrics",
			new MemoryStorage(),
			env,
		);

		await query.refresh(context([]), minuteRange(1), configFor(env), logger);

		expect(fetch).not.toHaveBeenCalled();
		expect(query.isDue()).toBe(false);
	});

	it("caches zone-scoped SSL certificates for their TTL", async () => {
		const certExpiry = "2027-01-03T20:34:46.000Z";
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async () =>
				jsonResponse({
					success: true,
					errors: [],
					messages: [],
					result: [
						{
							id: "pack-id",
							type: "universal",
							status: "active",
							primary_certificate: "cert-id",
							hosts: ["example.com", "*.example.com"],
							certificates: [
								{
									id: "cert-id",
									issuer: "GoogleTrustServices",
									status: "active",
									expires_on: certExpiry,
								},
							],
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetch);
		const env = createEnv();
		const query = await createQuery(
			"zone:zone-id:ssl-certificates",
			new MemoryStorage(),
			env,
		);

		await query.refresh(context(), minuteRange(1), configFor(env), logger);
		await query.refresh(context(), minuteRange(2), configFor(env), logger);

		expect(fetch).toHaveBeenCalledOnce();
		expect(query.export()[0]?.values[0]?.value).toBe(
			new Date(certExpiry).getTime() / 1000,
		);
	});

	it("skips a zone query whose zone left the account", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		const env = createEnv();
		const query = await createQuery(
			"zone:other-zone:ssl-certificates",
			new MemoryStorage(),
			env,
		);

		await query.refresh(context(), minuteRange(1), configFor(env), logger);

		expect(fetch).not.toHaveBeenCalled();
		expect(query.export()).toEqual([]);
	});
});

// Exercise real refresh, storage codecs, and GraphQL translation; only the
// storage and upstream HTTP response are replaced by local fixtures.
async function createColoHarness(zoneCount = 1) {
	const storage = new MemoryStorage();
	const zones = zonesFor(zoneCount);
	let packed = false;
	let observations = [
		{ host: "www.example.com", visits: 10, requests: 10, bytes: 10 },
	];
	const queries: string[] = [];
	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		const body = String(init?.body);
		queries.push(body);
		const requested = new Set<string>(
			z
				.object({ variables: z.object({ zoneIDs: z.array(z.string()) }) })
				.parse(JSON.parse(body)).variables.zoneIDs,
		);
		return jsonResponse({
			data: {
				viewer: {
					zones: zones
						.filter((zone) => requested.has(zone.id))
						.map((zone) => ({
							zoneTag: zone.id,
							httpRequestsAdaptiveGroups: observations.map((row) => ({
								dimensions: {
									coloCode: "SJC",
									clientRequestHTTPHost: row.host,
								},
								count: row.requests,
								sum: { visits: row.visits, edgeResponseBytes: row.bytes },
							})),
						})),
				},
			},
		});
	});
	const env = createEnv();
	const id = "account:account-id:colo-metrics";
	let query = await createQuery(id, storage, env);
	return {
		storage,
		queries,
		get query() {
			return query;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async restart() {
			query = await createQuery(id, storage, env);
		},
		async refresh(minute: number) {
			await query.refresh(
				context(zones),
				minuteRange(minute),
				configFor(env, { coloMetricsPackedStorage: packed }),
				logger,
			);
		},
		async requests() {
			const packed = await query.exportPackedColoMetrics();
			return packed?.zones[0]?.requests;
		},
	};
}

describe("MetricQuery packed colo storage", () => {
	it("accumulates packed counters across refreshes and restarts without double-counting retries", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		await h.refresh(2);
		await h.restart();
		await h.refresh(2);
		expect(await h.requests()).toEqual([20]);
		expect(
			h.queries.every((query) => query.includes("ColoMetricsPackedStorage")),
		).toBe(true);
	});

	it("expires packed counters absent for five refreshes, aging once per window", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		h.setObservations([]);
		await h.refresh(2);
		await h.refresh(2);
		expect((await h.query.exportPackedColoMetrics())?.zones[0]?.misses).toEqual(
			[4],
		);
		for (let minute = 3; minute <= 6; minute++) await h.refresh(minute);
		expect((await h.query.exportPackedColoMetrics())?.zones).toEqual([]);
	});

	it("round-trips 150,000 packed rows (450,000 samples) within the storage guard", async () => {
		const h = await createColoHarness(15);
		h.setPacked(true);
		h.setObservations(
			Array.from({ length: 10_000 }, (_, index) => ({
				host: `host-${index}.example.com`,
				visits: 10,
				requests: 10,
				bytes: 10,
			})),
		);
		await h.refresh(1);
		await h.restart();
		expect(
			h.storage.values.get("query:account:account-id:colo-metrics"),
		).toMatchObject({ lastError: null });
		const snapshot = await h.query.exportPackedColoMetrics();
		expect(
			snapshot?.zones.reduce((total, zone) => total + zone.colo.length, 0),
		).toBe(150_000);
		const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
		expect(bytes).toBeLessThan(16 * 1024 * 1024);
		expect(
			h.storage.values.get(
				"query:account:account-id:colo-metrics:packed-colo-metrics:manifest",
			),
		).toMatchObject({ bytes });
	}, 15_000);

	it("starts a fresh packed generation after the flag was disabled", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		expect(await h.requests()).toEqual([10]);
		h.setPacked(false);
		await h.refresh(2);
		expect(await h.query.exportPackedColoMetrics()).toBeUndefined();
		expect(
			[...h.storage.values.keys()].filter((key) =>
				key.includes("packed-colo-metrics"),
			),
		).toEqual([]);
		h.setPacked(true);
		await h.refresh(3);
		expect(await h.requests()).toEqual([10]);
	});

	it("returns no packed state for other queries", async () => {
		const query = await createQuery("account:account-id:http-metrics");
		expect(await query.exportPackedColoMetrics()).toBeUndefined();
	});
});
