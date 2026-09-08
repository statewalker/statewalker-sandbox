/**
 * A picture the person chose or just took, turned into something this peer can
 * serve to the mesh.
 *
 * NOTHING IS RE-ENCODED. An earlier version downscaled anything over 1280px,
 * reasoning that the relay's 1 MiB per-connection data limit would truncate a
 * phone photo. That protected the exceptional path at the cost of the normal
 * one: peers upgrade to WebRTC and a direct, unlimited connection, and the
 * relay is not in the data path at all once ICE completes. Silently re-encoding
 * every photograph to guard a fallback that mostly does not happen is the wrong
 * trade -- and it threw away the user's actual bytes to do it.
 *
 * The bytes are served exactly as given. If a peer ever does fall back to a
 * relayed circuit and a large transfer is cut off, that is a visible failure of
 * the fallback and belongs in the fallback, not in a lossy transformation
 * applied to everyone in advance.
 */
import type { ImageInfo } from "../../services/images.js";
import { imagePath } from "../../services/images.js";

/** What a picture becomes when the browser reports no type at all -- some Android pickers do. */
const FALLBACK_CONTENT_TYPE = "image/jpeg";

export interface LocalImage {
  info: ImageInfo;
  bytes: Uint8Array;
  /** Where to write `bytes` so `createImagesEndpoint` finds them. */
  path: string;
}

/** Distinct per pick, so choosing the same file twice yields two gallery entries rather than one silently replacing the other. */
function freshId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function fileToImage(file: File): Promise<LocalImage> {
  const declared = file.type;
  if (declared !== "" && !declared.startsWith("image/")) {
    throw new Error(`"${file.name}" is not an image (${declared}) -- refusing to serve it as one.`);
  }
  const contentType = declared === "" ? FALLBACK_CONTENT_TYPE : declared;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = freshId();
  return {
    info: {
      id,
      title: file.name.replace(/\.[^.]+$/, "") || "Untitled",
      contentType,
      size: bytes.length,
    },
    bytes,
    path: imagePath(id),
  };
}
