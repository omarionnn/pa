// iMessage's rich link card, as a file.
//
// When somebody texts a link, iMessage also sends the card it draws under it — a file named like
// `zwpuJHMN_2D9D4818-1290-40D7-9E78-74B514220AD0.pluginPayloadAttachment` (Sendblue's media_url is
// https://storage.googleapis.com/inbound-file-store/<that name>). It arrives on the same webhook as
// the link, or on its own `_1` / `_2` part with no words at all. Nobody chose to send it, and
// nothing here can open it. 2026-10-30: the model was told "[they sent a file, which you cannot
// open: ….pluginPayloadAttachment]" twice under a pasted link, and told the owner his files didn't
// come through.
//
// So every inbound path (Sendblue, Linq, Reason Web uploads) asks this one question and drops the
// card silently: no line about it, no attachment row, no turn when it is all a message carried.
// The link itself is in the words and goes through as it was.

/** Apple's identifiers for the link-card balloon, when a payload carries a type at all. */
const PREVIEW_TYPES = /pluginpayload|urlballoonprovider/i;

/**
 * Is this attachment the link card iMessage sends with a URL? By its filename's extension, or by
 * a UTI / mime type naming the plugin payload or Apple's URL balloon provider.
 */
export function isLinkPreviewAttachment({ filename = "", mime = "", uti = "", url = "" } = {}) {
  const name = String(filename || String(url || "").split("?")[0].split("/").pop() || "").trim();
  if (/\.pluginPayloadAttachment$/i.test(name)) return true;
  return PREVIEW_TYPES.test(String(mime ?? "")) || PREVIEW_TYPES.test(String(uti ?? ""));
}
