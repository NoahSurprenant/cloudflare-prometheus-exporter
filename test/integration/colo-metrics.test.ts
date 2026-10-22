/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";
import type { AccountMetricCoordinator } from "../../src/durable-objects/AccountMetricCoordinator";
import {
	chunkedDurableObjectStorage,
	loadChunkedValue,
} from "../../src/lib/chunked-storage";
import { getEnvDefaults } from "../../src/lib/runtime-config";
import { COLO_METRIC_SCENARIOS, type ColoMetricScenario } from "./scenarios";

const network = setupNetwork();

const COLO_QUERY = /query ColoMetrics(PackedStorage)?\(/;

function createColoGroups(scenario: ColoMetricScenario) {
	const { colosPerZone, hostsPerColo, trafficPerHost } = scenario.scale;
	return Array.from({ length: colosPerZone }, (_, coloIndex) =>
		Array.from({ length: hostsPerColo }, (_, hostIndex) => ({
			dimensions: {
				coloCode: `COLO-${coloIndex}`,
				clientRequestHTTPHost: `host-${coloIndex}-${hostIndex}.example.com`,
			},
			count: trafficPerHost.requests,
			sum: {
				visits: trafficPerHost.visits,
				edgeResponseBytes: trafficPerHost.responseBytes,
			},
		})),
	).flat();
}

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("colo-metrics in AccountMetricCoordinator", () => {
	it.each(COLO_METRIC_SCENARIOS)("$path $name", async (scenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) => ({
			id: `${accountId}-zone-${index}`,
			name: `${accountId}-zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		}));
		const groups = createColoGroups(scenario);
		let graphQLRequests = 0;
		network.use(
			http.post(CLOUDFLARE_GQL_URL, async ({ request }) => {
				const body = z
					.object({
						query: z.string(),
						variables: z.object({ zoneIDs: z.array(z.string()).optional() }),
					})
					.parse(await request.json());
				// Every other query of the account gets an empty answer.
				if (!COLO_QUERY.test(body.query)) {
					return HttpResponse.json({
						data: { viewer: { zones: [], accounts: [] } },
					});
				}
				graphQLRequests++;
				const requestedZones = new Set(body.variables.zoneIDs);
				return HttpResponse.json({
					data: {
						viewer: {
							zones: zones
								.filter((zone) => requestedZones.has(zone.id))
								.map((zone) => ({
									zoneTag: zone.id,
									httpRequestsAdaptiveGroups: groups,
								})),
						},
					},
				});
			}),
			// Zone-scoped REST queries (SSL certificates, load balancers).
			http.all("https://api.cloudflare.com/client/v4/*", () =>
				HttpResponse.json({
					success: true,
					errors: [],
					messages: [],
					result: [],
				}),
			),
		);

		const stub = env.AccountMetricCoordinator.getByName(`account:${accountId}`);
		// Seed a cached zone list so the refresh runs only metric queries.
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("state", {
				accountId,
				accountName: accountId,
				zones,
				totalZoneCount: zones.length,
				firewallRules: {},
				lastZoneFetch: Date.now(),
				lastRefresh: 0,
			});
		});
		await evictDurableObject(stub);

		const packedColoStorage = getEnvDefaults(env).coloMetricsPackedStorage;
		const options = { accountId, accountName: accountId, packedColoStorage };
		await stub.exportForPrometheus(options);

		const lastError = await runInDurableObject(
			stub,
			async (_instance: AccountMetricCoordinator, state) => {
				const stored = await loadChunkedValue(
					chunkedDurableObjectStorage(state.storage),
					`query:account:${accountId}:colo-metrics`,
					z.object({ lastError: z.string().nullable() }),
				);
				return stored?.lastError;
			},
		);
		expect(lastError).toBeNull();
		expect(graphQLRequests).toBe(Math.ceil(scenario.scale.zones / 10));

		await evictDurableObject(stub);
		const result = await stub.exportForPrometheus(options);
		// The scrape after eviction serves stored results without refetching.
		expect(graphQLRequests).toBe(Math.ceil(scenario.scale.zones / 10));

		const expectedRecords =
			scenario.scale.zones *
			scenario.scale.colosPerZone *
			scenario.scale.hostsPerColo;
		const { trafficPerHost } = scenario.scale;
		if (!packedColoStorage) {
			const requests = result.metrics.find(
				(metric) => metric.name === "cloudflare_zone_colocation_requests_total",
			);
			expect(requests?.values).toHaveLength(expectedRecords);
			expect(
				requests?.values.every(
					(value) => value.value === trafficPerHost.requests,
				),
			).toBe(true);
			return;
		}

		const snapshot = result.packedColoMetrics[0];
		expect(
			snapshot?.zones.reduce((total, zone) => total + zone.colo.length, 0),
		).toBe(expectedRecords);
		for (const zone of snapshot?.zones ?? []) {
			expect(
				zone.visits.every((value) => value === trafficPerHost.visits),
			).toBe(true);
			expect(
				zone.edgeResponseBytes.every(
					(value) => value === trafficPerHost.responseBytes,
				),
			).toBe(true);
			expect(
				zone.requests.every((value) => value === trafficPerHost.requests),
			).toBe(true);
		}
	});
});
