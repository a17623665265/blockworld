/* ============================================================
 * save.js — 本地存档系统（IndexedDB + RLE 压缩 + 滚动备份）
 *
 * 无限世界（v4）存档模型：
 *   - 地形全部可由 seed 确定性重建，存档只保存玩家改动过的“脏区块”，
 *     每块 16×16×48=12288 字节体素 + 256 字节高度图 + 256 字节群系图。
 *   - chunks: [{cx,cz,d:Uint8Array(12288),hm:Uint8Array(256),bm:Uint8Array(256)}]
 *   - 每条数组在 IndexedDB 记录里各自做 RLE 压缩；探索过但没改动的
 *     地形不占任何存档空间，存档体积只与“挖/放了多少区块”成正比。
 *
 * v3 及更早是 256×256 有限世界的全量 blocks 档，与无限世界模型不兼容，
 * 打开新版时旧库整体作废重建（onupgradeneeded 删 store）。
 *
 * 崩溃安全策略沿用旧版：
 *   - IndexedDB 事务保证记录完整落盘，两阶段 stage→current 提交，
 *     current 损坏时依次尝试 stage 残留 → backup_<ts>。
 *   - navigator.storage.persist() 请求持久化授权。
 *   - IndexedDB 不可用时回退 localStorage（chunks 转 base64）。
 *
 * 对外接口全部 Promise 化（除标记外）：
 *   SaveSystem.load()   → Promise<snapshot|null>   snapshot.chunks 为解码后的数组
 *   SaveSystem.save(s)  → Promise<boolean>         snapshot.chunks 为 Uint8Array 数组
 *   SaveSystem.has()    → Promise<boolean>
 *   SaveSystem.clear()  → Promise
 *   SaveSystem.raw()    → Promise<jsonString|null> 导出文件用（chunk 字节为 base64）
 *   SaveSystem.info()   → Promise<{ts,tamedCount,backups,persistent}|null>
 * ============================================================ */
