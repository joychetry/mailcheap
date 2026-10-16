import { TriangleAlert } from "lucide-react";

// SMTP has no account to read and no events: say so instead of a status MailCheap never checked.
export default function StripSmtpServer() {
	return (
		<p className="flex items-center gap-3 rounded-xl px-4 py-4 text-sm text-muted-foreground shadow-border animate-fade-in">
			<TriangleAlert className="size-4 shrink-0 text-amber-500" />
			<span className="min-w-0 text-pretty">
				Sending through SMTP ({process.env.SMTP_HOST?.trim()}). Bounces and complaints aren&apos;t recorded: check the mail server&apos;s own reports.
			</span>
		</p>
	);
}
