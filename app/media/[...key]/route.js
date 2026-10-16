import { getUploadContentType } from "@/lib/image-files";
import { getImageStorage, getS3Image } from "@/lib/image-storage";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("Not found", { status: 404 });

// Uploads in a private S3 bucket without a CDN in front (lib/image-storage.js). Open to anyone: sent emails load them.
export async function GET(_request, { params }) {
	const key = ((await params).key ?? []).join("/");
	const contentType = getUploadContentType(key);
	if (getImageStorage() !== "s3" || process.env.IMAGES_CDN_URL || !contentType) return NOT_FOUND();
	const image = await getS3Image(key);
	if (!image) return NOT_FOUND();
	return new Response(image.body, {
		headers: {
			"content-type": contentType,
			...(image.length && { "content-length": String(image.length) }),
			"cache-control": "public, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'",
		},
	});
}
