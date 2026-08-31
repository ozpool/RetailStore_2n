import sharp from "sharp";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 2000;

/**
 * Avatars get tighter limits than listing photos: they render at ~40px in the
 * nav and never larger than a small circle, so 512px square is generous and a
 * 5MB ceiling is plenty.
 */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_SIZE = 512;

/** Guards against decompression bombs: a small file that decodes to gigapixels. */
const MAX_INPUT_PIXELS = 50_000_000;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Magic-byte sniffing. The filename extension and the client-supplied MIME type
 * are both attacker-controlled and neither proves what the bytes actually are,
 * so we look at the header ourselves before handing anything to the decoder.
 */
function sniffFormat(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.subarray(0, 8).equals(png)) return "png";

  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }

  return null;
}

export type ProcessedImage = {
  data: Buffer;
  ext: string;
  width: number;
  height: number;
};

/**
 * Validates and re-encodes an uploaded image.
 *
 * The re-encode is the important part: sellers photograph items inside their
 * own homes, and camera EXIF routinely carries GPS coordinates. Publishing that
 * would leak a home address. sharp does not copy metadata unless explicitly
 * asked to, so encoding to a fresh WebP drops EXIF (including GPS) entirely.
 * `.rotate()` runs first so the EXIF orientation flag is baked into the pixels
 * before that metadata disappears — otherwise portrait photos come out sideways.
 */
export async function processImageUpload(buf: Buffer): Promise<ProcessedImage> {
  if (buf.length === 0) {
    throw new UploadError("That file was empty.");
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new UploadError("Image must be 8MB or smaller.");
  }
  if (!sniffFormat(buf)) {
    throw new UploadError("Only JPEG, PNG, or WebP images are supported.");
  }

  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    return { data, ext: "webp", width: info.width, height: info.height };
  } catch {
    throw new UploadError("That image couldn't be processed. Try a different file.");
  }
}

/**
 * Validates and re-encodes an avatar.
 *
 * Same safety properties as processImageUpload — magic-byte sniffing, decode
 * cap, and a metadata-dropping re-encode that strips EXIF/GPS — but cropped to
 * a square so the UI never has to guess how to fit a portrait into a circle.
 * Cropping server-side also means one canonical asset rather than every
 * surface applying its own object-fit.
 */
export async function processAvatarUpload(buf: Buffer): Promise<ProcessedImage> {
  if (buf.length === 0) {
    throw new UploadError("That file was empty.");
  }
  if (buf.length > MAX_AVATAR_BYTES) {
    throw new UploadError("Profile picture must be 5MB or smaller.");
  }
  if (!sniffFormat(buf)) {
    throw new UploadError("Only JPEG, PNG, or WebP images are supported.");
  }

  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });

    return { data, ext: "webp", width: info.width, height: info.height };
  } catch {
    throw new UploadError("That image couldn't be processed. Try a different file.");
  }
}
