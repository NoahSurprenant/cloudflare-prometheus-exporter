import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "../lib/metrics";
import type {
	PackedColoMetricState,
	PackedColoZone,
} from "../lib/packed-colo-state";
import { serializeToPrometheus } from "../lib/prometheus";
import { MetricCoordinator } from "./MetricCoordinator";

const requestsName = "cloudflare_zone_colocation_requests_total";

type Row = { host: string; value: number; misses?: number };

function packedState(rows: Row[]): PackedColoMetricState {
	const zone: PackedColoZone = {
		zone: "example.com",
		colo: rows.map(() => "SJC"),
		host: rows.map((row) => row.host),
		visits: rows.map((row) => row.value),
		edgeResponseBytes: rows.map((row) => row.value),
		requests: rows.map((row) => row.value),
		misses: rows.map((row) => row.misses ?? 5),
		lastIngest: rows.map(() => 1),
	};
	return {
		format: "colo-packed-by-zone-v2",
		accountId: "account-a",
		accountName: "Account",
		queryName: "colo-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [zone],
	};
}

function expectedMetrics(state: PackedColoMetricState): MetricDefinition[] {
	return (
		[
			["cloudflare_zone_colocation_visits_total", "Visits per colo", "visits"],
			[
				"cloudflare_zone_colocation_edge_response_bytes_total",
				"Edge response bytes per colo",
				"edgeResponseBytes",
			],
			[requestsName, "Requests per colo", "requests"],
		] as const
	).map(([name, help, column]) => ({
		name,
		help,
		type: "counter" as const,
		values: state.zones.flatMap((zone) =>
			zone.colo.map((colo, i) => ({
				labels: { zone: zone.zone, colo, host: zone.host[i] ?? "" },
				value: zone[column][i] ?? 0,
			})),
		),
	}));
}

async function createCoordinator(
	packed: PackedColoMetricState[],
	legacy: MetricDefinition[] = [],
	overrides: {
		excludeHost?: boolean;
		metricsDenylist?: string;
		coloMetricsPackedStorage?: boolean;
	} = {},
) {
	let ready = Promise.resolve();
	const ctx = {
		storage: {
			get: async () => ({
				identifier: "metric-coordinator",
				lastAccountFetch: Date.now(),
				accounts: [
					{ id: "account-a", name: "A" },
					{ id: "account-b", name: "B" },
				],
			}),
		},
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_LEVEL: "error",
		LOG_FORMAT: "json",
		CONFIG_KV: {
			get: async () =>
				JSON.stringify({ coloMetricsPackedStorage: true, ...overrides }),
		},
		AccountMetricCoordinator: {
			getByName: (id: string) => ({
				initialize: async () => {},
				// Mirrors AccountMetricCoordinator: the caller's mode decides which
				// representation colo metrics use for this scrape.
				exportForPrometheus: async (options: {
					packedColoStorage: boolean;
				}) => ({
					metrics:
						id === "account:account-a" || options.packedColoStorage
							? []
							: legacy,
					packedColoMetrics:
						id === "account:account-a" && options.packedColoStorage
							? packed
							: [],
					zoneCounts: {
						total: 1,
						filtered: 1,
						processed: 1,
						skippedFreeTier: 0,
					},
				}),
			}),
		},
	};
	// SAFETY: The runtime shim uses only these storage/config/RPC operations. Worker
	// platform types also require native bindings unavailable in this Node harness.
	const coordinator = new MetricCoordinator(
		ctx as unknown as DurableObjectState,
		env as unknown as Env,
	);
	await ready;
	return coordinator;
}

function coloOutput(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("cloudflare_zone_colocation_"))
		.sort();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MetricCoordinator packed colo output", () => {
	it.each([
		false,
		true,
	])("matches legacy serialization including escaping and excludeHost=%s", async (excludeHost) => {
		const state = packedState([
			{ host: 'www.\\\\"\nexample.com', value: 10 },
			{ host: "other.example.com", value: 20 },
		]);
		const coordinator = await createCoordinator([state], [], {
			excludeHost,
			metricsDenylist: requestsName,
		});
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(response.status).toBe(200);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(
				serializeToPrometheus(expectedMetrics(state), {
					excludeLabels: excludeHost ? new Set(["host"]) : undefined,
					denylist: new Set([requestsName]),
				}),
			),
		);
	});

	it("matches numeric formatting for NaN and infinities", async () => {
		const state = packedState(
			[0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
				(value, index) => ({ host: `host-${index}.example.com`, value }),
			),
		);
		const coordinator = await createCoordinator([state]);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(serializeToPrometheus(expectedMetrics(state))),
		);
	});

	it("does not serialize the whole packed snapshot before a slow reader consumes it", async () => {
		let visitsRead = 0;
		const rows = Array.from({ length: 5000 }, (_, index) => ({
			host: `host-${index}.example.com`,
			value: 10,
		}));
		const state = packedState(rows);
		const zone = state.zones[0];
		if (zone === undefined) throw new Error("fixture has no zone");
		zone.visits = new Proxy(zone.visits, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property))
					visitsRead++;
				return Reflect.get(target, property, receiver);
			},
		});
		const coordinator = await createCoordinator([state]);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(visitsRead).toBeLessThan(rows.length);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader?.read();
		expect(first?.value?.byteLength).toBeLessThan(66 * 1024);
		await reader?.cancel();
		const readsAtCancel = visitsRead;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(visitsRead).toBe(readsAtCancel);
	});

	it("passes one storage mode to every account so HELP/TYPE appear once", async () => {
		const legacy = expectedMetrics(
			packedState([{ host: "b.example.com", value: 1 }]),
		);
		for (const coloMetricsPackedStorage of [true, false]) {
			const coordinator = await createCoordinator(
				[packedState([{ host: "a.example.com", value: 1 }])],
				legacy,
				{ coloMetricsPackedStorage },
			);
			const text = await (
				await coordinator.fetch(new Request("https://test/export"))
			).text();
			expect(
				text.match(/^# HELP cloudflare_zone_colocation_requests_total/gm),
			).toHaveLength(1);
			expect(
				text.match(/^# TYPE cloudflare_zone_colocation_requests_total/gm),
			).toHaveLength(1);
		}
	});
});
