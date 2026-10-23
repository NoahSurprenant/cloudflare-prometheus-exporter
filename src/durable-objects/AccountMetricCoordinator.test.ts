import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMetricCoordinator } from "./AccountMetricCoordinator";

const DAY_MS = 24 * 60 * 60 * 1000;

class FakeStorage {
	alarm: number | null = null;
	readonly setAlarm = vi.fn(async (scheduledTime: number) => {
		this.alarm = scheduledTime;
	});
	readonly getAlarm = vi.fn(async () => this.alarm);
	readonly values = new Map<string, unknown>();

	async get(keyOrKeys: string | string[]): Promise<unknown> {
		if (typeof keyOrKeys === "string") return this.values.get(keyOrKeys);
		const result = new Map<string, unknown>();
		for (const key of keyOrKeys) {
			if (this.values.has(key)) result.set(key, this.values.get(key));
		}
		return result;
	}

	async put(
		keyOrEntries: string | Record<string, unknown>,
		value?: unknown,
	): Promise<void> {
		const entries =
			typeof keyOrEntries === "string"
				? { [keyOrEntries]: value }
				: keyOrEntries;
		for (const [key, entry] of Object.entries(entries)) {
			this.values.set(key, structuredClone(entry));
		}
	}

	async delete(keys: string[]): Promise<void> {
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

function coordinatorState(overrides: Record<string, unknown> = {}) {
	return {
		accountId: "account-id",
		accountName: "Account",
		zones: [zone],
		totalZoneCount: 1,
		firewallRules: {},
		lastZoneFetch: Date.now(),
		lastRefresh: Date.now() - 10_000,
		...overrides,
	};
}

function workerTotalsResponse(requests = 42): Response {
	return new Response(
		JSON.stringify({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [
								{
									dimensions: { scriptName: "worker" },
									sum: { requests, errors: 0 },
									quantiles: null,
								},
							],
						},
					],
				},
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

const exportOptions = {
	accountId: "account-id",
	accountName: "Account",
	packedColoStorage: false,
};

/**
 * Builds a coordinator for a free tier account, which limits it to the
 * account-level GraphQL queries so every refresh is answered by one fixture.
 */
async function harness(
	state: Record<string, unknown> | undefined,
	respond: () => Response | Promise<Response> = workerTotalsResponse,
	kv: { get: () => Promise<string | null> } = {
		get: vi.fn().mockResolvedValue(null),
	},
) {
	const storage = new FakeStorage();
	if (state !== undefined) storage.values.set("state", state);
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockImplementation(async () => respond());
	vi.stubGlobal("fetch", fetch);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	let ready = Promise.resolve();
	const ctx = {
		storage,
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_FORMAT: "json",
		LOG_LEVEL: "error",
		CLOUDFLARE_API_TOKEN: "token",
		CF_FREE_TIER_ACCOUNTS: "account-id",
		CONFIG_KV: kv,
		// A fresh limiter per test: the client singleton is cached per limiter.
		CF_API_RATE_LIMITER: {
			limit: vi.fn().mockResolvedValue({ success: true }),
		},
	};
	// SAFETY: The test shim provides only the storage and bindings the
	// coordinator, its queries and the API client use.
	const coordinator = new AccountMetricCoordinator(
		ctx as unknown as DurableObjectState,
		env as unknown as Env,
	);
	await ready;
	return { storage, fetch, coordinator };
}

function workerRequests(
	result: Awaited<ReturnType<AccountMetricCoordinator["exportForPrometheus"]>>,
): number | undefined {
	return result.metrics.find(
		(metric) => metric.name === "cloudflare_worker_requests_total",
	)?.values[0]?.value;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("AccountMetricCoordinator export", () => {
	it("initializes itself on the first export and runs every query in-process", async () => {
		const h = await harness(undefined);
		const exported = h.coordinator.exportForPrometheus(exportOptions);
		await expect(exported).resolves.toBeDefined();

		expect(h.storage.values.get("state")).toMatchObject({
			accountId: "account-id",
			accountName: "Account",
		});
		expect(h.storage.alarm).toBeGreaterThan(Date.now());
	});

	it("serves cached query results without calling the API", async () => {
		const h = await harness(coordinatorState({ lastRefresh: 0 }));
		h.storage.alarm = Date.now() + 30_000;

		const first = await h.coordinator.exportForPrometheus(exportOptions);
		const calls = h.fetch.mock.calls.length;
		const second = await h.coordinator.exportForPrometheus(exportOptions);

		expect(calls).toBeGreaterThan(0);
		expect(h.fetch).toHaveBeenCalledTimes(calls);
		expect(workerRequests(first)).toBe(42);
		expect(workerRequests(second)).toBe(42);
	});

	it("refreshes only queries that are due", async () => {
		const h = await harness(coordinatorState({ lastRefresh: 0 }));
		await h.coordinator.exportForPrometheus(exportOptions);
		const firstCycle = h.fetch.mock.calls.length;

		await h.coordinator.alarm();

		expect(h.fetch).toHaveBeenCalledTimes(firstCycle);
	});

	it("does not double-count when the platform retries a failed alarm", async () => {
		const h = await harness(coordinatorState({ lastRefresh: 0 }));
		h.storage.setAlarm
			.mockRejectedValueOnce(new Error("ordinary alarm scheduling failed"))
			.mockRejectedValueOnce(new Error("recovery alarm scheduling failed"));

		await expect(h.coordinator.alarm()).rejects.toThrow(
			"recovery alarm scheduling failed",
		);
		await h.coordinator.alarm();

		const result = await h.coordinator.exportForPrometheus(exportOptions);
		expect(workerRequests(result)).toBe(42);
	});

	it("schedules a recovery alarm when the refresh cannot start", async () => {
		const h = await harness(coordinatorState(), workerTotalsResponse, {
			get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
		});

		await expect(h.coordinator.alarm()).resolves.toBeUndefined();

		expect(h.storage.setAlarm).toHaveBeenCalledOnce();
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it("ignores an alarm before the first export", async () => {
		const h = await harness(undefined);

		await h.coordinator.alarm();

		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.storage.setAlarm).not.toHaveBeenCalled();
	});
});

describe("AccountMetricCoordinator lost-alarm recovery", () => {
	it("refreshes on scrape when the last refresh is stale", async () => {
		const h = await harness(
			coordinatorState({ lastRefresh: Date.now() - 27 * DAY_MS }),
		);
		h.storage.alarm = Date.now() - 27 * DAY_MS;

		await h.coordinator.exportForPrometheus(exportOptions);

		expect(h.fetch).toHaveBeenCalled();
		expect(h.storage.alarm).toBeGreaterThan(Date.now());
	});

	it("refreshes when the alarm is missing and the last refresh is over an interval old", async () => {
		const h = await harness(
			coordinatorState({ lastRefresh: Date.now() - 90_000 }),
		);
		h.storage.alarm = null;

		await h.coordinator.exportForPrometheus(exportOptions);

		expect(h.fetch).toHaveBeenCalled();
		expect(h.storage.alarm).toBeGreaterThan(Date.now());
	});

	it("leaves a scheduled or briefly late alarm alone", async () => {
		const h = await harness(coordinatorState());

		for (const alarm of [Date.now() + 30_000, Date.now() - 90_000]) {
			h.storage.alarm = alarm;
			await h.coordinator.exportForPrometheus(exportOptions);
		}

		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.storage.setAlarm).not.toHaveBeenCalled();
	});

	it("only reschedules when the last refresh is under one interval old", async () => {
		const h = await harness(coordinatorState());
		h.storage.alarm = null;

		await h.coordinator.exportForPrometheus(exportOptions);

		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.storage.setAlarm).toHaveBeenCalledOnce();
		expect(h.storage.alarm).toBeGreaterThan(Date.now());
	});

	it("does not report a lost alarm while the alarm handler is running", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await harness(
			coordinatorState({ lastRefresh: Date.now() - 90_000 }),
			async () => {
				await gate;
				return workerTotalsResponse();
			},
		);
		// The platform clears the alarm while its handler runs.
		h.storage.alarm = null;
		const log = vi.mocked(console.log);

		const alarm = h.coordinator.alarm();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await h.coordinator.exportForPrometheus(exportOptions);
		release();
		await alarm;

		expect(
			log.mock.calls.some((call) =>
				String(call[0]).includes("Refresh alarm lost"),
			),
		).toBe(false);
		expect(h.storage.alarm).toBeGreaterThan(Date.now());
	});

	it("shares one refresh between a scrape and the alarm", async () => {
		const baseline = await harness(coordinatorState({ lastRefresh: 0 }));
		await baseline.coordinator.alarm();
		const oneCycle = baseline.fetch.mock.calls.length;
		vi.unstubAllGlobals();

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await harness(coordinatorState({ lastRefresh: 0 }), async () => {
			await gate;
			return workerTotalsResponse();
		});

		const scrape = () => h.coordinator.exportForPrometheus(exportOptions);
		const calls = [scrape(), scrape(), h.coordinator.alarm()];
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();
		await Promise.all(calls);

		expect(oneCycle).toBeGreaterThan(0);
		expect(h.fetch).toHaveBeenCalledTimes(oneCycle);
		expect(h.storage.alarm).toBeGreaterThan(Date.now());
	});
});
