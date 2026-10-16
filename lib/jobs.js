import "server-only";
import { sendAlert } from "@/lib/alerts";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { JOB_LOCK_MS, JOB_PATH, MAX_JOB_ATTEMPTS, getClaimFilter, getFailureUpdate, getJobRunnerToken, toJob } from "@/lib/job-rules";
import Job from "@/models/Job";

const INSERT_CHUNK_SIZE = 500;
// QStash alerts on a job's third failed try (lib/qstash-route.js); so does the local queue.
const ALERT_AFTER_ATTEMPTS = 3;

// QStash's requests (lib/sending.js publishJob), kept in MongoDB until they're due.
export async function enqueueJobs(requests) {
	if (requests.length === 0) return;
	await connectDb();
	const jobs = requests.map((request) => toJob(request));
	for (let start = 0; start < jobs.length; start += INSERT_CHUNK_SIZE) await Job.insertMany(jobs.slice(start, start + INSERT_CHUNK_SIZE));
}

function claimNextJob() {
	const now = new Date();
	return Job.findOneAndUpdate(
		getClaimFilter(now),
		{ $set: { status: "running", lockedUntil: new Date(now.getTime() + JOB_LOCK_MS) }, $inc: { attempts: 1 } },
		{ sort: { runAt: 1, _id: 1 }, returnDocument: "after" }
	).lean();
}

// The job as the POST QStash would have made, to the route's own handler, so it runs exactly as it does there.
async function runJob(job, routes) {
	const path = `${JOB_PATH}${job.kind}`;
	const request = new Request(`${getAppUrl()}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${getJobRunnerToken()}` },
		body: JSON.stringify(job.payload ?? {}),
	});
	const response = await routes[job.kind](request);
	if (!response.ok) throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function recordFailure(job, error) {
	const update = getFailureUpdate({ attempts: job.attempts, error });
	console.error(`[jobs] ${job.kind} ${job._id}, try ${job.attempts} of ${MAX_JOB_ATTEMPTS}: ${update.lastError}`);
	await Job.updateOne({ _id: job._id, status: "running" }, { $set: update, $unset: { lockedUntil: 1 } });
	if (job.attempts < ALERT_AFTER_ATTEMPTS) return update.status;
	await sendAlert({
		accountId: null,
		key: `job-failing:${JOB_PATH}${job.kind}`,
		title: "Background job failing",
		detail: `${JOB_PATH}${job.kind} failed ${job.attempts} times in a row: ${update.lastError}.`,
		action: `It's tried up to ${MAX_JOB_ATTEMPTS} times, then stays failed in the jobs collection (job ${job._id}): check the logs.`,
	});
	return update.status;
}

// One job at a time, oldest first: a campaign's batches go out in order, each at the send rate. Stops when nothing
// is due or the time's up. routes: each kind's route handler (app/api/jobs/run/route.js).
export async function runDueJobs(routes, { budgetMs = 50_000 } = {}) {
	await connectDb();
	const deadline = Date.now() + budgetMs;
	const summary = { done: 0, retried: 0, failed: 0 };
	while (Date.now() < deadline) {
		const job = await claimNextJob();
		if (!job) break;
		try {
			await runJob(job, routes);
			await Job.updateOne({ _id: job._id, status: "running" }, { $set: { status: "done", finishedAt: new Date() }, $unset: { lockedUntil: 1 } });
			summary.done++;
		} catch (error) {
			const status = await recordFailure(job, error);
			summary[status === "failed" ? "failed" : "retried"]++;
		}
	}
	return summary;
}
