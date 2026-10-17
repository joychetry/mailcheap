// An in-memory SMTP server: emails are kept here with the settings of the transport that sent them. failNextSend makes
// the next send fail with the error nodemailer would throw.
export const sentMail = [];
export const transports = [];
const failures = [];

export function failNextSend(error) {
	failures.push(error);
}

function createTransport(options) {
	const transport = {
		options,
		async sendMail(mail) {
			const failure = failures.shift();
			if (failure) throw failure;
			sentMail.push({ ...mail, options });
			return { messageId: `<${sentMail.length}@smtp.example.com>`, accepted: [mail.to], rejected: [] };
		},
	};
	transports.push(transport);
	return transport;
}

const nodemailer = { createTransport };
export default nodemailer;
