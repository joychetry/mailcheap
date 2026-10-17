import { NextResponse } from "next/server";
import { POST as checkFirstSend } from "@/app/api/jobs/check-first-send/route";
import { POST as purgeAccount } from "@/app/api/jobs/purge-account/route";
import { POST as sendBatch } from "@/app/api/jobs/send-batch/route";
import { POST as sendScheduled } from "@/app/api/jobs/send-scheduled/route";
import { isLocalQueue, isValidRunnerAuth } from "@/lib/job-rules";
import { runDueJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROUTES = {
	"check-first-send": checkFirstSend,
	"purge-account": purgeAccount,
	"send-batch": sendBatch,
	"send-scheduled": sendScheduled,
};

// The local job queue's runner (lib/job-rules.js): the server's own ticker calls it every few seconds with a token
// derived from BETTER_AUTH_SECRET, and it takes due jobs for 50 seconds, then finishes the one it's on. Nothing at all
// without JOB_QUEUE=local.
export async function POST(request) {
	if (!isLocalQueue()) return NextResponse.json({ error: "Not found" }, { status: 404 });
	if (!isValidRunnerAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const summary = await runDueJobs(ROUTES);
	if (summary.done || summary.retried || summary.failed) console.info(`[jobs] ${JSON.stringify(summary)}`);
	return NextResponse.json(summary);
}
