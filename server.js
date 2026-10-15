/* 极简静态服务器：node server.js  →  http://localhost:8123
   本游戏也可以直接双击 index.html 游玩，无需服务器。
   另含云存档接口（与 serve.ps1 等价）：
     GET  /api/save/info?code=123     查询码是否存在 / 是否有密码
     POST /api/save/get    {code,password}                 读取存档
     POST /api/save/put    {code,password,data}            保存（新建或覆盖）
   存档文件：saves/<code>.json */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = process.env.PORT || 8123;
const SAVE_DIR = path.join(ROOT, "saves");
const SAVE_MAX_BODY = 12 * 1024 * 1024;   // 12MB 硬上限
const TYPES = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch (e) {}

/* ---------------- 联机信令（内存房间，与 serve.ps1 等价） ----------------
   房间仅用于 WebRTC 握手期交换 SDP/ICE，P2P 建连后不再需要。
   房间结构：{ hostQ: 客人发给主机的消息, guestQ: 主机发给客人的消息,
              t: 最近活跃时间(ms), guest: 客人是否已占坑 } */
const ROOM_TTL_MS = 15 * 60 * 1000;  // 15 分钟无活动自动过期
const SIG_MAX_BODY = 8192;           // 信令载荷只有很小的 SDP/ICE
const rooms = new Map();

function purgeRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.t > ROOM_TTL_MS) rooms.delete(code);
  }
}

function newRoom() {
  purgeRooms();
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  } while (rooms.has(code));
  rooms.set(code, { hostQ: [], guestQ: [], t: Date.now(), guest: false });
  return code;
}

function handleSignal(req, res, urlPath) {
  // POST /signal/host：主机开房，返回 6 位房间码
  if (req.method === "POST" && urlPath === "/signal/host") {
    const code = newRoom();
    return sendJson(res, 200, { ok: true, code: code, ttl: ROOM_TTL_MS / 1000 });
  }

  if (req.method === "POST" &&
      (urlPath === "/signal/join" || urlPath === "/signal/send")) {
    readBody(req, SIG_MAX_BODY).then(function (obj) {
      const code = String(obj.code == null ? "" : obj.code).trim();
      const room = rooms.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: "room_not_found" });

      if (urlPath === "/signal/join") {
        if (room.guest) return sendJson(res, 409, { ok: false, error: "room_full" });
        room.guest = true;
        room.t = Date.now();
        return sendJson(res, 200, { ok: true });
      }

      // /signal/send：who 为发送方，消息进入对方的队列
      const who = String(obj.who == null ? "" : obj.who);
      if (who !== "host" && who !== "guest")
        return sendJson(res, 400, { ok: false, error: "bad_request" });
      const msg = String(obj.msg == null ? "" : obj.msg);
      if (who === "host") room.guestQ.push(msg); else room.hostQ.push(msg);
      room.t = Date.now();
      sendJson(res, 200, { ok: true });
    }).catch(function (e) {
      sendJson(res, e.message === "too_large" ? 413 : 400,
        { ok: false, error: e.message || "bad_request" });
    });
    return;
  }

  // GET /signal/poll?code=&who=：取走发给自己的全部消息
  if (req.method === "GET" && urlPath === "/signal/poll") {
    const sp = new URL(req.url, "http://x").searchParams;
    const code = (sp.get("code") || "").trim();
    const who = (sp.get("who") || "").trim();
    const room = rooms.get(code);
    if (!room || (who !== "host" && who !== "guest"))
      return sendJson(res, 400, { ok: false, error: "bad_request" });
    const q = who === "host" ? room.hostQ : room.guestQ;
    const msgs = q.splice(0, q.length);
    room.t = Date.now();
    return sendJson(res, 200, { ok: true, msgs: msgs });
  }

  sendJson(res, 404, { ok: false, error: "unknown_signal" });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function pwHash(code, pw) {
  return crypto.createHash("sha256").update(code + ":" + pw, "utf8").digest("hex");
}

function validCode(code) {
  return typeof code === "string" && /^\d{3,8}$/.test(code);
}

function savePath(code) {
  // code 已过 ^\d{3,8}$ 校验，无路径穿越风险
  return path.join(SAVE_DIR, code + ".json");
}

