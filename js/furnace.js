/* ============================================================
 * furnace.js —— 熔炉烧炼系统（独立面板模块）
 *
 * 打开方式：准星对准熔炉右键（所有熔炉共享同一个炉膛内容，
 * 关闭面板时槽内物品自动退回背包，不会丢失）。
 *
 * 规则：
 *  - 原料：粗铁 -> 铁锭；煤矿石 -> 煤
 *  - 燃料（每件可烧物品数）：木棍 1、木板 1、原木 2、煤 8
 *  - 每件原料烧炼 SMELT_TIME 秒；火焰燃烧期间持续推进
 *  - 物品搬移与合成面板一致：左键整堆 / 右键放一个或取半
 *  - 光标物品与 9 格背包直接复用 Crafting 的数据
 * ============================================================ */
(function (global) {
  "use strict";

  const SLOTS = 9;
  const SMELT_TIME = 8;   // 每件原料烧炼秒数

  // 烧炼配方：原料 id -> 产物
  const SMELT_RECIPES = {};
  SMELT_RECIPES[ITEM.RAW_IRON]  = { id: ITEM.IRON_INGOT, count: 1 };
  SMELT_RECIPES[BLOCK.COAL_ORE] = { id: ITEM.COAL, count: 1 };

  // 燃料：每件燃料可烧炼的物品数
  const FUEL_VALUE = {};
  FUEL_VALUE[ITEM.STICK] = 1;
  FUEL_VALUE[BLOCK.PLANKS] = 1;
  FUEL_VALUE[BLOCK.LOG] = 2;
  FUEL_VALUE[BLOCK.BIRCH_LOG] = 2;
  FUEL_VALUE[ITEM.COAL] = 8;

  // 合并 mod 动态注册的烧炼配方与燃料（mod 脚本先于本文件加载）
  for (const id in GameRegistry.smelts) SMELT_RECIPES[id] = GameRegistry.smelts[id];
  for (const id in GameRegistry.fuels) FUEL_VALUE[id] = GameRegistry.fuels[id];

  const Furnace = {
    onCloseRequest: null,

    init(opts) {
      this.overlayEl = opts.overlayEl;
      this.inEl = opts.inEl;
      this.fuelEl = opts.fuelEl;
      this.outEl = opts.outEl;
      this.fireEl = opts.fireEl;
      this.arrowEl = opts.arrowEl;
      this.invEl = opts.invEl;
      this.atlasUrl = opts.atlasCanvas.toDataURL();
      this.itemIcons = opts.itemIcons;
      this.blockIcons = opts.blockIcons || {};

      // 三个静态槽补上 data-loc，bindEvents 的 [data-loc] 委托才能点中
      //（与 gunbench.js 给 outEl 赋 "go" 同一模式，否则三槽永远点不中）
      this.inEl.dataset.loc = "fi";
      this.fuelEl.dataset.loc = "ff";
      this.outEl.dataset.loc = "fo";

      // 炉膛内容（全局单例，任意熔炉共用）
      this.st = { in: null, fuel: null, out: null, burn: 0, burnMax: 0, prog: 0 };

      this.invEl.innerHTML = "";
      for (let i = 0; i < SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = "fv:" + i;
        this.invEl.appendChild(slot);
      }
      this.bindEvents();
    },

    isOpen() { return !this.overlayEl.classList.contains("hidden"); },

    show() {
      this.overlayEl.classList.remove("hidden");
      this.renderAll();
    },

    // 关闭并把炉膛内所有物品退回背包
    hide() {
      const s = this.st;
      if (s.in) { Crafting.addItem(s.in.id, s.in.count, s.in.dur); s.in = null; }
      if (s.fuel) { Crafting.addItem(s.fuel.id, s.fuel.count, s.fuel.dur); s.fuel = null; }
      if (s.out) { Crafting.addItem(s.out.id, s.out.count, s.out.dur); s.out = null; }
      s.burn = 0; s.burnMax = 0; s.prog = 0;
      // 光标若还拿着东西也放回背包
      if (Crafting.cursor) {
        Crafting.addItem(Crafting.cursor.id, Crafting.cursor.count, Crafting.cursor.dur);
        Crafting.cursor = null;
      }
      this.overlayEl.classList.add("hidden");
      Crafting.updateDrag();
    },

    /* ---------------- 烧炼运转（每帧） ---------------- */

    tick(dt) {
      if (!this.isOpen()) return;
      const s = this.st;
      const recipe = s.in ? SMELT_RECIPES[s.in.id] : null;
      const canOutput = recipe &&
        (!s.out || (s.out.id === recipe.id && s.out.count + recipe.count <= maxStackOf(recipe.id)));
      const fuelVal = s.fuel ? FUEL_VALUE[s.fuel.id] : 0;

      // 余火耗尽且还能继续烧 -> 投入一件燃料点火
      if (s.burn <= 0 && canOutput && fuelVal > 0) {
        s.burnMax = fuelVal * SMELT_TIME;
        s.burn = s.burnMax;
        s.fuel.count--;
        if (s.fuel.count <= 0) s.fuel = null;
        this.renderAll();
      }

      if (s.burn > 0 && canOutput) {
        s.burn = Math.max(0, s.burn - dt);
        s.prog += dt;
        if (s.prog >= SMELT_TIME) {
          s.prog = 0;
          // 消耗原料
          s.in.count--;
          if (s.in.count <= 0) s.in = null;
          // 产出
          if (s.out && s.out.id === recipe.id) s.out.count += recipe.count;
          else s.out = { id: recipe.id, count: recipe.count };
          this.renderAll();
        }
      } else {
        // 无法继续时进度缓慢回退
        s.prog = Math.max(0, s.prog - dt * 2);
      }
      this.renderMeters();
    },

    /* ---------------- UI 渲染 ---------------- */

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
      this.fillSlot(this.inEl, this.st.in);
      this.fillSlot(this.fuelEl, this.st.fuel);
      this.fillSlot(this.outEl, this.st.out);
      for (let i = 0; i < SLOTS; i++) {
        if (this.invEl.children[i]) {
          // 直接复用 Crafting 的渲染（含工具耐久条）
          Crafting.fillSlotEl(this.invEl.children[i], Crafting.inventory[i]);
        }
      }
      this.renderMeters();
      Crafting.updateDrag();
    },

    renderMeters() {
      const s = this.st;
      const burning = s.burn > 0;
      this.fireEl.classList.toggle("on", burning);
      this.fireEl.style.height = burning ? Math.max(0.12, s.burn / s.burnMax) * 100 + "%" : "0%";
      this.arrowEl.style.width = Math.min(1, s.prog / SMELT_TIME) * 100 + "%";
    },

    /* ---------------- 槽位搬移（规则与 Crafting 一致） ---------------- */

    // loc -> {get(), set(v)}；fi 原料 / ff 燃料 / fo 产物 / fv:i 背包
    locAccess(loc) {
      if (loc === "fi") return { get: () => this.st.in, set: v => { this.st.in = v; } };
      if (loc === "ff") return { get: () => this.st.fuel, set: v => { this.st.fuel = v; } };
      if (loc === "fo") return { get: () => this.st.out, set: v => { this.st.out = v; } };
      const m = /^fv:(\d+)$/.exec(loc);
      if (m) {
        const i = parseInt(m[1], 10);
        if (i < 0 || i >= SLOTS) return null;
        return { get: () => Crafting.inventory[i], set: v => { Crafting.inventory[i] = v; } };
      }
      return null;
    },

    // 左键：拿起整堆 / 放下 / 合并 / 交换
    clickLoc(loc) {
      if (loc === "fo") { this.takeOut(); return; }
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
      if (loc === "fo") return;
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

    // 左键产物槽：取走烧好的物品（光标可合并 -> 光标；否则进背包）
    takeOut() {
      const out = this.st.out;
      if (!out) return;
      const cursor = Crafting.cursor;
      if (cursor && (cursor.id !== out.id ||
          cursor.count + out.count > maxStackOf(out.id))) return;
      if (!cursor && !Crafting.roomFor(out.id, out.count)) return;
      if (cursor) {
        cursor.count += out.count;
      } else {
        Crafting.addItem(out.id, out.count, out.dur);
      }
      this.st.out = null;
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
      this.overlayEl.querySelector("#fu-close").addEventListener("click", () => {
        if (this.onCloseRequest) this.onCloseRequest();
      });
    }
  };

  global.Furnace = Furnace;
})(window);
