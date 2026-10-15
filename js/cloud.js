/* ============================================================
 * cloud.js — 云端存档传输层（配合 serve.ps1 / server.js）
 *
 * 模型：
 *   - 存档码：3~8 位数字，玩家自选（可用随机 6 位），码就是取档钥匙
 *   - 可选密码：绑定时设置后，读取/覆盖都要密码，服务端只存 sha256
 *   - 存档文件在服务器 saves/<code>.json，与浏览器本地 IndexedDB 双写
 *
 * 存储位置：
 *   - 绑定关系（当前浏览器绑定了哪个码）放 localStorage，长期保留
 *   - 密码只放 sessionStorage：同一次浏览器会话内自动上传用，
 *     关闭标签页即清除，不做长期持久化
 *
 * 对外：window.CloudSave
 *   CloudSave.info(code)                 → Promise<{exists,locked,ts}>
 *   CloudSave.put(code, pw, rawData)     → Promise<{ts}>
 *   CloudSave.get(code, pw)              → Promise<{ts,data}>
 *   CloudSave.bind(code) / unbind() / bound()
 *   CloudSave.rememberPassword / passwordFor
 *   CloudSave.uploadCurrent()            → Promise（读本地最新档→上传绑定码）
 *   CloudSave.status()                   → {code,syncing,lastSyncTs,lastError}
 *   CloudSave.normalizeCode / isValidCode / randomCode / errText
 * ============================================================ */
(function (global) {
  "use strict";

  const BIND_KEY = "mc_cloud_bind";
  const PW_KEY = "mc_cloud_pw";

  let syncing = false;
  let queued = false;
  let lastSyncTs = 0;
  let lastError = null;
  let unloading = false;   // 页面跳转/关闭中：途中的 fetch 会被浏览器中止，不算失败

  // pagehide 早于 unload，且切后台（visibilitychange）不触发它
  global.addEventListener("pagehide", function () { unloading = true; });

  const ERR_TEXT = {
    no_server: "云存档需要通过启动器打开游戏（serve.ps1 或 node server.js），双击 html 无法使用",
    bad_code: "存档码必须是 3~8 位数字",
    save_not_found: "没有这个存档码，请核对后重试",
    bad_password: "密码不正确，或该存档码已被别人占用（请换一个码）",
    too_large: "存档过大，服务器拒绝写入",
    bad_record: "服务器上的存档已损坏",
    write_failed: "服务器写入失败，请检查服务器磁盘空间",
    bad_request: "请求格式有误",
    network: "无法连接存档服务器，请确认游戏是通过服务器打开的",
    no_local: "本地还没有可上传的存档",
    busy: "正在同步中，请稍候"
  };

  function makeErr(code) {
    const e = new Error(ERR_TEXT[code] || code);
    e.code = code;
    return e;
  }

  function request(method, urlPath, body) {
    if (location.protocol === "file:") return Promise.reject(makeErr("no_server"));
    const opts = { method: method, cache: "no-store" };
    if (body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    return fetch(urlPath, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j || !j.ok) throw makeErr((j && j.error) || ("http_" + r.status));
        return j;
      }, function () { throw makeErr("network"); });
    }, function () { throw makeErr("network"); });
  }

  function readJSON(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function readLocalJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  const CloudSave = {
    normalizeCode: function (c) {
      return String(c == null ? "" : c).replace(/\D/g, "").slice(0, 8);
    },
    isValidCode: function (c) {
      return /^\d{3,8}$/.test(String(c == null ? "" : c));
    },
    randomCode: function () {
      return String(Math.floor(100000 + Math.random() * 900000));
    },
    errText: function (e) {
      if (!e) return "";
      return ERR_TEXT[e.code] || (e.message || String(e));
    },

    /* ---------------- 服务端接口 ---------------- */

    info: function (code) {
      if (!this.isValidCode(code)) return Promise.reject(makeErr("bad_code"));
      return request("GET", "/api/save/info?code=" + encodeURIComponent(code));
    },
    put: function (code, pw, rawData) {
      if (!this.isValidCode(code)) return Promise.reject(makeErr("bad_code"));
      if (typeof rawData !== "string" || rawData.length < 2) return Promise.reject(makeErr("bad_request"));
      return request("POST", "/api/save/put", {
        code: String(code), password: String(pw || ""), data: rawData
      });
    },
    get: function (code, pw) {
      if (!this.isValidCode(code)) return Promise.reject(makeErr("bad_code"));
      return request("POST", "/api/save/get", {
        code: String(code), password: String(pw || "")
      });
    },

    /* ---------------- 绑定关系 ---------------- */

    bound: function () {
      const b = readLocalJSON(BIND_KEY);
      return (b && this.isValidCode(b.code)) ? String(b.code) : null;
    },
    bind: function (code) {
      try { localStorage.setItem(BIND_KEY, JSON.stringify({ code: String(code) })); } catch (e) {}
    },
    unbind: function () {
      const code = this.bound();
      try { localStorage.removeItem(BIND_KEY); } catch (e) {}
      if (code) this.forgetPassword(code);
      lastSyncTs = 0;
      lastError = null;
    },

    /* ---------------- 会话内密码（sessionStorage） ---------------- */

    rememberPassword: function (code, pw) {
      const all = readJSON(PW_KEY);
      if (pw) all[String(code)] = String(pw);
      else delete all[String(code)];
      try { sessionStorage.setItem(PW_KEY, JSON.stringify(all)); } catch (e) {}
    },
    forgetPassword: function (code) {
      const all = readJSON(PW_KEY);
      delete all[String(code)];
      try { sessionStorage.setItem(PW_KEY, JSON.stringify(all)); } catch (e) {}
    },
    passwordFor: function (code) {
      const all = readJSON(PW_KEY);
      return all[String(code)] || "";
    },

    /* ---------------- 同步 ---------------- */

    // 读本地最新存档并上传到绑定码；自动保存周期调用，串行 + 合并并发
    uploadCurrent: function () {
      const code = this.bound();
      if (!code) return Promise.resolve(false);
      if (syncing) { queued = true; return Promise.resolve(true); }
      syncing = true;
      const done = function (v) {
        syncing = false;
        if (queued) {
          queued = false;
          CloudSave.uploadCurrent().catch(function () {});
        }
        return v;
      };
      return global.SaveSystem.raw().then(function (raw) {
        if (!raw) throw makeErr("no_local");
        return CloudSave.put(code, CloudSave.passwordFor(code), raw);
      }).then(function (j) {
        lastSyncTs = (j && j.ts) || Date.now();
        lastError = null;
        return done(true);
      }).catch(function (e) {
        done(false);
        if (unloading) return false;   // 页面跳转/关闭中止请求：非失败，不提示不记录
        lastError = e;
        console.warn("[Cloud] 云同步失败：", e.message);
        throw e;
      });
    },

    // 绑定首次上传等直接 put 成功后，由 UI 层调用以刷新同步状态
    markSynced: function (ts) {
      lastSyncTs = ts || Date.now();
      lastError = null;
    },

    status: function () {
      return {
        code: this.bound(),
        syncing: syncing,
        lastSyncTs: lastSyncTs,
        lastError: lastError
      };
    }
  };

  global.CloudSave = CloudSave;
})(window);
