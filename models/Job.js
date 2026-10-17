import mongoose from "mongoose";
import { JOB_KINDS } from "../lib/job-rules.js";

// The local job queue (JOB_QUEUE=local, lib/job-rules.js). The server's own: no account scope, a job's payload names
// its account the way a QStash job's body does.
const jobSchema = new mongoose.Schema(
	{
		kind: { type: String, enum: JOB_KINDS, required: true },
		payload: { type: mongoose.Schema.Types.Mixed, default: {} },
		runAt: { type: Date, required: true, default: Date.now },
		status: { type: String, enum: ["queued", "running", "done", "failed"], default: "queued" },
		attempts: { type: Number, default: 0 },
		lockedUntil: { type: Date },
		lastError: { type: String },
		finishedAt: { type: Date },
	},
	{ timestamps: true, minimize: false }
);

jobSchema.index({ status: 1, runAt: 1 });
// Finished jobs stay a month for troubleshooting, then MongoDB deletes them.
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.models.Job || mongoose.model("Job", jobSchema);
