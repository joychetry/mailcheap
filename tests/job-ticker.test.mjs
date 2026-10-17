import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { startJobTicker } from "../lib/job-ticker.js";

const CRON_SECRET = "cron-secret-for-the-ticker-test";

test("every tick runs the due jobs, each cron runs once a period, and a cron that failed runs again next tick", async (t) => {
	const previous = process.env.CRON_SECRET;
	process.env.CRON_SECRET = CRON_SECRET;
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.UTC(2026, 9, 17, 10, 0, 1) });
	t.mock.method(console, "warn", () => {});
	const calls = [];
	const failing = new Set();
	t.mock.method(globalThis, "fetch", async (url, { method, headers }) => {
		const { pathname } = new URL(url);
		calls.push(`${method} ${pathname}`);
		if (pathname.startsWith("/api/cron/")) assert.equal(headers.authorization, `Bearer ${CRON_SECRET}`);
		if (failing.has(pathname)) throw new Error("socket hang up");
		return new Response("{}");
	});
	const tick = async (ms = 5000) => {
		calls.length = 0;
		mock.timers.tick(ms);
		await new Promise((resolve) => setImmediate(resolve));
		return [...calls];
	};

	try {
		startJobTicker({ port: 3999 });
		failing.add("/api/cron/hourly");
		assert.deepEqual(await tick(), ["POST /api/jobs/run", "GET /api/cron/hourly", "GET /api/cron/postmaster"]);
		failing.clear();
		assert.deepEqual(await tick(), ["POST /api/jobs/run", "GET /api/cron/hourly"], "the hourly cron failed: again");
		assert.deepEqual(await tick(), ["POST /api/jobs/run"], "both ran this period");
		assert.deepEqual(await tick(60 * 60 * 1000), ["POST /api/jobs/run", "GET /api/cron/hourly"], "a new hour, the same day");
		assert.deepEqual(await tick(24 * 60 * 60 * 1000), ["POST /api/jobs/run", "GET /api/cron/hourly", "GET /api/cron/postmaster"]);
	} finally {
		clearInterval(globalThis.__mailcheapJobTicker);
		delete globalThis.__mailcheapJobTicker;
		mock.timers.reset();
		if (previous === undefined) delete process.env.CRON_SECRET;
		else process.env.CRON_SECRET = previous;
	}
});
