import { describe, expect, it, vi } from "vitest";
import { MetricExporter } from "./MetricExporter";

describe("retired MetricExporter", () => {
	it("clears its alarm and storage when a leftover alarm fires", async () => {
		const storage = {
			deleteAlarm: vi.fn(async () => {}),
			deleteAll: vi.fn(async () => {}),
		};
		// SAFETY: The retired object only touches these two storage operations.
		const exporter = new MetricExporter(
			{ storage } as unknown as DurableObjectState,
			{} as Env,
		);

		await exporter.alarm();

		expect(storage.deleteAlarm).toHaveBeenCalledOnce();
		expect(storage.deleteAll).toHaveBeenCalledOnce();
	});
});
