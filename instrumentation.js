import { getConfigProblems } from "./lib/config.js";

// Runs once when a server starts, before it takes requests. Builds skip it, so they need no secrets.
export function register() {
	const problems = getConfigProblems();
	if (problems.length > 0) throw new Error(`MailCheap can't start. ${problems.join(" ")}`);

	// The local job queue in QStash's place, on a server that runs all the time (lib/job-rules.js). Not awaited, so
	// register() stays synchronous and a bad config still throws above.
	if (process.env.NEXT_RUNTIME === "nodejs" && process.env.JOB_QUEUE === "local") {
		import("./lib/job-ticker.js").then(({ startJobTicker }) => startJobTicker());
	}
}
