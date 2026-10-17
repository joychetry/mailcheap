import { createHmac, timingSafeEqual } from "node:crypto";

// The local job queue (JOB_QUEUE=local): QStash's place on a server that runs all the time (Docker, a VPS). The jobs
// QStash would deliver to /api/jobs/<kind> wait in MongoDB instead, and the server's own ticker (lib/job-ticker.js)
// has /api/jobs/run hand each one to that same route when it's due. Vercel keeps QStash: nothing runs between requests.

export const JOB_KINDS = ["send-batch", "send-scheduled", "check-first-send", "purge-account"];
export const JOB_PATH = "/api/jobs/";
// A job still running after this long belongs to a server that stopped mid-job, and runs again.
export const JOB_LOCK_MS = 10 * 60 * 1000;
// Like QStash's retries: a route that throws or doesn't answer 2xx is tried again, with backoff, then the job fails.
export const MAX_JOB_ATTEMPTS = 6;
const RUNNER_TOKEN_LABEL = "mailcheap-job-runner-v1";

export function isLocalQueue(env = process.env) {
	return env.JOB_QUEUE === "local";
}

export function getJobKind(url) {
	const { pathname } = new URL(url);
	const kind = pathname.startsWith(JOB_PATH) ? pathname.slice(JOB_PATH.length) : null;
	if (!JOB_KINDS.includes(kind)) throw new Error(`No job runs at ${pathname}`);
	return kind;
}

// A QStash request (url, body, notBefore in seconds) as a job. flowControl has no equivalent: each server runs one job
// at a time, so several servers sharing the queue can run two of one account's batches at once.
export function toJob({ url, body, notBefore }, now = Date.now()) {
	return { kind: getJobKind(url), payload: body ?? {}, runAt: new Date(notBefore ? notBefore * 1000 : now) };
}

// 30 s, then twice as long each time: 8 min before the last of MAX_JOB_ATTEMPTS tries. The cap only matters if it grows.
export function getRetryDelayMs(attempts) {
	return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60 * 1000);
}

export function getFailureUpdate({ attempts, error, now = Date.now() }) {
	const lastError = String(error?.message || error).slice(0, 500);
	if (attempts >= MAX_JOB_ATTEMPTS) return { status: "failed", finishedAt: new Date(now), lastError };
	return { status: "queued", runAt: new Date(now + getRetryDelayMs(attempts)), lastError };
}

// Due jobs, and jobs whose server stopped while running them.
export function getClaimFilter(now = new Date()) {
	return {
		runAt: { $lte: now },
		$or: [{ status: "queued" }, { status: "running", lockedUntil: { $lt: now } }],
	};
}

// The ticker's credential for /api/jobs/run and the job routes. Derived from BETTER_AUTH_SECRET: nothing to set up.
export function getJobRunnerToken(secret = process.env.BETTER_AUTH_SECRET) {
	if (!secret) return null;
	return createHmac("sha256", secret).update(RUNNER_TOKEN_LABEL).digest("base64url");
}

export function isValidRunnerAuth(header, secret = process.env.BETTER_AUTH_SECRET) {
	const expected = getJobRunnerToken(secret);
	if (!expected || typeof header !== "string") return false;
	const given = Buffer.from(header);
	const wanted = Buffer.from(`Bearer ${expected}`);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
}
