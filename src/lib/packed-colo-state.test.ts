import { describe, expect, it } from "vitest";
import { PackedColoMetricStateSchema } from "./packed-colo-state";

describe("PackedColoMetricStateSchema", () => {
	it("rejects zones whose columns are misaligned", () => {
		const zone = {
			zone: "example.com",
			colo: ["SJC"],
			host: [],
			visits: [1],
			edgeResponseBytes: [1],
			requests: [1],
			misses: [5],
			lastIngest: [1],
		};
		const state = {
			format: "colo-packed-by-zone-v2",
			accountId: "a",
			accountName: "A",
			queryName: "colo-metrics",
			lastFetch: 1,
			lastIngest: 1,
			zones: [zone],
		};
		expect(PackedColoMetricStateSchema.safeParse(state).success).toBe(false);
		expect(
			PackedColoMetricStateSchema.safeParse({
				...state,
				zones: [{ ...zone, host: ["www.example.com"] }],
			}).success,
		).toBe(true);
	});
});
