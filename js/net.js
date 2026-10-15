/* ============================================================
 * net.js — 局域网双人联机传输层
 *
 * 职责（不含任何玩法逻辑）：
 *   1. 房间信令：HTTP 短轮询 /signal/* （serve.ps1 中继）
 *   2. WebRTC 直连：RTCPeerConnection + 两条 DataChannel
 *        ch-r 可靠有序（RPC/世界数据）
 *        ch-u 不可靠无序（位置/实体快照）
 *   3. 可靠通道大消息自动分块/重组（上层透明）
 *   4. 连接状态机、心跳延迟、断线检测
 *   5. 房间/连接 UI 面板（#net-overlay）与游戏内角标（#net-status）
 *
 * 对外：window.Net
 *   Net.host() / Net.join(code) / Net.leave()
 *   Net.send(obj) 可靠 / Net.sendU(obj) 不可靠
 *   Net.on(type, fn)：open | message | unreliable | close | status | progress
 *   Net.active() / Net.isHost() / Net.isGuest() / Net.connected()
 *   Net.code() / Net.latency()
 *   Net.setLoss(pct) / Net.setLatency(ms)  弱网注入（测试）
 *
 * 内部协议消息 type 一律以 '$' 开头（$ping-rtt/$pong-rtt/$c），不抛给上层。
 * ============================================================ */
