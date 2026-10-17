import assert from "node:assert/strict";
import { test } from "node:test";
import {
	JOB_KINDS,
	MAX_JOB_ATTEMPTS,
	getClaimFilter,
	getFailureUpdate,
	getJobKind,
	getJobRunnerToken,
	getRetryDelayMs,
	isLocalQueue,
	isValidRunnerAuth,
	toJob,
} from "../lib/job-rules.js";

const SECRET = "test-secret-for-job-rules-0123456789abcdef";

test("the local queue is on only with JOB_QUEUE=local", () => {
	assert.equal(isLocalQueue({ JOB_QUEUE: "local" }), true);
	assert.equal(isLocalQueue({ JOB_QUEUE: "qstash" }), false);
	assert.equal(isLocalQueue({}), false);
});

test("every route QStash delivers to has a job kind, and a QStash request becomes a job due at its notBefore", () => {
	assert.deepEqual(JOB_KINDS, ["send-batch", "send-scheduled", "check-first-send", "purge-account"]);
	for (const kind of JOB_KINDS) assert.equal(getJobKind(`https://app.example.com/api/jobs/${kind}`), kind);
	assert.throws(() => getJobKind("https://app.example.com/api/jobs/run"), /No job runs at \/api\/jobs\/run/);
	assert.throws(() => getJobKind("https://app.example.com/api/cron/hourly"), /No job runs/);

	const now = Date.UTC(2026, 9, 16, 12);
	const body = { accountId: "64f1a2b3c4d5e6f7a8b9c0d1", messageIds: ["74f1a2b3c4d5e6f7a8b9c0d2"] };
	const flowControl = { key: "account-64f1a2b3c4d5e6f7a8b9c0d1", parallelism: 1 };
	assert.deepEqual(toJob({ url: "https://app.example.com/api/jobs/send-batch", body, flowControl }, now), { kind: "send-batch", payload: body, runAt: new Date(now) });
	const later = toJob({ url: "https://app.example.com/api/jobs/send-scheduled", body: {}, notBefore: now / 1000 + 3600 }, now);
	assert.equal(later.runAt.getTime(), now + 3_600_000);
});

test("retries back off from 30 seconds and stop growing at 30 minutes", () => {
	assert.equal(getRetryDelayMs(1), 30_000);
	assert.equal(getRetryDelayMs(2), 60_000);
	assert.equal(getRetryDelayMs(3), 120_000);
	assert.equal(getRetryDelayMs(20), 30 * 60 * 1000);
});

test("a failed job is tried again later, then marked failed after its last try, with a short error", () => {
	const now = Date.UTC(2026, 9, 16, 12);
	const retry = getFailureUpdate({ attempts: 1, error: new Error("connection reset"), now });
	assert.deepEqual(retry, { status: "queued", runAt: new Date(now + 30_000), lastError: "connection reset" });

	const final = getFailureUpdate({ attempts: MAX_JOB_ATTEMPTS, error: "still down", now });
	assert.deepEqual(final, { status: "failed", finishedAt: new Date(now), lastError: "still down" });
	assert.equal(getFailureUpdate({ attempts: 1, error: new Error("x".repeat(2000)) }).lastError.length, 500);
});

test("claiming takes due queued jobs and running ones whose lock ran out", () => {
	const now = new Date(Date.UTC(2026, 9, 16, 12));
	assert.deepEqual(getClaimFilter(now), {
		runAt: { $lte: now },
		$or: [{ status: "queued" }, { status: "running", lockedUntil: { $lt: now } }],
	});
});

test("only the runner token derived from BETTER_AUTH_SECRET is accepted", () => {
	const token = getJobRunnerToken(SECRET);
	assert.ok(token.length >= 40);
	assert.notEqual(token, SECRET);
	assert.equal(isValidRunnerAuth(`Bearer ${token}`, SECRET), true);
	assert.equal(isValidRunnerAuth(`Bearer ${token}x`, SECRET), false);
	assert.equal(isValidRunnerAuth(token, SECRET), false, "the scheme is part of the header");
	assert.equal(isValidRunnerAuth(`Bearer ${getJobRunnerToken("another-secret-that-is-long-enough-123")}`, SECRET), false);
	assert.equal(isValidRunnerAuth(undefined, SECRET), false);
	assert.equal(isValidRunnerAuth(`Bearer ${token}`, ""), false);
	assert.equal(getJobRunnerToken(""), null);
});
