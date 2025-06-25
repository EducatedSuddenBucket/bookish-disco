import net from "node:net";
import dns from "node:dns";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/status\/([^\/]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    let [host, port] = match[1].split(":");
    port = port ? parseInt(port, 10) : 25565;

    try {
      // 1) Try SRV lookup (_minecraft._tcp.host)
      const srv = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`)
        .catch(() => null);
      if (srv && srv.length) {
        host = srv[0].name;
        port = srv[0].port;
      }

      // 2) Ensure host resolves at all
      await dns.promises.lookup(host);

      // 3) Connect & handshake
      const serverInfo = await pingJava(host, port);

      // 4) Format response
      let description = typeof serverInfo.description === 'string'
        ? serverInfo.description
        : extractText(serverInfo.description);

      return new Response(JSON.stringify({
        success: true,
        version: serverInfo.version,
        players: {
          max: serverInfo.players.max,
          online: serverInfo.players.online,
          list: serverInfo.players.sample || []
        },
        description,
        description_clean: removeColorCodes(description),
        latency: serverInfo.latency,
        favicon: serverInfo.favicon
      }), {
        headers: { "Content-Type": "application/json" }
      });

    } catch (err) {
      const codeMap = {
        TIMEOUT: ["timeout","Connection timed out"],
        ENOTFOUND: ["invalid_domain","Domain could not be resolved"],
        ECONNREFUSED: ["connection_refused","Connection refused"]
      };
      const [code, msg] = codeMap[err.code] || ["offline","Server offline or unreachable"];
      return new Response(JSON.stringify({
        success: false,
        error: { code, message: msg }
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

// —————— Helper functions (same as your Express version) ——————

function createVarInt(value) {
  const bytes = [];
  while (true) {
    if ((value & 0xffffff80) === 0) {
      bytes.push(value);
      return Buffer.from(bytes);
    }
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
}

function createPacket(id, data) {
  const idBuf = createVarInt(id);
  const lenBuf = createVarInt(idBuf.length + data.length);
  return Buffer.concat([lenBuf, idBuf, data]);
}

function readVarInt(buf, offset=0) {
  let value = 0, size = 0, byte;
  do {
    byte = buf[offset++];
    value |= (byte & 0x7f) << (7 * size++);
    if (size > 5) throw new Error("VarInt too big");
  } while (byte & 0x80);
  return [value, offset];
}

async function pingJava(host, port) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buffer = Buffer.alloc(0), pingStart;

    // overall timeout
    const timer = setTimeout(() => {
      sock.destroy();
      const e = new Error("timeout");
      e.code = "TIMEOUT";
      reject(e);
    }, 7000);

    sock.setTimeout(7000);
    sock.connect(port, host, () => {
      // handshake
      const hostBuf = Buffer.from(host, "utf8");
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = Buffer.concat([
        createVarInt(-1),
        createVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        createVarInt(1)
      ]);
      sock.write(createPacket(0x00, handshake));
      sock.write(createPacket(0x00, Buffer.alloc(0))); // status request
    });

    sock.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let [len, off] = readVarInt(buffer);
        if (buffer.length < off + len) return; // wait for full packet

        let [pid, off2] = readVarInt(buffer, off);
        if (pid === 0x00) {
          // status response
          let [jlen, off3] = readVarInt(buffer, off2);
          const json = buffer.slice(off3, off3 + jlen).toString();
          const info = JSON.parse(json);
          buffer = buffer.slice(off3 + jlen);

          // ping
          const payload = Buffer.alloc(8, 0);
          pingStart = process.hrtime.bigint();
          sock.write(createPacket(0x01, payload));
        }
        else if (pid === 0x01) {
          // pong
          const latency = Number(process.hrtime.bigint() - pingStart)/1e6;
          clearTimeout(timer);
          sock.destroy();
          info.latency = Math.round(latency);
          resolve(info);
        }
      } catch (e) {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      }
    });

    sock.on("error", err => { clearTimeout(timer); sock.destroy(); reject(err); });
    sock.on("timeout", () => {
      const e = new Error("timeout"); e.code="TIMEOUT";
      clearTimeout(timer); sock.destroy(); reject(e);
    });
  });
}

// Recursive text extractor & color‐code stripper (same as your Express code)
function extractText(obj) { /* … */ }
function removeColorCodes(s) { return s.replace(/§[0-9A-FK-OR]/gi, ""); }