(function (global) {
  "use strict";

  const LEGACY_KEY = "blockworld_save_v4";   // localStorage 降级档 key
  const DB_NAME = "blockworld";
  const DB_VERSION = 3;
  const STORE = "saves";
  const VERSION = 4;
  const CHUNK_VOL = 16 * 16 * 48;            // 每区块体素数（须与 world.js CH 一致）
  const CHUNK_FLAT = 16 * 16;                // 高度图/群系图长度
  const BACKUP_KEEP = 2;                     // 除 current 外保留的历史备份数
  const OPEN_TIMEOUT = 3000;

  /* ---------------- RLE 压缩（tag 字节方案） ----------------
   * tag 高位为 1：[0x80|(count-3), value]，value 连续重复 3~130 次
   * tag 高位为 0：[len, b1..b_len]，原样拷贝 1~127 个字节
   * 最坏情况输出 ≤ n + ceil(n/127) 字节，体素数据通常只有原大小的 5%~20%
   * --------------------------------------------------------- */

  function rleEncode(src) {
    const n = src.length;
    const cap = n + (((n + 126) / 127) | 0) + 2;
    const buf = new Uint8Array(cap);
    let p = 0;          // 写指针
    let lp = 0;         // 字面段起点
    const flushLit = function (end) {
      while (lp < end) {
        const len = Math.min(127, end - lp);
        buf[p++] = len;
        buf.set(src.subarray(lp, lp + len), p);
        p += len;
        lp += len;
      }
    };
    let i = 0;
    while (i < n) {
      const v = src[i];
      let r = 1;
      while (r < 130 && i + r < n && src[i + r] === v) r++;
      if (r >= 3) {
        flushLit(i);
        let left = r;
        while (left > 0) {
          const part = Math.min(130, left);
          buf[p++] = 0x80 | (part - 3);
          buf[p++] = v;
          left -= part;
        }
        i += r;
        lp = i;
      } else {
        i++;
        if (i - lp >= 127) flushLit(i);
      }
    }
    flushLit(n);
    return buf.slice(0, p);
  }

  function rleDecode(src, expectLen) {
    const out = new Uint8Array(expectLen);
    let p = 0, i = 0;
    while (i < src.length) {
      const tag = src[i++];
      if (tag & 0x80) {
        const count = (tag & 0x7f) + 3;
        if (i >= src.length) throw new Error("RLE 数据截断");
        const v = src[i++];
        if (p + count > expectLen) throw new Error("RLE 长度上溢");
        out.fill(v, p, p + count);
        p += count;
      } else if (tag > 0) {
        if (i + tag > src.length) throw new Error("RLE 字面段截断");
        out.set(src.subarray(i, i + tag), p);
        i += tag;
        p += tag;
      } else {
        throw new Error("RLE 非法 tag(0)");
      }
    }
    if (p !== expectLen) throw new Error("RLE 长度不匹配");
    return out;
  }

  /* ---------------- base64（旧档迁移 / 导出文件用） ---------------- */

  function bytesToB64(bytes) {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- 脏区块编解码 ----------------
   * 存档记录里的压缩形态：{cx,cz,dLen,d:RLE,hm:RLE,bm:RLE}
   * 内存/快照形态：        {cx,cz,d:Uint8Array(12288),hm,bm:Uint8Array(256)}
   * --------------------------------------------------------- */

  function encodeChunks(chunks) {
    const out = [];
    if (!Array.isArray(chunks)) return out;
    for (const c of chunks) {
      if (!c || !(c.d instanceof Uint8Array) || c.d.length !== CHUNK_VOL) continue;
      const e = {
        cx: c.cx | 0, cz: c.cz | 0, dLen: CHUNK_VOL,
        d: rleEncode(c.d),
        hm: (c.hm instanceof Uint8Array && c.hm.length === CHUNK_FLAT)
              ? rleEncode(c.hm) : rleEncode(new Uint8Array(CHUNK_FLAT)),
        bm: (c.bm instanceof Uint8Array && c.bm.length === CHUNK_FLAT)
              ? rleEncode(c.bm) : rleEncode(new Uint8Array(CHUNK_FLAT))
      };
      out.push(e);
    }
    return out;
  }

  // 解码一条记录的全部区块；任一条损坏则整个存档判失败（返回 null）
  function decodeChunks(rec) {
    if (!Array.isArray(rec.chunks)) return null;
    const out = [];
    for (const e of rec.chunks) {
      if (!e || e.dLen !== CHUNK_VOL ||
          !(e.d instanceof Uint8Array) || !(e.hm instanceof Uint8Array) ||
          !(e.bm instanceof Uint8Array)) return null;
      const d = rleDecode(e.d, CHUNK_VOL);
      const hm = rleDecode(e.hm, CHUNK_FLAT);
      const bm = rleDecode(e.bm, CHUNK_FLAT);
      out.push({ cx: e.cx | 0, cz: e.cz | 0, d: d, hm: hm, bm: bm });
    }
    return out;
  }

  // localStorage / 导出文件用：区块数组 ↔ base64 JSON
  function chunksToB64(chunks) {
    return chunks.map(function (c) {
      return { cx: c.cx, cz: c.cz,
               d: bytesToB64(c.d), hm: bytesToB64(c.hm), bm: bytesToB64(c.bm) };
    });
  }

  function chunksFromB64(arr) {
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const c of arr) {
      if (!c || typeof c.d !== "string") return null;
      const d = b64ToBytes(c.d), hm = b64ToBytes(c.hm), bm = b64ToBytes(c.bm);
      if (d.length !== CHUNK_VOL || hm.length !== CHUNK_FLAT || bm.length !== CHUNK_FLAT) return null;
      out.push({ cx: c.cx | 0, cz: c.cz | 0, d: d, hm: hm, bm: bm });
    }
    return out;
  }

  /* ---------------- 归一化（老档缺字段兜底） ---------------- */

  function normalize(s) {
    s = s || {};
    const piece = p =>
      (p && typeof p.id === "number" && p.count > 0) ? { id: p.id, count: 1 } : null;
    const ar = s.armor || {};
    // 皮革背包内容：9 格 {id,count,dur}|null，旧存档无此字段即空数组
    const bag = Array.isArray(s.bag)
      ? s.bag.slice(0, 9).map(b =>
          (b && typeof b.id === "number" && b.count > 0)
            ? Object.assign({ id: b.id, count: Math.floor(b.count) }, (b.dur != null ? { dur: b.dur } : {}))
            : null)
      : [];
    // 储物箱内容：{"x,y,z": [80 格 {id,count,dur}|null]}，旧存档无此字段即空对象
    const chests = {};
    if (s.chests && typeof s.chests === "object") {
      for (const key in s.chests) {
        const src = s.chests[key];
        if (!Array.isArray(src)) continue;
        const arr = src.slice(0, 80).map(b =>
          (b && typeof b.id === "number" && b.count > 0)
            ? Object.assign({ id: b.id, count: Math.floor(b.count) }, (b.dur != null ? { dur: b.dur } : {}))
            : null);
        if (arr.some(b => b)) chests[key] = arr;   // 全空的不存
      }
    }
    return {
      v: VERSION,
      ts: s.ts || 0,
      creative: !!s.creative,   // 无敌模式随存档持久化
      seed: s.seed || 20261008,
      player: Object.assign({ x: 0.5, y: 30, z: 0.5, yaw: 0, pitch: 0, hp: 20 }, s.player),
      inventory: Array.isArray(s.inventory) ? s.inventory.slice(0, 9) : [],
      selected: s.selected | 0,
      armor: { head: piece(ar.head), chest: piece(ar.chest), legs: piece(ar.legs), back: piece(ar.back) },
      bag: bag,
      chests: chests,
      tamed: Array.isArray(s.tamed) ? s.tamed : [],
      boss: s.boss && typeof s.boss === "object" ? s.boss : null,
      // 内存形态的脏区块（Uint8Array 数组）；存档记录里是 RLE 形态，由 decodeRecord 换入
      chunks: Array.isArray(s.chunks) ? s.chunks : []
    };
  }

  /* ---------------- IndexedDB 封装 ---------------- */

  let dbPromise = null;
  let persistent = null;   // null=未知，true/false=持久化授权结果

  function openDB() {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (db) {
        if (done) return;
        done = true;
        resolve(db);
      };
      if (!global.indexedDB) { finish(null); return; }
      let req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        finish(null);
        return;
      }
      req.onupgradeneeded = function () {
        const db = req.result;
        // v1 开发版曾漏配 keyPath（out-of-line store 无法按 slot 存取），
        // 升级时删除旧 store 重建；正式版用户都从 v2 起步，无历史数据损失
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: "slot" });
      };
      req.onsuccess = function () {
        const db = req.result;
        db.onversionchange = function () { db.close(); };
        finish(db);
      };
      req.onerror = function () {
        console.warn("[Save] IndexedDB 打开失败，回退 localStorage：", req.error);
        finish(null);
      };
      req.onblocked = function () { finish(null); };
      // 个别浏览器 file:// 下 IDB 可能一直不回调，给个兜底超时
      setTimeout(function () { finish(null); }, OPEN_TIMEOUT);
    });
  }

  function getDB() {
    if (!dbPromise) {
      dbPromise = openDB().then(function (db) {
        if (db) requestPersist();
        return db;
      });
    }
    return dbPromise;
  }

  function requestPersist() {
    try {
      const storage = navigator.storage;
      if (!storage || typeof storage.persist !== "function") return;
      storage.persisted().then(function (already) {
        if (already) { persistent = true; return; }
        storage.persist().then(function (granted) {
          persistent = !!granted;
          console.log("[Save] 持久化存储授权：" + (granted ? "已获得（浏览器不会自动清理存档）"
                                                           : "未获得（浏览器存储空间紧张时仍可能清理）"));
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  function idbReq(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // 在一个事务里执行 fn(os)（可为 async）；事务完整提交后 resolve 为 fn 的返回值
  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      let t;
      try {
        t = db.transaction(STORE, mode);
      } catch (e) { reject(e); return; }
      let result;
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
      // 注意：必须把 fn 的返回值（通常是 idbReq 的 Promise）透传给 result，
      // 否则 oncomplete 时 resolve 的是 undefined
      Promise.resolve(fn(t.objectStore(STORE), function (r) { result = r; }))
        .then(function (v) { if (v !== undefined) result = v; },
              function (e) { try { t.abort(); } catch (_) {} reject(e); });
    });
  }

  const isSlot = function (k, prefix) {
    return typeof k === "string" && k.indexOf(prefix) === 0;
  };
  const slotTs = function (k) {
    const n = +k.slice(k.indexOf("_") + 1);
    return isFinite(n) ? n : 0;
  };

  // 解码并校验一条记录；失败返回 null（绝不抛异常）
  function decodeRecord(rec) {
    try {
      if (!rec || typeof rec !== "object") return null;
      if (rec.v < VERSION) return null;               // v3 及更早的有限世界档一律不认
      const chunks = decodeChunks(rec);
      if (!chunks) return null;
      const snap = normalize(rec);
      snap.chunks = chunks;
      return snap;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- localStorage 降级档（IDB 不可用时使用） ---------------- */

  const legacy = {
    load() {
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || s.v < VERSION || !Array.isArray(s.chunks)) return null;
        const chunks = chunksFromB64(s.chunks);
        if (!chunks) return null;
        const snap = normalize(s);
        snap.chunks = chunks;
        return snap;
      } catch (e) {
        console.warn("[Save] localStorage 档读取失败：", e);
        return null;
      }
    },
    // snapshot.chunks 为内存形态（Uint8Array）；落 localStorage 转 base64
    save(snapshot) {
      const data = normalize(Object.assign({ v: VERSION, ts: Date.now() }, snapshot));
      try {
        data.chunks = chunksToB64(data.chunks || []);
        localStorage.setItem(LEGACY_KEY, JSON.stringify(data));
        return true;
      } catch (e) {
        console.warn("[Save] localStorage 写入失败：", e);
        return false;
      }
    },
    has() {
      try { return !!localStorage.getItem(LEGACY_KEY); } catch (e) { return false; }
    },
    clear() {
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
    },
    info() {
      const s = this.load();
      if (!s) return null;
      return { ts: s.ts, tamedCount: s.tamed.length, backups: 0, persistent: false, legacy: true };
    },
    raw() {
      try {
        const s = this.load();
        if (!s) return null;
        return JSON.stringify({
          v: s.v, ts: s.ts, creative: s.creative, seed: s.seed, chunks: chunksToB64(s.chunks),
          player: s.player, inventory: s.inventory, selected: s.selected,
          armor: s.armor, bag: s.bag, chests: s.chests, tamed: s.tamed, boss: s.boss
        });
      } catch (e) { return null; }
    }
  };

  /* ---------------- 主接口 ---------------- */

  let saveChain = Promise.resolve();   // 保存串行化，避免并发乱序

  const SaveSystem = {
    VERSION: VERSION,

    // 读取存档：current → stage 残留 → backup（新→旧）→ localStorage 降级档
    load() {
      return getDB().then(function (db) {
        if (!db) return legacy.load();

        return tx(db, "readonly", function (os) { return idbReq(os.getAllKeys()); })
          .then(function (keys) {
            const stages = keys.filter(k => isSlot(k, "stage_")).map(slotTs)
              .sort(function (a, b) { return b - a; });
            const backups = keys.filter(k => isSlot(k, "backup_")).map(slotTs)
              .sort(function (a, b) { return b - a; });
            const candidates = ["current"]
              .concat(stages.map(t => "stage_" + t))
              .concat(backups.map(t => "backup_" + t));

            const tryNext = function (idx) {
              if (idx >= candidates.length) return Promise.resolve(null);
              const key = candidates[idx];
              return tx(db, "readonly", function (os) { return idbReq(os.get(key)); })
                .then(function (rec) {
                  const snap = decodeRecord(rec);
                  if (snap) return { snap: snap, key: key };
                  return tryNext(idx + 1);
                });
            };
            return tryNext(0).then(function (hit) {
              if (!hit) return legacy.load();
              if (hit.key === "current") return hit.snap;
              // 用备份/残留恢复：提升为 current（坏 current 一并覆盖）。
              // 重新编码在事务外完成，put/delete 在同一同步事务内发出
              console.warn("[Save] current 不可用，已从 " + hit.key + " 恢复存档");
              const isStage = isSlot(hit.key, "stage_");
              const meta = normalize(Object.assign({}, hit.snap));
              const newRec = Object.assign({}, meta, {
                slot: "current",
                chunks: encodeChunks(hit.snap.chunks)
              });
              return tx(db, "readwrite", function (os) {
                os.put(newRec);
                if (isStage) os.delete(hit.key);   // stage 提升后删残留；backup 保留继续当备份
              }).then(function () { return hit.snap; });
            });
          })
          .catch(function (e) {
            console.warn("[Save] IndexedDB 读取异常，回退 localStorage：", e);
            return legacy.load();
          });
      });
    },

    // 写入；成功 true，失败 false。保存按调用顺序串行提交。
    // snapshot.chunks 为脏区块数组（可为空数组：只存玩家状态）
    save(snapshot) {
      const chunks = snapshot && snapshot.chunks;
      if (!Array.isArray(chunks)) {
        return Promise.reject(new Error("save: chunks 必须是数组（可为空）"));
      }
      const job = saveChain.then(function () { return SaveSystem._write(snapshot); });
      saveChain = job.then(function () {}, function () {});
      return job;
    },

    _write(snapshot) {
      const meta = normalize(Object.assign({ v: VERSION, ts: Date.now() }, snapshot));
      // IDB 记录存 RLE 形态；内存 Uint8Array 形态不直接放进记录
      const encChunks = encodeChunks(meta.chunks);
      return getDB().then(function (db) {
        if (!db) return legacy.save(snapshot);

        const ts = meta.ts;
        const stageKey = "stage_" + ts;
        const stageRec = Object.assign({}, meta, {
          slot: stageKey,
          chunks: encChunks
        });

        // 阶段 1：stage 落盘
        return tx(db, "readwrite", function (os) { return idbReq(os.put(stageRec)); })
          .then(function () {
            // 阶段 2：立即读回校验，确认压缩数据完整
            return tx(db, "readonly", function (os) { return idbReq(os.get(stageKey)); });
          })
          .then(function (got) {
            if (!decodeRecord(got)) throw new Error("stage 读回校验失败");
            // 阶段 3：事务外先读齐 keys / 旧 current（IDB 事务在连续 await
            // 多个请求后会失活，写请求必须在同一个同步回调里全部发出）
            return Promise.all([
              tx(db, "readonly", function (os) { return idbReq(os.getAllKeys()); }),
              tx(db, "readonly", function (os) { return idbReq(os.get("current")); })
            ]).then(function (pair) {
              const keys = pair[0] || [];
              const cur = pair[1];
              const backupTs = keys.filter(k => isSlot(k, "backup_")).map(slotTs);
              if (cur && cur.ts) backupTs.push(slotTs("backup_" + cur.ts));
              const keep = new Set(
                backupTs.sort(function (a, b) { return b - a; }).slice(0, BACKUP_KEEP));
              const oldAsBackup = (cur && cur.ts)
                ? Object.assign({}, cur, { slot: "backup_" + cur.ts }) : null;
              const newCurrent = Object.assign({}, stageRec, { slot: "current" });
              // 单事务内同步发出全部变更：事务提交要么全成要么全败
              return tx(db, "readwrite", function (os) {
                keys.forEach(function (k) {
                  if (isSlot(k, "backup_") && !keep.has(slotTs(k))) {
                    os.delete(k);
                  } else if (isSlot(k, "stage_") && k !== stageKey) {
                    os.delete(k);
                  }
                });
                if (oldAsBackup) os.put(oldAsBackup);
                os.put(newCurrent);
                os.delete(stageKey);
              });
            });
          })
          .then(function () { return true; })
          .catch(function (e) {
            console.warn("[Save] IndexedDB 写入失败：", e);
            // IDB 临时故障（如磁盘满）时最后再试一次 localStorage，保命
            try {
              if (legacy.save(snapshot)) return true;
            } catch (_) {}
            return false;
          });
      });
    },

    has() {
      return getDB().then(function (db) {
        if (!db) return legacy.has();
        return tx(db, "readonly", function (os) { return idbReq(os.getAllKeys()); })
          .then(function (keys) {
            if (keys.some(k => k === "current" || isSlot(k, "backup_") || isSlot(k, "stage_"))) {
              return true;
            }
            try { return !!localStorage.getItem(LEGACY_KEY); } catch (e) { return false; }
          })
          .catch(function () { return legacy.has(); });
      });
    },

    // 清空所有档位（current / backup / stage）及老档
    clear() {
      return getDB().then(function (db) {
        try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
        if (!db) { legacy.clear(); return; }
        // 单请求清空整个 store（不能在事务里 await getAllKeys 后再逐个删，
        // 连续 await 会让事务失活）
        return tx(db, "readwrite", function (os) { os.clear(); }).catch(function () {});
      });
    },

    // 导出文件用：脏区块转 base64（v4 格式）
    raw() {
      return this.load().then(function (s) {
        if (!s) return null;
        return JSON.stringify({
          v: s.v, ts: s.ts, creative: s.creative, seed: s.seed,
          chunks: chunksToB64(s.chunks),
          player: s.player, inventory: s.inventory, selected: s.selected,
          armor: s.armor, bag: s.bag, chests: s.chests, tamed: s.tamed, boss: s.boss
        });
      });
    },

    // 导入云端/导出文件的原始 JSON 字符串（chunks 为 base64，与 raw() 格式一致），
    // 校验后写入本地 IndexedDB
    importRaw(rawStr) {
      let s = null;
      try { s = JSON.parse(rawStr); } catch (e) { return Promise.reject(new Error("bad_raw")); }
      if (!s || s.v < VERSION || !Array.isArray(s.chunks)) return Promise.reject(new Error("bad_raw"));
      let chunks;
      try { chunks = chunksFromB64(s.chunks); } catch (e) { return Promise.reject(new Error("bad_raw")); }
      if (!chunks) return Promise.reject(new Error("bad_raw"));
      return SaveSystem.save({
        ts: s.ts || Date.now(),
        creative: !!s.creative,
        seed: s.seed,
        chunks: chunks,
        player: s.player,
        inventory: s.inventory,
        selected: s.selected,
        armor: s.armor,
        bag: s.bag,
        chests: s.chests,
        tamed: s.tamed,
        boss: s.boss
      });
    },

    // 存档概要（菜单“上次保存时间”）；轻量读取，不解压方块
    info() {
      return getDB().then(function (db) {
        if (!db) return legacy.info();
        // keys 与 current 用两个独立只读事务并行读（同一事务内连续 await
        // 多个请求会导致事务失活）
        return Promise.all([
          tx(db, "readonly", function (os) { return idbReq(os.getAllKeys()); }),
          tx(db, "readonly", function (os) { return idbReq(os.get("current")); })
        ]).then(function (pair) {
          const keys = pair[0] || [];
          const cur = pair[1];
          const backups = keys.filter(k => isSlot(k, "backup_")).length;
          if (cur && cur.ts) {
            return {
              ts: cur.ts,
              tamedCount: Array.isArray(cur.tamed) ? cur.tamed.length : 0,
              backups: backups,
              persistent: persistent
            };
          }
          // current 缺失但存在可恢复备份时也视为有档
          if (keys.some(k => isSlot(k, "backup_") || isSlot(k, "stage_"))) {
            const newest = keys.filter(k => isSlot(k, "backup_") || isSlot(k, "stage_"))
              .map(slotTs).sort(function (a, b) { return b - a; })[0];
            return { ts: newest, tamedCount: 0, backups: backups, persistent: persistent, recovering: true };
          }
          try { return localStorage.getItem(LEGACY_KEY) ? legacy.info() : null; } catch (e) { return null; }
        }).catch(function () { return legacy.info(); });
      });
    },

    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
    rleEncode: rleEncode,
    rleDecode: rleDecode
  };

  global.SaveSystem = SaveSystem;
})(window);
