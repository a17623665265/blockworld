/* ============================================================
 * chest.js —— 储物箱面板（8x10 = 80 格，按方块坐标独立存储）
 *
 * 打开方式：准星对准储物箱右键（mod 交互钩子调 Chest.openAt）。
 * 规则：
 *  - 每个坐标位的储物箱内容独立；关闭面板内容留在原地
 *  - 挖掉储物箱：箱内每堆物品在箱子位置掉为世界掉落物（走近磁吸入包，背包满留在地上不丢失）
 *  - 物品搬移与熔炉面板一致：左键整堆 / 右键放一个或取半
 *  - 存档：全部箱子的内容写入存档 chests 字段（"x,y,z" -> 80 格数组）
 * ============================================================ */
(function (global) {
  "use strict";

  const COLS = 8, ROWS = 10, SLOTS = COLS * ROWS;   // 80 格储物
  const INV_SLOTS = 9;

  const Chest = {
    onCloseRequest: null,
    onOpenRequest: null,   // game.js 注入：打开面板时切换游戏状态
    onToast: null,

    init(opts) {
      this.overlayEl = opts.overlayEl;
      this.gridEl = opts.gridEl;
      this.invEl = opts.invEl;
      this.atlasUrl = opts.atlasCanvas.toDataURL();
      this.itemIcons = opts.itemIcons;
      this.blockIcons = opts.blockIcons || {};

      // 全部储物箱内容："x,y,z" -> Array(80) of {id,count,dur}|null
      this.stores = {};
      this.cur = null;        // 当前打开的箱子 key
      this.curStacks = null;  // 当前箱子的 80 格数组（stores[key] 的引用）

      // 80 格储物槽
      this.gridEl.innerHTML = "";
      for (let i = 0; i < SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "40";
        slot.dataset.loc = "ch:" + i;
        this.gridEl.appendChild(slot);
      }
      // 9 格物品栏
      this.invEl.innerHTML = "";
      for (let i = 0; i < INV_SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = "cv:" + i;
        this.invEl.appendChild(slot);
      }
      this.bindEvents();
    },

    isOpen() { return !this.overlayEl.classList.contains("hidden"); },

    // 由 mod 交互钩子调用（右键储物箱）
    openAt(x, y, z) {
      this.cur = x + "," + y + "," + z;
      if (!this.stores[this.cur]) {
        this.stores[this.cur] = new Array(SLOTS).fill(null);
      }
      this.curStacks = this.stores[this.cur];
      if (this.onOpenRequest) this.onOpenRequest();
    },

    // 由 game.js 在切完状态后调用：真正显示面板
    show() {
      this.overlayEl.classList.remove("hidden");
      this.renderAll();
    },

    // 关闭：内容留在箱子里（stores 持久），光标物品退回背包
    hide() {
      this.overlayEl.classList.add("hidden");
      this.cur = null;
      this.curStacks = null;
      if (Crafting.cursor) {
        const c = Crafting.cursor;
        Crafting.addItem(c.id, c.count, c.dur);
        Crafting.cursor = null;
        Crafting.updateDrag();
      }
    },

    /* ---------------- 破坏 / 掉落 ---------------- */

    // 挖掉储物箱：每一堆物品在箱子位置生成一个世界掉落物（整堆数量 / 工具耐久保留），
    // 走近自动磁吸入包；背包满时全部留在地上（掉落物保留 5 分钟），腾出格子再捡，绝不丢失。
    // spawnDrop(id,count,dur) 由 game.js 破坏钩子注入；缺省时回退全局 Mobs。
    // 返回掉出的物堆数。
    breakAt(x, y, z, spawnDrop, toastFn) {
      const key = x + "," + y + "," + z;
      const stacks = this.stores[key];
      if (!stacks) return 0;
      const tell = toastFn || this.onToast;
      const drop = spawnDrop || function (id, n, dur) {
        if (window.Mobs && window.Mobs.spawnBlockDrop) {
          window.Mobs.spawnBlockDrop(id, x, y, z, { count: n, dur: dur });
        }
      };
      let piles = 0;
      for (const s of stacks) {
        if (!s) continue;
        drop(s.id, s.count, s.dur == null ? null : s.dur);
        piles++;
      }
      delete this.stores[key];
      if (piles > 0 && tell) tell("储物箱内 " + piles + " 堆物品掉落在地");
      return piles;
    },

    /* ---------------- 存档 ---------------- */

    serialize() {
      const out = {};
      for (const key in this.stores) {
        const stacks = this.stores[key];
        if (!stacks || stacks.every(s => !s)) continue;   // 空箱不存档
        out[key] = stacks.map(s => s ? { id: s.id, count: s.count, dur: s.dur, ammo: s.ammo } : null);
      }
      return out;
    },

    restore(data) {
      this.stores = {};
      if (!data) return;
      for (const key in data) {
        const arr = new Array(SLOTS).fill(null);
        const src = data[key];
        if (Array.isArray(src)) {
          for (let i = 0; i < Math.min(src.length, SLOTS); i++) {
            const s = src[i];
            if (s && typeof s.id === "number" && s.count > 0) {
              arr[i] = { id: s.id, count: Math.floor(s.count) };
              if (s.dur != null) arr[i].dur = s.dur;
              if (s.ammo != null) arr[i].ammo = Math.max(0, s.ammo | 0);
            }
          }
        }
        this.stores[key] = arr;
      }
    },

    /* ---------------- 槽位渲染 ---------------- */

    applyIcon(el, id) {
      if (this.blockIcons[id]) {
        el.style.backgroundImage = "url(" + this.blockIcons[id] + ")";
        el.style.backgroundSize = "contain";
        el.style.backgroundPosition = "center";
      } else if (id >= 100) {
        el.style.backgroundImage = "url(" + this.itemIcons[id] + ")";
        el.style.backgroundSize = "contain";
        el.style.backgroundPosition = "center";
      } else {
        const tile = BLOCK_TILES[id][1];
        const col = tile % ATLAS_COLS;
        const row = Math.floor(tile / ATLAS_COLS);
        const px = el.dataset.px || 48;
        el.style.backgroundImage = "url(" + this.atlasUrl + ")";
        el.style.backgroundSize = (px * ATLAS_COLS) + "px " + (px * ATLAS_ROWS) + "px";
        el.style.backgroundPosition = (-col * px) + "px " + (-row * px) + "px";
      }
      el.title = getItemName(id);
    },

    fillSlot(el, stack) {
      el.innerHTML = "";
      el.style.backgroundImage = "";
      if (!stack) { el.title = ""; return; }
      this.applyIcon(el, stack.id);
      if (stack.count > 1) {
        const cnt = document.createElement("span");
        cnt.className = "cnt";
        cnt.textContent = stack.count;
        el.appendChild(cnt);
      }
    },

    renderAll() {
      const stacks = this.curStacks || [];
      for (let i = 0; i < SLOTS; i++) {
        if (this.gridEl.children[i]) this.fillSlot(this.gridEl.children[i], stacks[i]);
      }
      for (let i = 0; i < INV_SLOTS; i++) {
        if (this.invEl.children[i]) {
          Crafting.fillSlotEl(this.invEl.children[i], Crafting.inventory[i]);
        }
      }
      Crafting.updateDrag();
    },

    /* ---------------- 槽位搬移（规则与 Furnace 一致） ---------------- */

    // loc -> {get(), set(v)}；ch:i 储物箱 / cv:i 背包
    locAccess(loc) {
      let m = /^ch:(\d+)$/.exec(loc);
      if (m) {
        const i = parseInt(m[1], 10);
        if (!this.curStacks || i < 0 || i >= SLOTS) return null;
        const arr = this.curStacks;
        return { get: () => arr[i], set: v => { arr[i] = v; } };
      }
      m = /^cv:(\d+)$/.exec(loc);
      if (m) {
        const i = parseInt(m[1], 10);
        if (i < 0 || i >= INV_SLOTS) return null;
        return { get: () => Crafting.inventory[i], set: v => { Crafting.inventory[i] = v; } };
      }
      return null;
    },

    // 左键：拿起整堆 / 放下 / 合并 / 交换
    clickLoc(loc) {
      const acc = this.locAccess(loc);
      if (!acc) return;
      const cur = acc.get();
      const cursor = Crafting.cursor;
      if (!cursor) {
        if (cur) { Crafting.cursor = cur; acc.set(null); }
      } else if (!cur) {
        acc.set(cursor); Crafting.cursor = null;
      } else if (cur.id === cursor.id) {
        const room = maxStackOf(cur.id) - cur.count;
        const move = Math.min(room, cursor.count);
        if (move > 0) {
          cur.count += move;
          cursor.count -= move;
          if (cursor.count <= 0) Crafting.cursor = null;
        }
      } else {
        acc.set(cursor); Crafting.cursor = cur;
      }
      this.renderAll();
    },

    // 右键：空手取半；持物放一个
    rightClickLoc(loc) {
      const acc = this.locAccess(loc);
      if (!acc) return;
      const cur = acc.get();
      const cursor = Crafting.cursor;
      if (!cursor) {
        if (cur) {
          const half = Math.ceil(cur.count / 2);
          Crafting.cursor = { id: cur.id, count: half, dur: cur.dur };
          cur.count -= half;
          if (cur.count <= 0) acc.set(null);
        }
      } else if (!cur) {
        acc.set(Crafting.makeStack(cursor.id, 1, cursor.dur));
        cursor.count--;
        if (cursor.count <= 0) Crafting.cursor = null;
      } else if (cur.id === cursor.id && cur.count < maxStackOf(cur.id)) {
        cur.count++;
        cursor.count--;
        if (cursor.count <= 0) Crafting.cursor = null;
      }
      this.renderAll();
    },

    bindEvents() {
      this.overlayEl.addEventListener("mousedown", (e) => {
        const slotEl = e.target.closest ? e.target.closest("[data-loc]") : null;
        if (!slotEl) return;
        e.preventDefault();
        if (e.button === 2) this.rightClickLoc(slotEl.dataset.loc);
        else if (e.button === 0) this.clickLoc(slotEl.dataset.loc);
      });
      this.overlayEl.addEventListener("contextmenu", (e) => e.preventDefault());
      this.overlayEl.querySelector("#ch-close").addEventListener("click", () => {
        if (this.onCloseRequest) this.onCloseRequest();
      });
    }
  };

  global.Chest = Chest;
})(window);