function readBody(req, max) {
  const limit = max || SAVE_MAX_BODY;
  return new Promise(function (resolve, reject) {
    const len = parseInt(req.headers["content-length"] || "0", 10) || 0;
    if (len > limit) { reject(new Error("too_large")); return; }
    const chunks = [];
    let got = 0;
    req.on("data", function (c) {
      got += c.length;
      if (got > limit) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("bad_request")); }
    });
    req.on("error", function () { reject(new Error("bad_request")); });
  });
}

function handleSaveApi(req, res, urlPath) {
  if (req.method === "GET" && urlPath === "/api/save/info") {
    const code = (new URL(req.url, "http://x").searchParams.get("code") || "").trim();
    if (!validCode(code)) return sendJson(res, 400, { ok: false, error: "bad_code" });
    fs.readFile(savePath(code), "utf8", function (err, txt) {
      if (err) return sendJson(res, 200, { ok: true, exists: false, locked: false, ts: 0 });
      let rec = null;
      try { rec = JSON.parse(txt); } catch (e) {}
      if (!rec) return sendJson(res, 200, { ok: true, exists: false, locked: false, ts: 0 });
      sendJson(res, 200, { ok: true, exists: true, locked: !!rec.locked, ts: rec.ts | 0 });
    });
    return true;
  }

  if (req.method === "POST" && (urlPath === "/api/save/get" || urlPath === "/api/save/put")) {
    readBody(req).then(function (obj) {
      const code = String(obj.code == null ? "" : obj.code).trim();
      const pw = String(obj.password == null ? "" : obj.password);
      if (!validCode(code)) return sendJson(res, 400, { ok: false, error: "bad_code" });
      const file = savePath(code);

      if (urlPath === "/api/save/get") {
        fs.readFile(file, "utf8", function (err, txt) {
          if (err) return sendJson(res, 404, { ok: false, error: "save_not_found" });
          let rec = null;
          try { rec = JSON.parse(txt); } catch (e) {}
          if (!rec || typeof rec.data !== "string")
            return sendJson(res, 500, { ok: false, error: "bad_record" });
          if (rec.locked && pwHash(code, pw) !== rec.ph)
            return sendJson(res, 403, { ok: false, error: "bad_password" });
          sendJson(res, 200, { ok: true, ts: rec.ts | 0, data: rec.data });
        });
        return;
      }

      // put：新建或覆盖（已存在且带密码时必须提供正确密码）
      if (typeof obj.data !== "string" || obj.data.length < 2)
        return sendJson(res, 400, { ok: false, error: "bad_request" });
      fs.readFile(file, "utf8", function (err, oldTxt) {
        let old = null;
        if (!err) { try { old = JSON.parse(oldTxt); } catch (e) {} }
        if (err && err.code !== "ENOENT")
          return sendJson(res, 500, { ok: false, error: "write_failed" });
        if (!err && old === null)
          return sendJson(res, 500, { ok: false, error: "bad_record" });

        let locked = false, ph = "";
        if (old) {
          if (old.locked && pwHash(code, pw) !== old.ph)
            return sendJson(res, 403, { ok: false, error: "bad_password" });
          locked = !!old.locked;
          ph = old.ph || "";
        } else if (pw.length > 0) {
          locked = true;
          ph = pwHash(code, pw);
        }
        const rec = { code: code, ts: Date.now(), locked: locked, ph: ph, data: obj.data };
        const tmp = path.join(SAVE_DIR, code + ".tmp");
        const json = JSON.stringify(rec);
        fs.writeFile(tmp, json, "utf8", function (wErr) {
          if (wErr) return sendJson(res, 500, { ok: false, error: "write_failed" });
          fs.rename(tmp, file, function (rErr) {
            if (rErr) {
              try { fs.unlink(tmp, function () {}); } catch (e) {}
              return sendJson(res, 500, { ok: false, error: "write_failed" });
            }
            sendJson(res, 200, { ok: true, ts: rec.ts });
          });
        });
      });
    }).catch(function (e) {
      sendJson(res, e.message === "too_large" ? 413 : 400,
        { ok: false, error: e.message || "bad_request" });
    });
    return true;
  }

  return false;
}

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath.startsWith("/signal/")) {
    return handleSignal(req, res, urlPath);
  }

  if (urlPath.startsWith("/api/save/")) {
    if (handleSaveApi(req, res, urlPath)) return;
    return sendJson(res, 404, { ok: false, error: "unknown_api" });
  }

  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" });
      res.end("404 Not Found: " + urlPath);
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log("方块世界已启动: http://localhost:" + PORT);
});
