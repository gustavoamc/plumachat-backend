import path from "path";

// Root directory for user-uploaded board images, served statically at /uploads.
// Files are grouped per room (`uploads/<roomId>/<file>`) so a room's images can
// be removed in one shot when the room is deleted.
export const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export const roomUploadDir = (roomId: string) => path.join(UPLOAD_ROOT, roomId);

// Allowed image MIME types and the matching file extensions for stored files.
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
