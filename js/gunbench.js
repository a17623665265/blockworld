/* ============================================================
 * gunbench.js —— 枪械工作台面板（3x3 专属合成）
 *
 * 打开方式：准星对准枪械工作台右键（gun_mod.js 交互钩子）。
 * 规则：
 *  - 与普通工作台同布局：3×3 材料格 + 箭头 + 产物格 + 9 格物品栏
 *  - 配方表独立（GunBench.addRecipe），枪械 / 弹药只能在这里做，
 *    普通工作台的合成表不含火器配方
 *  - 材料放入网格即时预览产物，左键产物格完成一次合成并消耗材料
 *  - 物品搬移规则与熔炉面板一致：左键整堆 / 右键放一个或取半
 *  - 关闭面板：网格内材料自动退回物品栏，光标抓着的物品也退回
 * ============================================================ */
(function (global) {
  "use strict";

  const GRID_N = 9;     // 3×3
  const INV_SLOTS = 9;  // 热键栏 9 格

  // 把 3×3（或更小）矩阵裁剪为最小包围矩形，空矩阵返回 null
  function normalize(rows) {
    let r0 = -1, r1 = -1, c0 = 99, c1 = -1;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c]) {
          if (r0 < 0) r0 = r;
          r1 = r;
          if (c < c0) c0 = c;
          if (c > c1) c1 = c;
        }
      }
    }
    if (r0 < 0) return null;
    const out = [];
    for (let r = r0; r <= r1; r++) {
      out.push(rows[r].slice(c0, c1 + 1));
    }
    return out;
  }

  function sameShape(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let r = 0; r < a.length; r++) {
      if (a[r].length !== b[r].length) return false;
      for (let c = 0; c < a[r].length; c++) {
        if (a[r][c] !== b[r][c]) return false;
      }
    }
    return true;
  }

  const GunBench = {
    onCloseRequest: null,
    onToast: null,

    // 独立枪械配方表：{pattern:[[id|0,...],...], out:{id,count}}
    recipes: [],

    // 供后续弹药 / 枪械阶段注册配方
    addRecipe(pattern, outId, count) {
      this.recipes.push({
        pattern: pattern.map(function (row) { return row.slice(); }),
        norm: normalize(pattern),
        out: { id: outId, count: count || 1 }
      });
    },

    init(opts) {
      this.overlayEl = opts.overlayEl;
      this.gridEl = opts.gridEl;
      this.outEl = opts.outEl;
      this.invEl = opts.invEl;
      this.atlasUrl = opts.atlasCanvas.toDataURL();
      this.itemIcons = opts.itemIcons;
      this.blockIcons = opts.blockIcons || {};

      // 3×3 材料格
      this.grid = new Array(GRID_N).fill(null);
      this.preview = null;   // 当前网格匹配出的产物 {id,count} | null
      this.gridEl.innerHTML = "";
      for (let i = 0; i < GRID_N; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = "gg:" + i;
        this.gridEl.appendChild(slot);
      }
      this.outEl.dataset.loc = "go";
      // 9 格物品栏
      this.invEl.innerHTML = "";
      for (let i = 0; i < INV_SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = "gi:" + i;
        this.invEl.appendChild(slot);
      }
      this.bindEvents();
    },

    isOpen() { return !this.overlayEl.classList.contains("hidden"); },

    // 由 gun_mod.js 交互钩子 / game.js 调试钩子调用
    open() {
      if (this.onOpenRequest) this.onOpenRequest();
    },

    // 由 game.js 在切完状态后调用：真正显示面板
    show() {
      // 每次打开都是一份干净网格（材料关闭时退回，不做台内暂存）
      this.grid = new Array(GRID_N).fill(null);
      this.preview = null;
      this.overlayEl.classList.remove("hidden");
      this.renderAll();
    },

    // 关闭：网格材料与光标物品全部退回物品栏
    hide() {
      for (let i = 0; i < GRID_N; i++) {
        const s = this.grid[i];
        if (s) {
          Crafting.addItem(s.id, s.count, s.dur);
          this.grid[i] = null;
        }
      }
      this.preview = null;
      if (Crafting.cursor) {
        Crafting.addItem(Crafting.cursor.id, Crafting.cursor.count, Crafting.cursor.dur);
        Crafting.cursor = null;
      }
      this.overlayEl.classList.add("hidden");
      Crafting.updateDrag();
    },

    /* ---------------- 配方匹配 ---------------- */

    // 读网格 -> 3×3 id 矩阵 -> 裁剪后与独立配方表比对
    recompute() {
      const rows = [[], [], []];
      for (let i = 0; i < GRID_N; i++) {
        const s = this.grid[i];
        rows[Math.floor(i / 3)][i % 3] = s ? s.id : 0;
      }
      const shape = normalize(rows);
      this.preview = null;
      if (shape) {
        for (const rec of this.recipes) {
          if (sameShape(shape, rec.norm)) {
            this.preview = { id: rec.out.id, count: rec.out.count };
            break;
          }
        }
      }
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
      for (let i = 0; i < GRID_N; i++) {
        this.fillSlot(this.gridEl.children[i], this.grid[i]);
      }
      this.fillSlot(this.outEl, this.preview);
      for (let i = 0; i < INV_SLOTS; i++) {
        if (this.invEl.children[i]) {
          // 直接复用 Crafting 的渲染（含工具耐久条）
          Crafting.fillSlotEl(this.invEl.children[i], Crafting.inventory[i]);
        }
      }
      Crafting.updateDrag();
    },

    /* ---------------- 槽位搬移（规则与熔炉一致） ---------------- */

    locAccess(loc) {
      let m = /^gg:(\d+)$/.exec(loc);
      if (m) {
        const i = parseInt(m[1], 10);
        if (i < 0 || i >= GRID_N) return null;
        return {
          get: () => this.grid[i],
          set: v => { this.grid[i] = v; }
        };
      }
      m = /^gi:(\d+)$/.exec(loc);
      if (m) {
        const i = parseInt(m[1], 10);
        if (i < 0 || i >= INV_SLOTS) return null;
        return {
          get: () => Crafting.inventory[i],
          set: v => { Crafting.inventory[i] = v; }
        };
      }
      return null;
    },

    // 左键：产物格合成；材料/背包格拿起整堆 / 放下 / 合并 / 交换
    clickLoc(loc) {
      if (loc === "go") { this.craft(); return; }
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
      this.recompute();
      this.renderAll();
    },

    // 右键：空手取半；持物放一个
    rightClickLoc(loc) {
      if (loc === "go") return;
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
      this.recompute();
      this.renderAll();
    },

    // 左键产物格：按预览合成一次（每种材料消耗 1 件）
    craft() {
      if (!this.preview) return;
      const out = this.preview;
      const cursor = Crafting.cursor;
      if (cursor && (cursor.id !== out.id ||
          cursor.count + out.count > maxStackOf(out.id))) return;
      if (!cursor && !Crafting.roomFor(out.id, out.count)) {
        if (this.onToast) this.onToast("物品栏已满，无法取出成品");
        return;
      }
      // 消耗网格中每格 1 件（匹配已保证形状与材料正确）
      for (let i = 0; i < GRID_N; i++) {
        const s = this.grid[i];
        if (s) {
          s.count--;
          if (s.count <= 0) this.grid[i] = null;
        }
      }
      if (cursor) cursor.count += out.count;
      else Crafting.addItem(out.id, out.count);
      this.recompute();
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
      this.overlayEl.querySelector("#gb-close").addEventListener("click", () => {
        if (this.onCloseRequest) this.onCloseRequest();
      });
    }
  };

  global.GunBench = GunBench;
})(window);
