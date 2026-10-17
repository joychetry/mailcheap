import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, callApi, catchRedirect, form, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { failNextSend, sentMail, transports } from "./stubs/nodemailer.mjs";
import { published } from "./stubs/qstash.mjs";
import { clients as s3Clients, objects as s3Objects } from "./stubs/s3.mjs";

// A server on Docker: SMTP in SES's place, the local job queue in QStash's, and an S3-compatible bucket with no CDN.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const DOMAIN = "self-hosted.example.com";

let app;
let m;

before(async () => {
	app = await startTestApp({
		MAILCHEAP_CLOUD: "",
		STRIPE_SECRET_KEY: "",
		STRIPE_WEBHOOK_SECRET: "",
		SHARED_DOMAIN: "",
		ARCHIVE_CNAME_TARGET: "",
		ALLOWED_EMAILS: "@team.example.org",
		EMAIL_FROM: "MailCheap <login@self-hosted.example.com>",
		QSTASH_TOKEN: "",
		JOB_QUEUE: "local",
		SMTP_HOST: "mail.example.com",
		SMTP_USER: "mailcheap",
		SMTP_PASSWORD: "smtp-password",
		SMTP_DOMAINS: `${DOMAIN.toUpperCase()}, other.example.org, scheduled.example.com`,
		BLOB_READ_WRITE_TOKEN: "",
		IMAGES_S3_BUCKET: "mailcheap",
		IMAGES_S3_ENDPOINT: "http://garage.internal:3900",
		IMAGES_S3_ACCESS_KEY_ID: "garage-key-id",
		IMAGES_S3_SECRET_ACCESS_KEY: "garage-secret",
	});
	m = {
		config: await import("../lib/config.js"),
		domains: await import("../lib/domains.js"),
		domainRecords: await import("../lib/domain-records.js"),
		smtp: (await import("../lib/email-provider/smtp.js")).smtpProvider,
		sendingRules: await import("../lib/sending-rules.js"),
		jobRules: await import("../lib/job-rules.js"),
		signin: await import("../app/signin/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		runRoute: await import("../app/api/jobs/run/route.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		mediaRoute: await import("../app/media/[...key]/route.js"),
		Account: (await import("../models/Account.js")).default,
		Alert: (await import("../models/Alert.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Job: (await import("../models/Job.js")).default,
		Message: (await import("../models/Message.js")).default,
	};
});

after(() => app?.stop());

function runnerRequest(path, { token = m.jobRules.getJobRunnerToken(), body } = {}) {
	return new Request(`http://localhost:3000${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
		...(body && { body: JSON.stringify(body) }),
	});
}

// What the ticker does every few seconds.
async function runJobs() {
	const response = await m.runRoute.POST(runnerRequest("/api/jobs/run"));
	assert.equal(response.status, 200);
	return response.json();
}

async function addDomain(user, domain) {
	const account = await m.Account.findById(user.accountId).lean();
	return m.domains.addDomain({ account, domain });
}

async function createSend(user, slug, domain = DOMAIN) {
	await addDomain(user, domain);
	const settings = { name: "Notes", slug, fromName: "Jo", fromEmail: `${slug}@${domain}`, postalAddress: "1 Main St, Paris" };
	const newsletterId = (await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form(settings))))).split("/").at(-1);
	const rows = ["a", "b", "c"].map((name) => ({ email: `${name}-${slug}@readers.example.org`, status: "active" }));
	await as(user, () => m.contacts.importContacts({ newsletterId, consent: true, rows }));
	const id = (await as(user, () => catchRedirect(m.campaigns.createCampaign(newsletterId)))).split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

describe("SMTP", () => {
	test("it's the provider once SMTP_HOST is set, unless PostShiba's key is or EMAIL_PROVIDER says otherwise", () => {
		const { getEmailProviderId, getSmtpDomains } = m.config;
		assert.equal(getEmailProviderId({ SMTP_HOST: "mail.example.com" }), "smtp");
		assert.equal(getEmailProviderId({ SMTP_HOST: "  " }), "ses");
		assert.equal(getEmailProviderId({ EMAIL_PROVIDER: "smtp" }), "smtp");
		assert.equal(getEmailProviderId({ SMTP_HOST: "mail.example.com", EMAIL_PROVIDER: "ses" }), "ses");
		assert.equal(getEmailProviderId({ SMTP_HOST: "mail.example.com", POSTSHIBA_API_KEY: "ps_key" }), "postshiba");
		assert.deepEqual(getSmtpDomains({ SMTP_DOMAINS: " Example.com, mail.example.org ,,example.com " }), ["example.com", "mail.example.org"]);
		assert.deepEqual(getSmtpDomains({}), []);
	});

	test("a domain in SMTP_DOMAINS is verified, without a DKIM status MailCheap never checked; another isn't", async () => {
		const user = await signIn("domains@team.example.org");
		const listed = await addDomain(user, "other.example.org");
		const unlisted = await addDomain(user, "unlisted.example.org");
		assert.equal(listed.verified, true);
		assert.equal(unlisted.verified, false);
		assert.equal(listed.dkimStatus, "NOT_STARTED");

		const steps = m.domainRecords.getDomainSetup(listed, { cnameTarget: null });
		assert.deepEqual(steps.map(({ key }) => key), ["smtp", "dmarc"]);
		assert.deepEqual(steps[0].status, { label: "In SMTP_DOMAINS", tone: "good" });
		assert.deepEqual(m.domainRecords.getDomainSummary(listed, { cnameTarget: null }), { label: "Ready", tone: "good" });
		assert.deepEqual(m.domainRecords.getDomainSummary(unlisted, { cnameTarget: null }), { label: "Not in SMTP_DOMAINS", tone: "bad" });
	});

	test("sign-in codes go out over SMTP without Resend, before sending is on", async () => {
		const before = sentMail.length;
		await withEnv({ RESEND_API_KEY: "", SENDING_ENABLED: "false" }, () =>
			as({ jar: new Map(), ip: "198.51.100.200" }, () => m.signin.sendSigninCode(null, form({ email: "smtp-code@team.example.org" })))
		);
		const [mail] = sentMail.slice(before);
		assert.equal(mail.to, "smtp-code@team.example.org");
		assert.equal(mail.from, "MailCheap <login@self-hosted.example.com>");
		assert.match(mail.subject, /^\d{6} is your MailCheap code$/);
		assert.equal(platformEmails.filter(({ to }) => to.includes("smtp-code@team.example.org")).length, 0);
	});

	test("the server's answers become sending's actions: busy retries, a refused login or sender pauses, a refused reader fails", async () => {
		const action = async (error) => {
			failNextSend(Object.assign(new Error(error.message ?? "refused"), error));
			const failure = await m.smtp.sendEmail({ email: { from: `hi@${DOMAIN}`, to: "reader@example.org", subject: "Hi", html: "<p>Hi</p>", text: "Hi" } }).catch((caught) => caught);
			return m.sendingRules.getSendErrorAction(failure);
		};
		assert.equal(await action({ code: "ECONNECTION" }), "retry");
		assert.equal(await action({ code: "EENVELOPE", responseCode: 451, command: "RCPT TO" }), "retry");
		assert.equal(await action({ code: "EAUTH", responseCode: 535 }), "pause");
		assert.equal(await action({ code: "ETLS" }), "pause");
		assert.equal(await action({ code: "EENVELOPE", responseCode: 553, command: "MAIL FROM" }), "pause");
		assert.equal(await action({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }), "fail");
		await withEnv({ SENDING_ENABLED: "false" }, async () => {
			await assert.rejects(m.smtp.sendEmail({ email: { to: "reader@example.org" } }), /Sending is off/);
		});
	});
});

describe("local job queue", () => {
	test("a campaign's batches wait in MongoDB, not QStash, and go out over STARTTLS with their unsubscribe headers", async () => {
		const user = await signIn("sender@team.example.org");
		const id = await createSend(user, "queue-notes");
		const before = sentMail.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		assert.equal(published.length, 0, "nothing went to QStash");
		assert.equal(await m.Job.countDocuments({ kind: "send-batch", status: "queued" }), 1);

		assert.deepEqual(await runJobs(), { done: 1, retried: 0, failed: 0 });
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).status, "sent");
		assert.equal(await m.Job.countDocuments({ kind: "send-batch", status: "done" }), 1);
		const sent = sentMail.slice(before);
		assert.deepEqual(sent.map(({ to }) => to).sort(), ["a", "b", "c"].map((name) => `${name}-queue-notes@readers.example.org`));
		assert.equal(sent[0].from, `"Jo" <queue-notes@${DOMAIN}>`);
		assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
		assert.match(sent[0].headers["Feedback-ID"], new RegExp(`:mc-${user.accountId}:campaign:mailcheap$`));
		const message = await m.Message.findOne({ accountId: user.accountId, campaignId: id }).lean();
		assert.match(message.providerMessageId, /@smtp\.example\.com>$/);

		assert.equal(transports.length, 1, "one pooled transport");
		const { options } = transports[0];
		assert.deepEqual(
			{ host: options.host, port: options.port, secure: options.secure, requireTLS: options.requireTLS, tls: options.tls, auth: options.auth },
			{ host: "mail.example.com", port: 587, secure: false, requireTLS: true, tls: { rejectUnauthorized: true }, auth: { user: "mailcheap", pass: "smtp-password" } }
		);
	});

	test("a scheduled send waits as a job due at its time, then runs through the same route QStash would call", async () => {
		const user = await signIn("scheduler@team.example.org");
		const id = await createSend(user, "scheduled-notes", "scheduled.example.com");
		const at = new Date(Date.now() + 30 * 86_400_000);
		assert.deepEqual(await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: at.toISOString() })), { ok: true });
		const job = await m.Job.findOne({ kind: "send-scheduled", "payload.campaignId": id }).lean();
		assert.equal(job.runAt.getTime(), Math.floor(Math.min(at.getTime(), Date.now() + 6 * 86_400_000) / 1000) * 1000, "QStash's 6-day hops, kept");
		assert.deepEqual(await runJobs(), { done: 0, retried: 0, failed: 0 }, "not due yet");

		const now = new Date(Math.floor(Date.now() / 1000) * 1000);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { scheduledAt: now } });
		await m.Job.updateOne({ _id: job._id }, { $set: { runAt: now, "payload.scheduledAt": now.toISOString() } });
		const before = sentMail.length;
		assert.deepEqual(await runJobs(), { done: 2, retried: 0, failed: 0 }, "the scheduled send, then its batch");
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).status, "sent");
		assert.equal(sentMail.length - before, 3);
	});

	test("a job that fails is tried again with backoff, alerts on its third try and stays failed after its last", async () => {
		const job = await m.Job.create({ kind: "send-batch", payload: {} });
		assert.deepEqual(await runJobs(), { done: 0, retried: 1, failed: 0 });
		const retried = await m.Job.findById(job._id).lean();
		assert.equal(retried.status, "queued");
		assert.equal(retried.attempts, 1);
		assert.match(retried.lastError, /\/api\/jobs\/send-batch answered 400/);
		assert.ok(retried.runAt.getTime() > Date.now() + 25_000);

		await m.Job.updateOne({ _id: job._id }, { $set: { runAt: new Date(), attempts: m.jobRules.MAX_JOB_ATTEMPTS - 1 } });
		assert.deepEqual(await runJobs(), { done: 0, retried: 0, failed: 1 });
		assert.equal((await m.Job.findById(job._id).lean()).status, "failed");
		assert.ok(await m.Alert.exists({ key: "job-failing:/api/jobs/send-batch" }));
	});

	test("a job whose server stopped mid-run is taken again once its lock runs out", async () => {
		const job = await m.Job.create({ kind: "send-batch", payload: {}, status: "running", attempts: 1, lockedUntil: new Date(Date.now() + 60_000) });
		await runJobs();
		assert.equal((await m.Job.findById(job._id).lean()).attempts, 1, "still locked");
		await m.Job.updateOne({ _id: job._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
		await runJobs();
		assert.equal((await m.Job.findById(job._id).lean()).attempts, 2);
		await m.Job.deleteOne({ _id: job._id });

		const lastTry = await m.Job.create({ kind: "send-batch", payload: {}, status: "running", attempts: m.jobRules.MAX_JOB_ATTEMPTS, lockedUntil: new Date(Date.now() - 1000) });
		assert.deepEqual(await runJobs(), { done: 0, retried: 0, failed: 1 }, "stopped on its last try: not run again");
		const failed = await m.Job.findById(lastTry._id).lean();
		assert.equal(failed.status, "failed");
		assert.match(failed.lastError, /stopped while running it on its last try/);
	});

	test("the runner and the job routes only take the runner's token, and the runner is off without JOB_QUEUE=local", async () => {
		assert.equal((await m.runRoute.POST(runnerRequest("/api/jobs/run", { token: null }))).status, 401);
		assert.equal((await m.runRoute.POST(runnerRequest("/api/jobs/run", { token: m.jobRules.getJobRunnerToken("another-secret-that-is-long-enough-123") }))).status, 401);
		assert.equal((await m.runRoute.POST(runnerRequest("/api/jobs/run", { token: process.env.BETTER_AUTH_SECRET }))).status, 401);
		assert.equal((await withEnv({ JOB_QUEUE: "" }, () => m.runRoute.POST(runnerRequest("/api/jobs/run")))).status, 404);

		const body = { accountId: "64f1a2b3c4d5e6f7a8b9c0d1", messageIds: [] };
		assert.equal((await m.sendBatchRoute.POST(runnerRequest("/api/jobs/send-batch", { token: null, body }))).status, 503, "QStash's signature it doesn't have");
		assert.equal((await m.sendBatchRoute.POST(runnerRequest("/api/jobs/send-batch", { body }))).status, 400, "the runner's request reaches the handler");
		const qstashOnly = await withEnv({ JOB_QUEUE: "" }, () => m.sendBatchRoute.POST(runnerRequest("/api/jobs/send-batch", { body })));
		assert.equal(qstashOnly.status, 503, "with QStash, the runner's token means nothing");
	});
});

describe("S3-compatible storage without a CDN", () => {
	test("uploads go to the bucket at its endpoint, path-style, and the app serves them at /media", async () => {
		const user = await signIn("images@team.example.org");
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })));
		const uploaded = await callApi("POST", "/api/v1/images", { key, body: { base64: Buffer.from(PNG).toString("base64"), fileName: "Cover.png" } });
		assert.equal(uploaded.status, 201);
		const object = s3Objects.at(-1);
		assert.match(object.Key, new RegExp(`^accounts/${user.accountId}/images/cover-[0-9a-f]{16}\\.png$`));
		assert.equal(uploaded.body.url, `http://localhost:3000/media/${object.Key}`);
		assert.deepEqual(s3Clients.at(-1).config, {
			region: "us-east-1",
			credentials: { accessKeyId: "garage-key-id", secretAccessKey: "garage-secret" },
			endpoint: "http://garage.internal:3900",
			forcePathStyle: true,
		});

		const get = (path) => m.mediaRoute.GET(new Request(`http://localhost:3000/media/${path}`), { params: Promise.resolve({ key: path.split("/") }) });
		const served = await get(object.Key);
		assert.equal(served.status, 200);
		assert.equal(served.headers.get("content-type"), "image/png");
		assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
		assert.equal(served.headers.get("x-content-type-options"), "nosniff");
		assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);

		const missing = object.Key.replace(/-[0-9a-f]{16}\./, "-0000000000000000.");
		for (const path of [missing, `${object.Key}/x.png`, object.Key.replace(".png", ".svg"), "accounts/../secret.png", object.Key.toUpperCase(), `accounts/${user.accountId}/cover.png`]) {
			assert.equal((await get(path)).status, 404, path);
		}
		assert.equal((await withEnv({ IMAGES_CDN_URL: "https://cdn.example.com" }, () => get(object.Key))).status, 404, "a CDN serves them instead");
	});
});
