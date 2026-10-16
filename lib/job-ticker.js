import { getJobRunnerToken } from "./job-rules.js";

const TICK_MS = 5000;
const RUN_TIMEOUT_MS = 120_000;
const HOUR_MS = 60 * 60 * 1000;
// What Vercel Cron runs elsewhere, each once per period: at start, then in the first tick of each new one.
const CRONS = [
	{ path: "/api/cron/hourly", periodMs: HOUR_MS },
	{ path: "/api/cron/postmaster", periodMs: 24 * HOUR_MS },
];

// Started once per server process by instrumentation.js with JOB_QUEUE=local. Each tick asks this same server to run
// the due jobs, so they run as a request, with everything a request has. Ticks never overlap, and several servers can
// tick at once: claiming a job is atomic. With CRON_SECRET set, the crons run from here too, on every server.
export function startJobTicker({ port = process.env.PORT || 3000 } = {}) {
	if (globalThis.__mailcheapJobTicker) return;
	const base = `http://127.0.0.1:${port}`;
	const lastSlots = new Map();
	let isRunning = false;

	async function call(path, { method, token }) {
		try {
			const response = await fetch(`${base}${path}`, {
				method,
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
			});
			if (!response.ok) console.warn(`[jobs] ${path} answered ${response.status}`);
			return true;
		} catch (error) {
			// The first ticks can come before the server listens; anything else is worth a line.
			if (error?.cause?.code !== "ECONNREFUSED") console.warn(`[jobs] ${path} failed: ${error?.message || error}`);
			return false;
		}
	}

	async function tick() {
		if (isRunning) return;
		isRunning = true;
		try {
			await call("/api/jobs/run", { method: "POST", token: getJobRunnerToken() });
			const cronSecret = process.env.CRON_SECRET;
			for (const { path, periodMs } of cronSecret ? CRONS : []) {
				const slot = Math.floor(Date.now() / periodMs);
				if (lastSlots.get(path) === slot) continue;
				if (await call(path, { method: "GET", token: cronSecret })) lastSlots.set(path, slot);
			}
		} finally {
			isRunning = false;
		}
	}

	globalThis.__mailcheapJobTicker = setInterval(tick, TICK_MS);
	globalThis.__mailcheapJobTicker.unref?.();
}