(function (global) {
  "use strict";

  const POLL_MS = 800;            // 信令短轮询间隔
  const CONNECT_TIMEOUT = 180000; // TEMP-TEST: 建连总超时（headless 高负载，测完恢复 35000）
  const CHUNK_MAX = 12000;        // 可靠通道单条消息分片阈值（字符数）
  const HEARTBEAT_MS = 2500;      // 心跳间隔
  const DEAD_AFTER = 1800000;     // TEMP-TEST: 1800s 无 pong 判死（headless 客人世界重建长冻结，测完恢复 7500）
  const ICE_GATHER_WAIT = 3000;   // vanilla ICE 等待 candidate 收集的兜底
  const DEAD_GRACE = 1800000;     // TEMP-TEST: ICE disconnected 宽限 1800s（测完恢复 5000）
  const STUN = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" }
  ];

  let role = null;                // 'host' | 'guest' | null
  let pc = null;
  let chR = null, chU = null;
  let roomCode = "";
  let pollTimer = 0;
  let state = "idle";             // idle|signaling|connecting|connected|closed
  let lastLatency = -1;
  let heartbeatTimer = 0;
  let lastPongAt = 0;
  let deadTimer = 0;
  let connectTimer = 0;
  let stopped = false;            // leave() 主动关闭，不产生错误回调
  let closeNotified = false;      // close 事件已发出（fail/leave 去重）

  // 弱网模拟
  let simLatency = 0;
  let simLoss = 0;

  const listeners = { open: [], message: [], unreliable: [], close: [], status: [], hoststart: [] };

  // 分块重组
  let chunkSeq = 0;
  const recvChunks = new Map();   // id -> { n, parts: string[] }

  function emit(type, data) {
    const fns = listeners[type];
    if (!fns) return;
    for (const fn of fns) {
      try { fn(data); } catch (e) { console.error("[Net] listener", type, e); }
    }
  }

  function setState(s, label) {
    state = s;
    setPanelStatus(label || "");
    emit("status", { state: s, label: label || "" });
  }

  /* ---------------- HTTP 信令 ---------------- */

  function post(path, obj) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj || {})
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.ok) {
          const err = new Error(j.error || ("http_" + r.status));
          err.code = j.error || ("http_" + r.status);
          throw err;
        }
        return j;
      });
    });
  }

  function signalSend(who, msgString) {
    return post("/signal/send", { code: roomCode, who: who, msg: msgString }).catch(function (e) {
      console.warn("[Net] signal send failed:", e.message);
    });
  }

  function startPolling(who) {
    stopPolling();
    const tick = function () {
      if (stopped || !roomCode) return;
      fetch("/signal/poll?code=" + encodeURIComponent(roomCode) + "&who=" + who, { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (stopped) return;
          if (j && j.ok && Array.isArray(j.msgs)) j.msgs.forEach(handleSignalMessage);
        })
        .catch(function () { /* 单轮失败静默重试 */ });
      pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, 100);
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
  }

  /* ---------------- WebRTC ---------------- */

  function createPC() {
    const c = new RTCPeerConnection({ iceServers: STUN });
    c.oniceconnectionstatechange = function () {
      const s = c.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (deadTimer) { clearTimeout(deadTimer); deadTimer = 0; }
      } else if (s === "disconnected") {
        if (!deadTimer) deadTimer = setTimeout(function () { fail("连接中断，网络不稳定"); }, DEAD_GRACE);
      } else if (s === "failed") {
        fail("直连失败：请确认两台设备在同一 WiFi 下");
      }
    };
    return c;
  }

  // 非 trickle ICE：等 candidate 收集完再一次性交换 SDP（局域网几百毫秒）
  function waitGathered(c) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(c.localDescription); } };
      if (c.iceGatheringState === "complete") { finish(); return; }
      const onChange = function () {
        if (c.iceGatheringState === "complete") {
          c.removeEventListener("icegatheringstatechange", onChange);
          finish();
        }
      };
      c.addEventListener("icegatheringstatechange", onChange);
      setTimeout(finish, ICE_GATHER_WAIT);
    });
  }

  function onUnreliableText(data) {
    let obj = null;
    try { obj = JSON.parse(data); } catch (err) { return; }
    emit("unreliable", obj);
  }
  function wireReliable() {
    chR.onopen = function () { onConnected(); };
    chR.onclose = function () { onClosed(); };
    chR.onerror = function (e) { console.warn("[Net] reliable channel error", e); };
    chR.onmessage = function (e) { onReliableText(e.data); };
    // 远程通道可能在事件绑定前就已 open（同机双标签等极快建连场景）
    if (chR.readyState === "open") onConnected();
  }
  function wireUnreliable() {
    chU.onmessage = function (e) { onUnreliableText(e.data); };
  }

  function createHost() {
    role = "host";
    pc = createPC();
    chR = pc.createDataChannel("ch-r", { ordered: true });
    chU = pc.createDataChannel("ch-u", { ordered: false, maxRetransmits: 0 });
    wireReliable();
    wireUnreliable();

    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      return waitGathered(pc);
    }).then(function () {
      return signalSend("host", JSON.stringify({
        t: "sdp", sdp: pc.localDescription.sdp, kind: pc.localDescription.type
      }));
    }).catch(function (e) {
      fail("创建连接失败：" + e.message);
    });
  }

  function createGuest() {
    role = "guest";
    pc = createPC();
    pc.ondatachannel = function (ev) {
      // 每个通道到达即绑定，不等待另一条（避免 open 事件早于绑定时错过）
      if (ev.channel.label === "ch-r") { chR = ev.channel; wireReliable(); }
      else if (ev.channel.label === "ch-u") { chU = ev.channel; wireUnreliable(); }
    };
  }

  function handleSignalMessage(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg) return;

    // 客人的第一声招呼：房主开始建连（此刻才启动 35s 建连超时）
    if (msg.t === "hi" && role === "host" && state === "signaling") {
      setState("connecting", "对方已加入，正在建立直连…");
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = setTimeout(function () {
        if (state !== "connected") fail("连接超时：直连建立失败，请取消后重试");
      }, CONNECT_TIMEOUT);
      createHost();
      return;
    }
    // 房主 offer -> 客人 answer
    if (msg.t === "sdp" && role === "guest") {
      if (state !== "connecting" && state !== "signaling") return;
      setState("connecting", "正在建立直连…");
      if (!pc) createGuest();
      pc.setRemoteDescription({ type: msg.kind || "offer", sdp: msg.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer); })
        .then(function () { return waitGathered(pc); })
        .then(function () {
          return signalSend("guest", JSON.stringify({
            t: "sdp", sdp: pc.localDescription.sdp, kind: pc.localDescription.type
          }));
        })
        .catch(function (e) { fail("应答连接失败：" + e.message); });
      return;
    }
    // 客人 answer -> 房主
    if (msg.t === "sdp" && role === "host" && pc && pc.signalingState !== "stable") {
      pc.setRemoteDescription({ type: msg.kind || "answer", sdp: msg.sdp })
        .catch(function (e) { fail("连接应答失败：" + e.message); });
    }
  }

  /* ---------------- 发送（分块/弱网注入） ---------------- */

  function rawSend(channel, str) {
    if (!channel || channel.readyState !== "open") return false;
    try { channel.send(str); return true; }
    catch (e) { console.warn("[Net] send failed:", e && e.message); return false; }
  }

  function pipeSend(channel, str, unreliable) {
    if (simLoss > 0 && unreliable && Math.random() * 100 < simLoss) return;
    if (simLatency > 0) setTimeout(function () { rawSend(channel, str); }, simLatency);
    else rawSend(channel, str);
  }

  function dispatch(obj) {
    if (!obj) return;
    if (obj.t === "$ping-rtt") {
      pipeSend(chR, JSON.stringify({ t: "$pong-rtt" }), false);
      return;
    }
    if (obj.t === "$pong-rtt") {
      lastPongAt = Date.now();
      if (rttPending) { rttPending = false; lastLatency = Date.now() - pingSentAt; }
      return;
    }
    emit("message", obj);
  }

  function onReliableText(text) {
    let head = null;
    try { head = JSON.parse(text); } catch (e) { return; }
    if (head && head.t === "$c") {
      let buf = recvChunks.get(head.id);
      if (!buf) { buf = { n: head.n, parts: new Array(head.n) }; recvChunks.set(head.id, buf); }
      buf.parts[head.i] = head.p;
      for (let i = 0; i < buf.n; i++) { if (buf.parts[i] === undefined) return; }
      recvChunks.delete(head.id);
      let obj = null;
      try { obj = JSON.parse(buf.parts.join("")); } catch (e) { return; }
      dispatch(obj);
      return;
    }
    dispatch(head);
  }

  /* ---------------- 连接生命周期 ---------------- */

  // 心跳 + RTT：发送方计时，pong 回来在 dispatch 中求差
  let pingSentAt = 0;
  let rttPending = false;
  function stopTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
    rttPending = false;
  }
  function startTimers() {
    stopTimers();
    lastPongAt = Date.now();
    rttPending = false;
    heartbeatTimer = setInterval(function () {
      if (state !== "connected") return;
      if (!rttPending) {
        rttPending = true;
        pingSentAt = Date.now();
        pipeSend(chR, JSON.stringify({ t: "$ping-rtt" }), false);
      }
      if (Date.now() - lastPongAt > DEAD_AFTER) fail("与对方的连接已断开");
    }, HEARTBEAT_MS);
  }

  function onConnected() {
    if (state === "connected") return;
    setState("connected", "已连接");
    stopPolling();
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = 0; }
    lastLatency = 0;
    showNetStatus();
    startTimers();
    emit("open", { role: role, code: roomCode });
  }

  function onClosed() {
    if (state === "closed" || state === "idle") return;
    fail("对方已断开连接");
  }

  function fail(reason) {
    if (stopped || state === "closed" || state === "idle") return;
    cleanup(false);
    hideNetStatus();
    showNetError(reason);
    if (!closeNotified) { closeNotified = true; emit("close", { intentional: false, reason: reason }); }
  }

  function cleanup(intentional) {
    state = "closed";
    stopped = true;
    stopPolling();
    stopTimers();
    if (deadTimer) { clearTimeout(deadTimer); deadTimer = 0; }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = 0; }
    try { if (chR) chR.close(); } catch (e) {}
    try { if (chU) chU.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    chR = null; chU = null; pc = null;
    recvChunks.clear();
  }

  /* ---------------- UI ---------------- */

  let overlayEl = null, statusEl = null;

  function ui() {
    if (!overlayEl) {
      overlayEl = document.getElementById("net-overlay");
      statusEl = document.getElementById("net-status");
    }
    return overlayEl;
  }
  function showPanel(page) {
    const ov = ui();
    if (!ov) return;
    ov.classList.remove("hidden");
    ov.querySelectorAll("[data-page]").forEach(function (el) {
      el.classList.toggle("hidden", el.getAttribute("data-page") !== page);
    });
  }
  function hidePanel() { if (overlayEl) overlayEl.classList.add("hidden"); }
  function setTransfer(on) {
    if (overlayEl) overlayEl.classList.toggle("net-transfer", !!on);
  }
  function setPanelStatus(text) {
    const el = document.getElementById("net-progress-text");
    if (el && text) el.textContent = text;
  }
  function showNetError(text) {
    const ov = ui();
    if (!ov) return;
    ov.querySelector("[data-page='error'] .net-error-text").textContent = text || "连接失败";
    showPanel("error");
  }
  function showNetStatus() { if (statusEl) statusEl.classList.remove("hidden"); }
  function hideNetStatus() { if (statusEl) statusEl.classList.add("hidden"); }
  function renderStatus() {
    if (!statusEl || state !== "connected") return;
    const ms = lastLatency >= 0 ? lastLatency : "–";
    statusEl.textContent = (role === "host" ? "房主 · " : "已连接 · ") + ms + "ms";
  }

  function bindUI() {
    ui();
    const multiBtn = document.getElementById("multi-btn");
    if (multiBtn) multiBtn.addEventListener("click", function () { multiBtn.blur(); Net.openMenu(); });
    if (!overlayEl) return;
    const click = function (sel, fn) {
      const el = overlayEl.querySelector(sel);
      if (el) el.addEventListener("click", function () { el.blur(); fn(); });
    };
    click("[data-act='host']", function () { Net.host(); });
    click("[data-act='host-new']", function () {
      // 重新进入页面并以“随机新世界”身份开房（game.js 启动时处理 ?host=new）
      location.href = location.pathname + "?host=new&t=" + Date.now();
    });
    click("[data-act='join-pick']", function () { showPanel("join"); });
    click("[data-act='join-go']", function () {
      const input = document.getElementById("net-code-input");
      Net.join(input ? input.value : "");
    });
    click("[data-act='back']", function () {
      if (state !== "idle" && state !== "connected") Net.leave();
      else hidePanel();
    });
    click("[data-act='cancel']", function () { Net.leave(); });
    click("[data-act='host-start']", function () { emit("hoststart", {}); });
    click("[data-act='error-back']", function () { Net.leave(); showPanel("pick"); });
    const input = document.getElementById("net-code-input");
    if (input) {
      input.addEventListener("input", function () {
        input.value = input.value.replace(/\D/g, "").slice(0, 6);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") Net.join(input.value);
      });
    }
    setInterval(renderStatus, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindUI);
  else bindUI();

  /* ---------------- 对外 API ---------------- */

  const Net = {
    openMenu: function () {
      if (state !== "idle" && state !== "closed") return;
      showPanel("pick");
    },
    closeMenu: function () {
      if (state === "idle" || state === "closed") hidePanel();
    },

    host: function () {
      if (state !== "idle" && state !== "closed") return Promise.reject(new Error("busy"));
      if (typeof RTCPeerConnection === "undefined") {
        showNetError("当前浏览器不支持 WebRTC，无法联机");
        return Promise.reject(new Error("no_webrtc"));
      }
      stopped = false;
      closeNotified = false;
      role = "host";
      roomCode = "";
      setState("signaling", "正在创建房间…");
      showPanel("wait");
      return post("/signal/host", {}).then(function (j) {
        if (stopped) return;
        roomCode = j.code;
        // 等待对方念码/输入阶段不设 35s 建连炸弹（家人输入房号常超过 35s，
        // 误杀会表现为房主页莫名“连接超时”）；建连超时改在收到 hi 时启动。
        // 房间本身有服务端 15 分钟 TTL，玩家也可随时点“取消”主动离开。
        const codeEl = document.getElementById("net-room-code");
        if (codeEl) codeEl.textContent = roomCode;
        const codeGoEl = document.getElementById("net-room-code-go");
        if (codeGoEl) codeGoEl.textContent = roomCode;
        setState("signaling", "等待对方加入…");
        startPolling("host");
        return roomCode;
      }).catch(function (e) {
        cleanup(true);
        showNetError("无法连接服务器：" + e.message + "（请用 http:// 局域网地址打开游戏）");
        throw e;
      });
    },

    join: function (code) {
      code = String(code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        showNetError("请输入 6 位房间码");
        return Promise.reject(new Error("bad_code"));
      }
      if (typeof RTCPeerConnection === "undefined") {
        showNetError("当前浏览器不支持 WebRTC，无法联机");
        return Promise.reject(new Error("no_webrtc"));
      }
      stopped = false;
      closeNotified = false;
      role = "guest";
      roomCode = code;
      setState("signaling", "正在加入房间…");
      showPanel("wait");
      return post("/signal/join", { code: code }).then(function () {
        if (stopped) return;
        connectTimer = setTimeout(function () {
          if (state !== "connected") fail("连接超时：请核对房间码并确认双方在同一 WiFi");
        }, CONNECT_TIMEOUT);
        createGuest();
        startPolling("guest");
        setState("connecting", "已加入房间，正在建立直连…");
        return signalSend("guest", JSON.stringify({ t: "hi" }));
      }).catch(function (e) {
        cleanup(true);
        if (e && e.code === "room_full") showNetError("房间已有一名玩家（本游戏仅支持 2 人）");
        else if (e && e.code === "room_not_found") showNetError("房间不存在或已过期，请核对房间码");
        else showNetError("加入失败：" + e.message);
        throw e;
      });
    },

    leave: function () {
      const wasActive = state !== "idle";
      stopped = true;
      cleanup(true);
      role = null;
      roomCode = "";
      state = "idle";
      lastLatency = -1;
      hideNetStatus();
      hidePanel();
      if (wasActive && !closeNotified) emit("close", { intentional: true });
      closeNotified = false;
    },

    send: function (obj) {
      if (state !== "connected") return false;
      const str = JSON.stringify(obj);
      if (str.length <= CHUNK_MAX) { pipeSend(chR, str, false); return true; }
      const id = ++chunkSeq;
      const n = Math.ceil(str.length / CHUNK_MAX);
      for (let i = 0; i < n; i++) {
        const piece = str.substr(i * CHUNK_MAX, CHUNK_MAX);
        pipeSend(chR, JSON.stringify({ t: "$c", id: id, i: i, n: n, p: piece }), false);
      }
      return true;
    },
    sendU: function (obj) {
      if (state !== "connected" || !chU || chU.readyState !== "open") return false;
      pipeSend(chU, JSON.stringify(obj), true);
      return true;
    },

    on: function (type, fn) {
      if (!listeners[type]) return function () {};
      listeners[type].push(fn);
      return function () {
        const i = listeners[type].indexOf(fn);
        if (i >= 0) listeners[type].splice(i, 1);
      };
    },

    active: function () { return state === "connected"; },
    connected: function () { return state === "connected"; },
    isHost: function () { return state === "connected" && role === "host"; },
    isGuest: function () { return state === "connected" && role === "guest"; },
    role: function () { return state === "connected" ? role : null; },
    code: function () { return roomCode; },
    latency: function () { return lastLatency; },

    // 玩法层切换房间面板页（如客人加载完成后的「开始游戏」页）
    showPage: function (name) { showPanel(name); },

    // 世界握手阶段更新面板（percent 0-100）；握手完成后由调用方 hideProgress()
    progress: function (text, percent) {
      const bar = document.getElementById("net-progress-bar");
      setPanelStatus(text || "");
      if (bar) bar.style.width = Math.max(0, Math.min(100, percent || 0)) + "%";
      setTransfer(true);
    },
    hideProgress: function () { setTransfer(false); hidePanel(); },
    // 玩法层收到 end 等协议拒绝时直接弹错误面板
    showError: function (text) { showNetError(text); },
    hideOverlay: function () { setTransfer(false); hidePanel(); },

    setLoss: function (pct) { simLoss = Math.max(0, Math.min(100, pct | 0)); },
    setLatency: function (ms) { simLatency = Math.max(0, ms | 0); },

    debug: {
      state: function () {
        return { state: state, role: role, code: roomCode, rtt: lastLatency,
                 chR: chR ? chR.readyState : null, chU: chU ? chU.readyState : null,
                 loss: simLoss, latency: simLatency };
      },
      hostAuto: function () { return Net.host(); },
      joinAuto: function (code) { return Net.join(code); }
    }
  };

  global.Net = Net;
})(window);
