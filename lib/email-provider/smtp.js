import "server-only";
import nodemailer from "nodemailer";
import { LIMITS, getSmtpDomains, isSendingEnabled } from "@/lib/config";
import { SEND_OUTCOMES, providerError } from "@/lib/email-provider/outcomes";

// Any SMTP server (Postfix, Stalwart, a provider's SMTP) for a self-hosted server. It has no tenants and no events:
// bounces and complaints aren't recorded, so suppressions don't grow from them and the pause and block levels never
// trip; the mail server's own bounce reports are the only trace. DKIM, SPF and the return path are its job too, and
// the domains it signs for (SMTP_DOMAINS) count as verified.

const CONNECTION_ERRORS = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "EPROTOCOL"]);
const SETUP_ERRORS = new Set(["EAUTH", "ENOAUTH", "ETLS", "EREQUIRETLS"]);
// Every account sends through the same server: getTenant is never empty, so nothing waits to be set up.
const TENANT = Object.freeze({ smtp: true });
let transport;

function getTransport() {
	const isImplicitTls = process.env.SMTP_SECURE === "true";
	transport ??= nodemailer.createTransport({
		host: process.env.SMTP_HOST?.trim(),
		port: Number.parseInt(process.env.SMTP_PORT, 10) || (isImplicitTls ? 465 : 587),
		// TLS from the first byte on 465; on 587 a server that doesn't offer STARTTLS is refused, never sent to in plaintext.
		secure: isImplicitTls,
		requireTLS: !isImplicitTls,
		auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
		// Only for a relay on a private network whose certificate can't match its hostname there.
		tls: { rejectUnauthorized: process.env.SMTP_TLS_VERIFY !== "false" },
		pool: true,
		maxConnections: 2,
	});
	return transport;
}

// nodemailer's codes and the server's reply in sending's words (./outcomes.js): a server that's down or busy
// (4xx) is tried again later, one refusing the login or the from address pauses the campaign, and a recipient it
// refuses fails that one email.
function toProviderError(error) {
	const reply = error.responseCode;
	let outcome = SEND_OUTCOMES.failed;
	if (SETUP_ERRORS.has(error.code)) outcome = SEND_OUTCOMES.misconfigured;
	else if (CONNECTION_ERRORS.has(error.code) || (reply >= 400 && reply < 500)) outcome = SEND_OUTCOMES.unavailable;
	else if (error.command === "MAIL FROM") outcome = SEND_OUTCOMES.domainUnverified;
	return providerError(outcome, `SMTP: ${error.message}`);
}

async function send(email) {
	let info;
	try {
		info = await getTransport().sendMail(email);
	} catch (error) {
		throw toProviderError(error);
	}
	if (info.rejected?.length) throw providerError(SEND_OUTCOMES.failed, `SMTP: the server refused ${info.rejected.join(", ")}`);
	return info.messageId;
}

async function sendEmail({ email, feedbackId }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	const { from, to, replyTo, subject, html, text, headers } = email;
	const headersWithFeedback = feedbackId ? { ...headers, "Feedback-ID": feedbackId } : headers;
	return { providerMessageId: await send({ from, to, replyTo, subject, html, text, headers: headersWithFeedback }) };
}

// Sign-in codes and alerts without Resend. SENDING_ENABLED is for readers' emails; these go before it's on.
async function sendPlatformEmail({ from, to, subject, text, html }) {
	return { messageId: await send({ from, to, subject, text, html }) };
}

function getTenant() {
	return TENANT;
}

// MailCheap's own block is what holds an account: there's nothing to suspend or resume at the server.
async function suspendTenant() {}

async function resumeTenant() {
	return false;
}

function describeTenant() {
	return { id: "none", status: "smtp", detail: null };
}

async function removeTenant() {}

// The mail server's own return path: MailCheap doesn't set one.
function getMailFromDomain(domain) {
	return domain;
}

async function addDomain() {
	return { providerDomainId: null };
}

// Nothing is looked up: the server signs for the domains it's told to, and MailCheap can't check that it does.
async function readDomain({ domain }) {
	const verified = getSmtpDomains().includes(domain.domain);
	return { verified, dkimStatus: "NOT_STARTED", mailFromStatus: "NOT_STARTED", records: [] };
}

async function removeDomain() {}

function getSendLane() {
	return { name: "smtp", rate: LIMITS.sendRatePerSecond };
}

function isConfigured() {
	return Boolean(process.env.SMTP_HOST?.trim());
}

export const smtpProvider = Object.freeze({
	id: "smtp",
	name: "SMTP",
	returnPathPrefix: null,
	isConfigured,
	sendPlatformEmail,
	getTenant,
	provisionTenant: getTenant,
	ensureTenant: getTenant,
	suspendTenant,
	resumeTenant,
	describeTenant,
	removeTenant,
	getMailFromDomain,
	addDomain,
	readDomain,
	removeDomain,
	getSendLane,
	sendEmail,
});
