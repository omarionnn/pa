// The terminal, as a channel. It is always live, because stdout is always there, and it only
// ever reaches the owner — which is why `send` ignores the address entirely: there is nobody
// else on the other end of a console. That makes it the one channel that cannot leak.
import { Channel } from "./channel.js";
import { config } from "../config.js";

export class ConsoleChannel extends Channel {
  name = "console";

  constructor({ write = (s) => process.stdout.write(s) } = {}) {
    super();
    this.write = write;
  }

  status() {
    return { name: this.name, status: "live", missing: [], what: `the terminal ${config.ownerName} is typing in. Only reaches them; nobody else can be messaged here.` };
  }

  /**
   * A terminal has no screen effects, and silently dropping one would make a tested-looking feature
   * untested: `npm run chat` is where most of this gets tried first. So the effect is named on its
   * own line instead — the honest version of confetti here, and enough to see that one was actually
   * asked for without a phone in hand.
   *
   * There is deliberately no equivalent for a tapback: react() is left as the base class's
   * `not_supported`, because a reaction has no bubble of its own to print and the model is meant to
   * fall back to words rather than to a line of prose about having reacted.
   */
  async send({ text, to, sendStyle = null }) {
    this.write(`reason> ${text}${sendStyle ? `\n        ✨ with the '${sendStyle}' screen effect\n` : ""}\n\n`);
    return { ok: true, delivered: { channel: this.name, to: to ?? "console", at: Date.now(), ...(sendStyle ? { send_style: sendStyle } : {}) } };
  }

  /**
   * A terminal cannot play audio, but it can tell you exactly where the file is — which is the
   * honest version of "here is the recording" on this channel, and enough to open it.
   */
  async sendMedia({ text, to, file, mimeType }) {
    this.write(`reason> ${text}\n        🎧 ${file}${mimeType ? ` (${mimeType})` : ""}\n\n`);
    return {
      ok: true, supported: true,
      delivered: { channel: this.name, to: to ?? "console", media: { file, mimeType }, at: Date.now() },
    };
  }

  async typing() {
    return { ok: true, supported: false };
  }
}
