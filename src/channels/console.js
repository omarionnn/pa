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

  async send({ text, to }) {
    this.write(`reason> ${text}\n\n`);
    return { ok: true, delivered: { channel: this.name, to: to ?? "console", at: Date.now() } };
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
