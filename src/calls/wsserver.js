// The server half of a WebSocket (RFC 6455), for the one socket Reason accepts: Twilio's media stream
// for a GPT-Live call (src/calls/gptlive.js). Text frames only in practice — Twilio sends JSON — with
// ping/pong, close and fragmentation handled so a well-behaved client is never left hanging. No
// dependency: the package has none for this, and this is all of it that the media stream needs.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** One frame bigger than this is a client misbehaving, not a media stream (Twilio frames are ~250 bytes). */
const MAX_FRAME = 1024 * 1024;

/** The Sec-WebSocket-Accept value for a client key. */
export function acceptKey(key) {
  return createHash("sha1").update(String(key) + GUID).digest("base64");
}

/** One server frame: FIN set, unmasked (servers never mask). */
export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const n = data.length;
  let head;
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, data]);
}

/**
 * Reads frames out of a byte stream. `push(chunk)` returns the complete frames now available as
 * `{ fin, opcode, payload }`; a partial frame waits for the next chunk. Throws on a frame too big.
 */
export function frameReader() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2); at = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(MAX_FRAME)) throw new Error("frame too large");
          len = Number(big); at = 10;
        }
        if (len > MAX_FRAME) throw new Error("frame too large");
        const maskAt = at;
        if (masked) at += 4;
        if (buf.length < at + len) break;
        const payload = Buffer.from(buf.subarray(at, at + len));
        if (masked) {
          const mask = buf.subarray(maskAt, maskAt + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        out.push({ fin, opcode, payload });
        buf = buf.subarray(at + len);
      }
      return out;
    },
  };
}

/**
 * Finish the upgrade on a raw socket and hand back a small socket object:
 * `send(text)`, `close(code)`, `onMessage(fn)`, `onClose(fn)`, `open()`.
 * Returns null (and answers 400) when the request is not a WebSocket upgrade.
 */
export function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "", "",
  ].join("\r\n"));
  socket.setNoDelay?.(true);
  return wrapSocket(socket);
}

/** The socket object over an already-upgraded raw socket. Exported for the tests. */
export function wrapSocket(socket) {
  const reader = frameReader();
  const onMessage = [];
  const onClose = [];
  let open = true;
  let parts = [];
  const finish = (code = 1000) => {
    if (!open) return;
    open = false;
    for (const fn of onClose) { try { fn(code); } catch { /* a listener never breaks the close */ } }
  };
  socket.on("data", (chunk) => {
    let frames;
    try { frames = reader.push(chunk); } catch {
      try { socket.end(encodeFrame(Buffer.from([0x03, 0xf1]), 0x8)); } catch { /* gone */ }
      return finish(1009);
    }
    for (const f of frames) {
      if (f.opcode === 0x8) {
        try { socket.end(encodeFrame(f.payload.subarray(0, 2), 0x8)); } catch { /* gone */ }
        return finish(f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005);
      }
      if (f.opcode === 0x9) { try { socket.write(encodeFrame(f.payload, 0xA)); } catch { /* gone */ } continue; }
      if (f.opcode === 0xA) continue;
      if (f.opcode === 0x1 || f.opcode === 0x2) parts = [f.payload];
      else if (f.opcode === 0x0) parts.push(f.payload);
      else continue;
      if (!f.fin) continue;
      const text = Buffer.concat(parts).toString("utf8");
      parts = [];
      for (const fn of onMessage) { try { fn(text); } catch { /* one bad handler never stops the stream */ } }
    }
  });
  socket.on("close", () => finish(1006));
  socket.on("error", () => finish(1006));
  return {
    open: () => open,
    send(text) {
      if (!open) return false;
      try { socket.write(encodeFrame(text)); return true; } catch { return false; }
    },
    close(code = 1000) {
      if (!open) return;
      const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
      try { socket.end(encodeFrame(b, 0x8)); } catch { /* gone */ }
      finish(code);
    },
    onMessage: (fn) => onMessage.push(fn),
    onClose: (fn) => onClose.push(fn),
  };
}
