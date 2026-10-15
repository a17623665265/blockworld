/* ============================================================
 * crafting.js — 物品库存 + 合成配方 + 合成面板 UI
 *
 * 合成规则：有形配方(shaped)。取出合成格内所有物品的包围盒，
 * 归一化为矩阵后与配方逐格比对（支持在网格中任意平移摆放）。
 *
 * 库存交互：左键单击 —— 拿起整堆 / 放下 / 同类合并 / 异类交换；
 *           点击输出格 —— 消耗材料并取走产物。
 * ============================================================ */
(function (global) {
  "use strict";

  const SLOTS = 9;          // 物品栏格数
  const BAG_SLOTS = 9;      // 皮革背包提供的额外格数
  const P = BLOCK.PLANKS, L = BLOCK.LOG, C = BLOCK.COBBLE,
        S = ITEM.STICK, W = ITEM.WOOL, COAL = ITEM.COAL, H = ITEM.LEATHER,
        IRON = ITEM.IRON_INGOT;

  // 装备部位（顺序即装备槽自上而下：帽 / 衣 / 裤 / 背包）
  const ARMOR_SLOTS = ["head", "chest", "legs", "back"];
  const ARMOR_GHOST = { head: "帽", chest: "衣", legs: "裤", back: "包" };

  // 配方表（0 表示该位置必须为空）
  const RECIPES = [
    { pattern: [[L]],                              output: { id: BLOCK.PLANKS, count: 4 } },
    // 白桦原木 → 白桦木板 ×4 的配方由 furniture_mod 动态注册
    { pattern: [[P, P], [P, P]],                   output: { id: BLOCK.CRAFTING_TABLE, count: 1 } },
    { pattern: [[P], [P]],                         output: { id: ITEM.STICK, count: 4 } },
    { pattern: [[P, P, P], [0, S, 0], [0, S, 0]],  output: { id: ITEM.WOOD_PICKAXE, count: 1 } },
    { pattern: [[C, C, C], [0, S, 0], [0, S, 0]],  output: { id: ITEM.STONE_PICKAXE, count: 1 } },
    // —— 铁镐：3 铁锭横排 + 2 木棍，强于石镐 ——
    { pattern: [[IRON, IRON, IRON], [0, S, 0], [0, S, 0]], output: { id: ITEM.IRON_PICKAXE, count: 1 } },
    // —— 木斧：两木板叠在木棍左上（砍树极快），仅工作台 3×3 ——
    { pattern: [[P, P], [P, S], [0, S]],            output: { id: ITEM.WOOD_AXE, count: 1 } },
    // —— 石斧：圆石版，砍木更快、伤害更高 ——
    { pattern: [[C, C], [C, S], [0, S]],            output: { id: ITEM.STONE_AXE, count: 1 } },
    // —— 铁斧：3 铁锭斧形，强于石斧 ——
    { pattern: [[IRON, IRON], [IRON, S], [0, S]],   output: { id: ITEM.IRON_AXE, count: 1 } },
    { pattern: [[C, C], [C, C]],                   output: { id: BLOCK.STONE_BRICKS, count: 4 } },
    // —— 冶炼 / 照明（熔炉仅工作台；火把 2×2 可做）——
    { pattern: [[C, C, C], [C, 0, C], [C, C, C]],  output: { id: BLOCK.FURNACE, count: 1 } },
    { pattern: [[COAL], [S]],                      output: { id: BLOCK.TORCH, count: 4 } },
    // —— 羊毛护甲（仅工作台 3×3）——
    { pattern: [[W, W, W], [W, 0, W]],             output: { id: ITEM.WOOL_HELMET, count: 1 } },
    { pattern: [[W, 0, W], [W, W, W], [W, W, W]],  output: { id: ITEM.WOOL_CHEST, count: 1 } },
    { pattern: [[W, W, W], [W, 0, W], [W, 0, W]],  output: { id: ITEM.WOOL_LEGS, count: 1 } },
    // —— 皮革背包：8 张皮革围一圈（仅工作台），装备后背包格 +9 ——
    { pattern: [[H, H, H], [H, 0, H], [H, H, H]],  output: { id: ITEM.BACKPACK, count: 1 } }
  ];
  // 合并 mod 动态注册的有序配方（mod 脚本先于本文件加载）
  for (const r of GameRegistry.recipes) RECIPES.push(r);
  // 内置静态物品段：皮革背包固定占用 117（ruby mod 占 115/116），
  // 后续 mod 动态分配物品 ID 从 118 起，避免撞车
  if (GameRegistry.nextItem < 118) GameRegistry.nextItem = 118;

  // 在 size×size 网格中匹配配方，返回 {output, cells} 或 null
  function matchRecipe(grid, size) {
    let minR = 99, maxR = -1, minC = 99, maxC = -1, any = false;
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i]) continue;
      any = true;
      const r = Math.floor(i / size), c = i % size;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    if (!any) return null;
    const h = maxR - minR + 1, w = maxC - minC + 1;

    for (let k = 0; k < RECIPES.length; k++) {
      const rec = RECIPES[k];
      const ph = rec.pattern.length, pw = rec.pattern[0].length;
      if (ph !== h || pw !== w) continue;
      let ok = true;
      const cells = [];
      for (let r = 0; r < h && ok; r++) {
        for (let c = 0; c < w; c++) {
          const want = rec.pattern[r][c] || 0;
          const idx = (minR + r) * size + (minC + c);
          const got = grid[idx];
          const gotId = got ? got.id : 0;
          if (want !== gotId) { ok = false; break; }
          if (want) cells.push(idx);
        }
      }
      if (ok) return { output: rec.output, cells: cells };
    }
    return null;
  }

  const Crafting = {
    SLOTS: SLOTS,
    onCloseRequest: null,

    init(opts) {
      this.hotbarEl = opts.hotbarEl;
      this.overlayEl = opts.overlayEl;
      this.gridEl = opts.gridEl;
      this.outputEl = opts.outputEl;
      this.invEl = opts.invEl;
      this.dragEl = opts.dragEl;
      this.guideEl = opts.guideEl;
      this.toggleEl = opts.toggleEl;
      this.atlasUrl = opts.atlasCanvas.toDataURL();
      this.itemIcons = opts.itemIcons;
      this.blockIcons = opts.blockIcons || {};
      this.creative = !!opts.creative;   // 无敌模式：创造物品栏无限取用

      this.inventory = new Array(SLOTS).fill(null);
      this.selected = 0;
      this.grid2 = new Array(4).fill(null);
      this.grid3 = new Array(9).fill(null);
      this.armor = { head: null, chest: null, legs: null, back: null };
      this.bagSlots = new Array(BAG_SLOTS).fill(null);  // 装备背包后的额外储物格
      this.cursor = null;
      this.mode = "inventory";
      this.currentMatch = null;
      this.guideOpen = true;   // 配方攻略默认展开
      this.onToast = null;     // 提示回调（由 game.js 注入）

      // 人物信息区 DOM
      this.charCanvas = this.overlayEl.querySelector("#char-canvas");
      this.charStatsEl = this.overlayEl.querySelector("#char-stats");
      this.armorEls = {};
      ARMOR_SLOTS.forEach(slotName => {
        this.armorEls[slotName] = this.overlayEl.querySelector('[data-loc="arm:' + slotName + '"]');
      });
      this.bagEl = this.overlayEl.querySelector("#panel-bag");
      this.bagLabelEl = this.overlayEl.querySelector("#bag-label");
      this.creEl = this.overlayEl.querySelector("#creative-grid");
      this.invLabelEl = this.overlayEl.querySelector("#inv-label-main");

      // 初始物品（无敌模式空手进入，所有东西从创造物品栏无限取用）
      if (!this.creative) STARTER_ITEMS.forEach(it => this.addItem(it.id, it.count));

      this.bindEvents();
      this.buildGuide();
      this.buildHotbar();
      this.buildPanelInventory();
      this.buildBagSlots();
      this.buildCreativeGrid();
      this.renderAll();
    },

    // 无敌模式：全部方块 / 物品各一个无限源格（data-loc="cre:<id>"）
    buildCreativeGrid() {
      if (!this.creEl) return;
      this.creEl.innerHTML = "";
      creativeItems().forEach(id => {
        const slot = document.createElement("div");
        slot.className = "cslot cre-slot";
        slot.dataset.px = "44";
        slot.dataset.loc = "cre:" + id;
        // count 传 1：源格只显示图标，不显示堆数 / 耐久
        this.fillSlotEl(slot, { id: id, count: 1 });
        this.creEl.appendChild(slot);
      });
    },

    // 背包当前是否已装备（装备后额外格子才可用）
    hasBag() { return !!this.armor.back; },

    /* ---------------- 库存数据 ---------------- */

    getHeld() { return this.inventory[this.selected]; },
    getHeldId() { const h = this.inventory[this.selected]; return h ? h.id : 0; },

    // 新建一个物品堆（工具自动附带满耐久）
    makeStack(id, count, dur) {
      const s = { id: id, count: count };
      const max = toolDurability(id);
      if (max > 0) s.dur = dur != null ? Math.min(dur, max) : max;
      return s;
    },

    // 向库存放入物品：先合并同类堆，再放空位；装备背包时背包格作为后备空间。
    // 返回实际放入数量
    addItem(id, count, dur) {
      let left = count;
      const pools = this.storagePools();
      for (const arr of pools) {
        for (let i = 0; i < arr.length && left > 0; i++) {
          const s = arr[i];
          if (s && s.id === id) {
            const ms = maxStackOf(id);
            const move = Math.min(ms - s.count, left);
            if (move > 0) { s.count += move; left -= move; }
          }
        }
      }
      for (const arr of pools) {
        for (let i = 0; i < arr.length && left > 0; i++) {
          if (!arr[i]) {
            const move = Math.min(maxStackOf(id), left);
            arr[i] = this.makeStack(id, move, dur);
            left -= move;
          }
        }
      }
      this.renderAll();
      return count - left;
    },

    // 不实际放入，判断背包能否再容纳 count 个 id
    roomFor(id, count) {
      let left = count;
      for (const arr of this.storagePools()) {
        for (let i = 0; i < arr.length && left > 0; i++) {
          const s = arr[i];
          if (s && s.id === id) left -= Math.max(0, maxStackOf(id) - s.count);
          else if (!s) left -= maxStackOf(id);
        }
      }
      return left <= 0;
    },

    // 按优先级返回所有可存放物品的格子数组（物品栏在前，背包格在后）
    storagePools() {
      const pools = [this.inventory];
      if (this.hasBag()) pools.push(this.bagSlots);
      return pools;
    },

    consumeHeld(n) {
      const s = this.inventory[this.selected];
      if (!s) return;
      s.count -= (n || 1);
      if (s.count <= 0) this.inventory[this.selected] = null;
      this.renderAll();
    },

    // 统计全部存储格（物品栏 + 已装备背包）中某物品总数
    countItem(id) {
      let n = 0;
      for (const arr of this.storagePools()) {
        for (const s of arr) { if (s && s.id === id) n += s.count; }
      }
      return n;
    },

    // 从全部存储格中移除 n 个指定物品（先热键栏后背包），返回实际移除数
    consumeItem(id, n) {
      let need = Math.max(0, n | 0);
      for (const arr of this.storagePools()) {
        for (let i = 0; i < arr.length && need > 0; i++) {
          const s = arr[i];
          if (!s || s.id !== id) continue;
          const take = Math.min(need, s.count);
          s.count -= take;
          need -= take;
          if (s.count <= 0) arr[i] = null;
        }
      }
      if (need < n) this.renderAll();
      return n - need;
    },

    // 损耗当前手持工具 n 点耐久；归零则工具损坏消失。返回是否损坏
    damageHeld(n) {
      const s = this.inventory[this.selected];
      if (!s || s.dur == null) return false;
      s.dur -= (n || 1);
      if (s.dur <= 0) {
        const name = getItemName(s.id);
        this.inventory[this.selected] = null;
        this.renderAll();
        this.lastBroken = name;
        return true;
      }
      this.renderAll();
      return false;
    },

    select(i) {
      this.selected = ((i % SLOTS) + SLOTS) % SLOTS;
      this.updateActive();
    },
    selectDelta(d) { this.select(this.selected + d); },

    // 读档：用存档物品栏覆盖当前栏位（stacks 为长度 9 的 {id,count}|null 数组）
    restoreInventory(stacks, selected) {
      this.inventory = new Array(SLOTS).fill(null);
      (stacks || []).forEach((s, i) => {
        if (s && typeof s.id === "number" && s.count > 0 && i < SLOTS) {
          const stack = { id: s.id, count: Math.floor(s.count) };
          if (s.dur != null && toolDurability(s.id) > 0) stack.dur = s.dur;
          // 枪械已装弹药（非工具的自定义堆叠字段，随存档原样恢复）
          if (s.ammo != null) stack.ammo = Math.max(0, s.ammo | 0);
          this.inventory[i] = stack;
        }
      });
      this.cursor = null;
      this.select(selected | 0);
      this.renderAll();
    },

    /* ---------------- 装备 ---------------- */

    // 当前穿戴护甲提供的总防御（半心）
    totalDefense() {
      let d = 0;
      ARMOR_SLOTS.forEach(slotName => {
        const a = this.armor[slotName];
        if (a) d += armorDefenseOf(a.id);
      });
      return d;
    },

    serializeArmor() {
      const out = {};
      ARMOR_SLOTS.forEach(slotName => {
        const a = this.armor[slotName];
        out[slotName] = a ? { id: a.id, count: a.count } : null;
      });
      return out;
    },

    // 读档恢复：校验物品确实是对应部位的护甲，避免脏数据
    restoreArmor(data) {
      ARMOR_SLOTS.forEach(slotName => {
        const p = data && data[slotName];
        if (p && typeof p.id === "number" && armorSlotOf(p.id) === slotName) {
          this.armor[slotName] = { id: p.id, count: 1 };
        } else {
          this.armor[slotName] = null;
        }
      });
      this.renderAll();
    },

    /* ---------------- 皮革背包内容 ---------------- */

    // 背包格是否为空（卸下背包前必须清空）
    bagEmpty() {
      return this.bagSlots.every(s => !s);
    },

    serializeBag() {
      return this.bagSlots.map(s => {
        if (!s) return null;
        const out = { id: s.id, count: s.count };
        if (s.dur != null) out.dur = s.dur;
        return out;
      });
    },

    // 读档恢复背包内容；只有仍装备着背包时才恢复，避免无背包时凭空多出物品
    restoreBag(stacks) {
      this.bagSlots = new Array(BAG_SLOTS).fill(null);
      if (!this.hasBag()) { this.renderAll(); return; }
      (stacks || []).forEach((s, i) => {
        if (s && typeof s.id === "number" && s.count > 0 && i < BAG_SLOTS) {
          const stack = { id: s.id, count: Math.floor(s.count) };
          if (s.dur != null && toolDurability(s.id) > 0) stack.dur = s.dur;
          // 枪械已装弹药（随存档恢复）
          if (s.ammo != null) stack.ammo = Math.max(0, s.ammo | 0);
          this.bagSlots[i] = stack;
        }
      });
      this.renderAll();
    },

    // 联机（Task 5）：客人库存以房主快照为准，整体覆盖本地栏位
    applyNetSnapshot(snap) {
      if (!snap) return;
      this.inventory = new Array(SLOTS).fill(null);
      (snap.inv || []).forEach((s, i) => {
        if (s && typeof s.id === "number" && s.count > 0 && i < SLOTS) {
          const stack = { id: s.id, count: Math.floor(s.count) };
          if (s.dur != null && toolDurability(s.id) > 0) stack.dur = s.dur;
          this.inventory[i] = stack;
        }
      });
      this.armor = { head: null, chest: null, legs: null, back: null };
      ARMOR_SLOTS.forEach(slotName => {
        const p = snap.armor && snap.armor[slotName];
        if (p && typeof p.id === "number" && armorSlotOf(p.id) === slotName) {
          this.armor[slotName] = { id: p.id, count: 1 };
        }
      });
      this.bagSlots = new Array(BAG_SLOTS).fill(null);
      (snap.bag || []).forEach((s, i) => {
        if (s && typeof s.id === "number" && s.count > 0 && i < BAG_SLOTS) {
          const stack = { id: s.id, count: Math.floor(s.count) };
          if (s.dur != null && toolDurability(s.id) > 0) stack.dur = s.dur;
          this.bagSlots[i] = stack;
        }
      });
      this.cursor = null;
      this.select(typeof snap.sel === "number" ? snap.sel : this.selected);
      this.renderAll();
    },

    isOpen() { return !this.overlayEl.classList.contains("hidden"); },

    /* ---------------- 面板开关 ---------------- */

    show(mode) {
      this.mode = mode;
      this.overlayEl.classList.remove("hidden");
      this.overlayEl.classList.toggle("creative", this.creative);
      this.overlayEl.querySelector("#craft-title").textContent =
        this.creative ? "无敌模式 · 创造物品栏"
        : mode === "table" ? "工作台 · 3×3 合成" : "物品栏 · 2×2 合成";
      if (this.invLabelEl) {
        this.invLabelEl.textContent = this.creative
          ? "快捷物品栏（把领来的方块 / 工具放到这里，1~9 切换使用）" : "物品栏";
      }
      this.buildGrid();
      this.buildGuide();
      this.renderAll();
    },
    hide() {
      this.overlayEl.classList.add("hidden");
      this.overlayEl.classList.remove("creative");
      // 光标上还拿着物品（如刚脱下的护甲）：放回背包，避免丢失
      if (this.cursor) {
        this.addItem(this.cursor.id, this.cursor.count);
        this.cursor = null;
      }
      this.updateDrag();
      this.renderAll();
    },

    /* ---------------- DOM 构建 ---------------- */

    applyIcon(el, id) {
      if (this.blockIcons[id]) {
        // 方块专属物品栏图（如草方块的等距立体图），仅 UI 使用
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
        // 移动端紧凑槽位（CSS 把槽位缩到 36/34px）时按实测宽度重采样图集，
        // 避免沿用 data-px=48 导致纹理在小槽里被裁切；等大或更大的槽位维持原基准不变
        let px = parseInt(el.dataset.px, 10) || 48;
        if (this.isOpen()) {
          const cw = el.clientWidth;   // 全局 border-box：48px 槽实测即 48
          if (cw > 0 && cw < px) px = cw;
        }
        el.style.backgroundImage = "url(" + this.atlasUrl + ")";
        el.style.backgroundSize = (px * ATLAS_COLS) + "px " + (px * ATLAS_ROWS) + "px";
        el.style.backgroundPosition = (-col * px) + "px " + (-row * px) + "px";
      }
      el.title = getItemName(id);
    },

    fillSlotEl(el, stack) {
      el.innerHTML = "";
      el.style.backgroundImage = "";
      if (!stack) {
        el.title = "";
        return;
      }
      this.applyIcon(el, stack.id);
      if (stack.count > 1) {
        const cnt = document.createElement("span");
        cnt.className = "cnt";
        cnt.textContent = stack.count;
        el.appendChild(cnt);
      }
      // 工具耐久条
      if (stack.dur != null) {
        const max = toolDurability(stack.id);
        const bar = document.createElement("span");
        bar.className = "dur";
        const ratio = Math.max(0, stack.dur / max);
        if (ratio < 0.25) bar.classList.add("danger");
        else if (ratio < 0.5) bar.classList.add("warn");
        bar.innerHTML = '<i style="width:' + (ratio * 100) + '%"></i>';
        el.appendChild(bar);
        el.title = getItemName(stack.id) + "（耐久 " + stack.dur + " / " + max + "）";
      }
    },

    buildHotbar() {
      this.hotbarEl.innerHTML = "";
      for (let i = 0; i < SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "slot";
        slot.dataset.px = "52";
        slot.dataset.loc = "inv:" + i;
        const num = document.createElement("span");
        num.className = "num";
        num.textContent = i + 1;
        const name = document.createElement("span");
        name.className = "name";
        slot.appendChild(num);
        slot.appendChild(name);
        this.hotbarEl.appendChild(slot);
      }
      this.updateActive();
    },

    buildPanelInventory() {
      this.invEl.innerHTML = "";
      for (let i = 0; i < SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = "inv:" + i;
        this.invEl.appendChild(slot);
      }
    },

    // 皮革背包的额外格子（未装备时整体置灰，仅作展示）
    buildBagSlots() {
      if (!this.bagEl) return;
      this.bagEl.innerHTML = "";
      for (let i = 0; i < BAG_SLOTS; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = "bag:" + i;
        this.bagEl.appendChild(slot);
      }
    },

    // 刷新背包格内容与可用状态
    renderBagArea() {
      if (!this.bagEl) return;
      const has = this.hasBag();
      this.bagEl.classList.toggle("bag-locked", !has);
      for (let i = 0; i < BAG_SLOTS; i++) {
        if (this.bagEl.children[i]) this.fillSlotEl(this.bagEl.children[i], has ? this.bagSlots[i] : null);
      }
      if (this.bagLabelEl) {
        this.bagLabelEl.textContent = has ? "皮革背包（已装备 · 9 格储物）" : "皮革背包（未装备 · 工作台用 8 张皮革合成）";
      }
    },

    buildGrid() {
      const size = this.mode === "table" ? 3 : 2;
      this.gridEl.className = "craft-grid g" + size;
      this.gridEl.innerHTML = "";
      const prefix = this.mode === "table" ? "g3:" : "g2:";
      for (let i = 0; i < size * size; i++) {
        const slot = document.createElement("div");
        slot.className = "cslot";
        slot.dataset.px = "48";
        slot.dataset.loc = prefix + i;
        this.gridEl.appendChild(slot);
      }
    },

    /* ---------------- 配方攻略 ---------------- */

    // 创建一个攻略用的小图标格
    makeMiniCell(id, withCount) {
      const cell = document.createElement("div");
      cell.className = "mini-cell";
      cell.dataset.px = "26";
      if (id) {
        this.applyIcon(cell, id);
        if (withCount > 1) {
          const cnt = document.createElement("span");
          cnt.className = "cnt";
          cnt.textContent = withCount;
          cell.appendChild(cnt);
        }
      }
      return cell;
    },

    // 按当前模式（2×2 / 3×3）列出全部配方；当前格数摆不下的置灰并标注“仅工作台”
    buildGuide() {
      if (!this.guideEl) return;
      const size = this.mode === "table" ? 3 : 2;
      this.guideEl.classList.toggle("hidden", !this.guideOpen);
      if (this.toggleEl) {
        this.toggleEl.querySelector(".rg-mark").textContent = this.guideOpen ? "\u25BC" : "\u25B6";
      }
      this.guideEl.innerHTML = "";

      RECIPES.forEach(rec => {
        const ph = rec.pattern.length, pw = rec.pattern[0].length;
        const fits = ph <= size && pw <= size;

        const entry = document.createElement("div");
        entry.className = "recipe-entry" + (fits ? "" : " rg-locked");

        // 材料图案
        const mg = document.createElement("div");
        mg.className = "mini-grid";
        mg.style.gridTemplateColumns = "repeat(" + pw + ", 26px)";
        for (let r = 0; r < ph; r++) {
          for (let c = 0; c < pw; c++) {
            mg.appendChild(this.makeMiniCell(rec.pattern[r][c], 0));
          }
        }

        const arrow = document.createElement("span");
        arrow.className = "mini-arrow";
        arrow.textContent = "\u25B6";

        // 产物图标 + 名称
        const wrap = document.createElement("div");
        wrap.className = "rg-result";
        const outCell = this.makeMiniCell(rec.output.id, rec.output.count);
        outCell.classList.add("rg-out");
        wrap.appendChild(outCell);
        const meta = document.createElement("div");
        meta.className = "rg-meta";
        const nm = document.createElement("span");
        nm.className = "rg-name";
        nm.textContent = getItemName(rec.output.id) +
          (rec.output.count > 1 ? " \u00D7" + rec.output.count : "");
        meta.appendChild(nm);
        if (!fits) {
          const tag = document.createElement("span");
          tag.className = "rg-tag";
          tag.textContent = "仅工作台";
          meta.appendChild(tag);
        }
        wrap.appendChild(meta);

        entry.appendChild(mg);
        entry.appendChild(arrow);
        entry.appendChild(wrap);
        this.guideEl.appendChild(entry);
      });
    },

    /* ---------------- 人物全身像 ---------------- */

    // 32×40 像素正面像：头 / 躯干 / 双手 / 双腿，已穿戴的羊毛护甲覆盖对应部位
    drawCharacter() {
      const cv = this.charCanvas;
      if (!cv || !cv.getContext) return;
      const x = cv.getContext("2d");
      const COL = {
        skin: "#d2966c", skinShade: "#ab744c",
        hair: "#4a3120", hairShade: "#372418",
        shirt: "#3aa0c2", shirtShade: "#2b7e99",
        pants: "#3b4f9e", pantsShade: "#2c3a78",
        eye: "#2b2b3a",
        wool: "#f2efe6", woolShade: "#cfc9ba", woolDark: "#b3ad9e"
      };
      x.clearRect(0, 0, cv.width, cv.height);
      const px = (gx, gy, w, h, color) => { x.fillStyle = color; x.fillRect(gx, gy, w, h); };

      // ---- 基础人体 ----
      px(11, 24, 5, 16, COL.pants);          // 左腿
      px(16, 24, 5, 16, COL.pants);          // 右腿
      px(11, 10, 10, 14, COL.shirt);         // 躯干
      px(5, 10, 6, 14, COL.skin);            // 左臂
      px(21, 10, 6, 14, COL.skin);           // 右臂
      px(11, 0, 10, 10, COL.skin);           // 头
      // 头发：头顶 + 两侧鬓角
      px(11, 0, 10, 3, COL.hair);
      px(11, 3, 1, 3, COL.hair);
      px(20, 3, 1, 3, COL.hair);
      // 眼睛
      px(13, 5, 2, 1, COL.eye);
      px(17, 5, 2, 1, COL.eye);
      // 暗边（右侧 / 下侧）
      px(20, 10, 1, 14, COL.shirtShade);
      px(24, 10, 1, 14, COL.skinShade);      // 右臂外沿其实是右边 x=26
      px(26, 10, 1, 14, COL.skinShade);
      px(15, 24, 1, 16, COL.pantsShade);
      px(20, 24, 1, 16, COL.pantsShade);

      // ---- 护甲覆盖 ----
      // 棋盘格噪点，让羊毛有针织质感
      const knit = (x0, y0, w, h) => {
        for (let yy = y0; yy < y0 + h; yy++) {
          for (let xx = x0; xx < x0 + w; xx++) {
            if ((xx + yy) % 2 === 0) px(xx, yy, 1, 1, COL.woolShade);
          }
        }
      };
      if (this.armor.head) {
        px(11, 0, 10, 4, COL.wool);          // 帽顶
        px(11, 4, 2, 6, COL.wool);           // 左护耳
        px(19, 4, 2, 6, COL.wool);           // 右护耳
        px(11, 9, 10, 1, COL.wool);          // 帽檐
        knit(11, 0, 10, 4);
        px(20, 0, 1, 10, COL.woolDark);
      }
      if (this.armor.chest) {
        px(11, 10, 10, 14, COL.wool);        // 衣身
        px(5, 10, 6, 10, COL.wool);          // 短袖（盖到上臂）
        px(21, 10, 6, 10, COL.wool);
        knit(11, 10, 10, 14);
        px(20, 10, 1, 14, COL.woolDark);
      }
      if (this.armor.legs) {
        px(11, 24, 10, 16, COL.wool);
        knit(11, 24, 10, 16);
        px(20, 24, 1, 16, COL.woolDark);
      }
      // 皮革背包：正面可见的两条肩带
      if (this.armor.back) {
        const strap = "#7a5230", strapDark = "#5d3d22";
        px(12, 11, 2, 12, strap);
        px(18, 11, 2, 12, strap);
        px(13, 11, 1, 12, strapDark);
        px(19, 11, 1, 12, strapDark);
        px(12, 22, 8, 2, strapDark);   // 腰间连接带
      }
    },

    // 装备槽图标 + 人物像 + 防御数值
    renderArmorArea() {
      ARMOR_SLOTS.forEach(slotName => {
        const el = this.armorEls[slotName];
        if (!el) return;
        const a = this.armor[slotName];
        this.fillSlotEl(el, a);
        el.classList.toggle("ghost", !a);
      });
      if (this.charCanvas) this.drawCharacter();
      if (this.charStatsEl) {
        const def = this.totalDefense();
        this.charStatsEl.innerHTML = def > 0
          ? "护甲防御 <b>+" + def + "</b><span>抵消 " + def + " 点伤害</span>"
          : "未穿戴护甲<span>羊毛可缝制装备</span>";
      }
    },


    updateActive() {
      const slots = this.hotbarEl.children;
      for (let k = 0; k < slots.length; k++) {
        slots[k].classList.toggle("active", k === this.selected);
        const s = this.inventory[k];
        const nameEl = slots[k].querySelector(".name");
        if (nameEl) nameEl.textContent = s ? getItemName(s.id) : "";
      }
    },

    // 重绘 hotbar / 面板库存 / 合成格 / 输出
    renderAll() {
      for (let i = 0; i < SLOTS; i++) {
        if (this.hotbarEl.children[i]) {
          // 保留 num/name 子元素：只刷新图标与数量
          const s = this.inventory[i];
          const el = this.hotbarEl.children[i];
          const name = el.querySelector(".name");
          el.innerHTML = "";
          this.fillSlotEl(el, s);
          const num = document.createElement("span");
          num.className = "num";
          num.textContent = i + 1;
          el.appendChild(num);
          if (name) el.appendChild(name);
        }
        if (this.invEl.children[i]) this.fillSlotEl(this.invEl.children[i], this.inventory[i]);
      }
      this.updateActive();

      if (this.isOpen()) {
        const grid = this.mode === "table" ? this.grid3 : this.grid2;
        const size = this.mode === "table" ? 3 : 2;
        for (let i = 0; i < this.gridEl.children.length; i++) {
          this.fillSlotEl(this.gridEl.children[i], grid[i]);
        }
        const m = matchRecipe(grid, size);
        this.currentMatch = m;
        this.renderOutput(m ? m.output : null);
        this.renderArmorArea();
        this.renderBagArea();
      }
      this.updateDrag();
    },

    renderOutput(out) {
      this.outputEl.innerHTML = "";
      this.outputEl.style.backgroundImage = "";
      this.outputEl.classList.toggle("ready", !!out);
      if (!out) return;
      this.applyIcon(this.outputEl, out.id);
      if (out.count > 1) {
        const cnt = document.createElement("span");
        cnt.className = "cnt";
        cnt.textContent = out.count;
        this.outputEl.appendChild(cnt);
      }
    },

    updateDrag() {
      if (!this.cursor) {
        this.dragEl.style.display = "none";
        return;
      }
      this.dragEl.style.display = "block";
      this.applyIcon(this.dragEl, this.cursor.id);
      let cnt = this.dragEl.querySelector(".cnt");
      if (this.cursor.count > 1) {
        if (!cnt) {
          cnt = document.createElement("span");
          cnt.className = "cnt";
          this.dragEl.appendChild(cnt);
        }
        cnt.textContent = this.cursor.count;
      } else if (cnt) {
        cnt.remove();
      }
    },

    /* ---------------- 槽位定位与搬移 ---------------- */

    activeGrid() { return this.mode === "table" ? this.grid3 : this.grid2; },

    clickLoc(loc) {
      if (loc === "out") { this.takeOutput(); return; }
      const [kind, idxStr] = loc.split(":");
      // 装备槽（arm:head / arm:chest / arm:legs / arm:back）：空手拿起已穿装备；持对应装备则穿戴（交换）
      if (kind === "arm") {
        const slotName = idxStr;
        const cur = this.armor[slotName];
        if (!this.cursor) {
          // 卸下背包前必须清空背包格，避免背包内容无处安放而丢失
          if (slotName === "back" && cur && !this.bagEmpty()) {
            if (this.onToast) this.onToast("背包里还有物品，请先清空再卸下");
            return;
          }
          if (cur) { this.cursor = cur; this.armor[slotName] = null; }
        } else if (armorSlotOf(this.cursor.id) === slotName) {
          this.armor[slotName] = this.cursor;
          this.cursor = cur;    // 槽位上原有的装备换回到光标
        }
        this.renderAll();
        return;
      }
      const idx = parseInt(idxStr, 10);
      // 无敌模式创造源格：点击直接领一整组（源格不减少，无限取用）；
      // 光标已拿着同种物品则补满，拿着异种则换成新物品（创造物品无损失概念）
      if (kind === "cre") {
        if (!Number.isInteger(idx)) return;
        this.cursor = this.makeStack(idx, maxStackOf(idx));
        this.renderAll();
        return;
      }
      let arr;
      if (kind === "inv") arr = this.inventory;
      else if (kind === "g2") arr = this.grid2;
      else if (kind === "g3") arr = this.grid3;
      else if (kind === "bag") { if (!this.hasBag()) return; arr = this.bagSlots; }
      else return;
      if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) return;

      const cur = arr[idx];
      if (!this.cursor) {
        if (cur) { this.cursor = cur; arr[idx] = null; }
      } else if (!cur) {
        arr[idx] = this.cursor;
        this.cursor = null;
      } else if (cur.id === this.cursor.id) {
        const room = maxStackOf(cur.id) - cur.count;
        const move = Math.min(room, this.cursor.count);
        if (move > 0) {
          cur.count += move;
          this.cursor.count -= move;
          if (this.cursor.count <= 0) this.cursor = null;
        }
      } else {
        arr[idx] = this.cursor;
        this.cursor = cur;
      }
      this.renderAll();
    },

    // 右键：空手拿起一半；持物时向目标格放 1 个（MC 风格分堆）
    rightClickLoc(loc) {
      if (loc === "out") return;
      const [kind, idxStr] = loc.split(":");
      if (kind === "arm") return;   // 装备槽不支持分堆
      const idx = parseInt(idxStr, 10);
      // 无敌模式创造源格：右键领 1 个（光标为空或异种时给 1 个，同种且未满则 +1）
      if (kind === "cre") {
        if (!Number.isInteger(idx)) return;
        if (!this.cursor || this.cursor.id !== idx) this.cursor = this.makeStack(idx, 1);
        else if (this.cursor.count < maxStackOf(idx)) this.cursor.count++;
        this.renderAll();
        return;
      }
      let arr;
      if (kind === "inv") arr = this.inventory;
      else if (kind === "g2") arr = this.grid2;
      else if (kind === "g3") arr = this.grid3;
      else if (kind === "bag") { if (!this.hasBag()) return; arr = this.bagSlots; }
      else return;
      if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) return;

      const cur = arr[idx];
      if (!this.cursor) {
        if (cur) {
          const half = Math.ceil(cur.count / 2);
          this.cursor = { id: cur.id, count: half };
          cur.count -= half;
          if (cur.count <= 0) arr[idx] = null;
        }
      } else if (!cur) {
        arr[idx] = { id: this.cursor.id, count: 1 };
        this.cursor.count--;
        if (this.cursor.count <= 0) this.cursor = null;
      } else if (cur.id === this.cursor.id && cur.count < maxStackOf(cur.id)) {
        cur.count++;
        this.cursor.count--;
        if (this.cursor.count <= 0) this.cursor = null;
      }
      this.renderAll();
    },

    takeOutput() {
      const size = this.mode === "table" ? 3 : 2;
      const grid = this.activeGrid();
      const m = matchRecipe(grid, size);
      if (!m) return;
      const out = m.output;

      // 产物去向：光标可合并 → 光标；否则进背包；都放不下则拒绝
      if (this.cursor && (this.cursor.id !== out.id ||
          this.cursor.count + out.count > maxStackOf(out.id))) return;
      if (!this.cursor && !this.roomFor(out.id, out.count)) return;

      // 消耗材料（每个配方格 1 件）
      for (let i = 0; i < m.cells.length; i++) {
        const s = grid[m.cells[i]];
        s.count--;
        if (s.count <= 0) grid[m.cells[i]] = null;
      }
      // 发放产物
      if (this.cursor) this.cursor.count += out.count;
      else this.addItem(out.id, out.count);
      this.renderAll();
    },

    /* ---------------- 事件 ---------------- */

    bindEvents() {
      // 点击委托：左键整堆搬移，右键放 1 个 / 取半
      const onClick = (e) => {
        if (!this.isOpen()) return;
        const slotEl = e.target.closest ? e.target.closest("[data-loc]") : null;
        if (slotEl) {
          if (e.button === 2) this.rightClickLoc(slotEl.dataset.loc);
          else if (e.button === 0) this.clickLoc(slotEl.dataset.loc);
          e.preventDefault();
        }
      };
      this.overlayEl.addEventListener("mousedown", onClick);
      this.hotbarEl.addEventListener("mousedown", function (e) {
        if (Crafting.isOpen()) onClick(e);
      });
      // 输出格（仅左键合成）
      this.outputEl.addEventListener("mousedown", (e) => {
        if (!this.isOpen()) return;
        e.preventDefault();
        if (e.button === 0) this.takeOutput();
      });
      // 关闭按钮
      this.overlayEl.querySelector("#craft-close").addEventListener("click", () => {
        if (this.onCloseRequest) this.onCloseRequest();
      });
      // 配方攻略折叠 / 展开
      if (this.toggleEl) {
        this.toggleEl.addEventListener("click", () => {
          this.guideOpen = !this.guideOpen;
          this.buildGuide();
        });
      }
      // 阻止面板上的右键菜单（右键暂时不做分堆）
      this.overlayEl.addEventListener("contextmenu", (e) => e.preventDefault());

      // 光标物品跟随鼠标
      document.addEventListener("mousemove", (e) => {
        if (!this.cursor) return;
        this.dragEl.style.left = e.clientX + "px";
        this.dragEl.style.top = e.clientY + "px";
      });

      // 旋转屏幕 / 窗口跨断点时槽位尺寸变化，重绘一次让图集按新尺寸重采样
      window.addEventListener("resize", () => {
        if (this.isOpen()) this.renderAll();
      });

      this.bindTouchSlots();
    },

    /* ---------------- 触屏长按拆堆 ----------------
     * 手机没有右键：长按槽位等同右键（空手拿起一半 / 持物放 1 个）；
     * 长按触发后不松手直接拖到其他格子抬起，等同左键把拿起的半堆放进目标格。
     * 快速点按仍走浏览器合成的 mousedown（= 左键整堆），不受影响。
     */
    bindTouchSlots() {
      const LONG_MS = 450;        // 按住多久算长按
      const MOVE_CANCEL = 12;     // 长按计时期间移动超过该像素（滚动 / 滑走）则取消
      const SUPPRESS_MS = 700;    // 长按后吞掉浏览器合成鼠标事件的时间窗
      let press = null;           // 当前按压状态
      let suppressUntil = 0;

      // 当前打开的物品面板及其事件根节点（合成面板开着时热键栏也可操作）
      const activePanel = () => {
        if (this.isOpen()) return { panel: this, roots: [this.overlayEl, this.hotbarEl] };
        if (global.Chest && Chest.isOpen()) return { panel: Chest, roots: [Chest.overlayEl] };
        if (global.Furnace && Furnace.isOpen()) return { panel: Furnace, roots: [Furnace.overlayEl] };
        if (global.GunBench && GunBench.isOpen()) return { panel: GunBench, roots: [GunBench.overlayEl] };
        return null;
      };
      const slotAtPoint = (x, y, roots) => {
        const el = document.elementFromPoint(x, y);
        const slot = el && el.closest ? el.closest("[data-loc]") : null;
        return slot && roots.some(r => r.contains(slot)) ? slot : null;
      };
      const moveDragTo = (x, y) => {
        this.dragEl.style.left = x + "px";
        this.dragEl.style.top = y + "px";
      };

      document.addEventListener("touchstart", (e) => {
        const ap = activePanel();
        if (!ap || e.touches.length !== 1 || press) return;
        const t = e.touches[0];
        const slot = t.target.closest ? t.target.closest("[data-loc]") : null;
        if (!slot || !ap.roots.some(r => r.contains(slot))) return;
        const st = {
          id: t.identifier, panel: ap.panel, roots: ap.roots,
          loc: slot.dataset.loc, x0: t.clientX, y0: t.clientY,
          x: t.clientX, y: t.clientY, fired: false, timer: 0
        };
        st.timer = setTimeout(() => {
          if (!press || press.fired) return;
          press.fired = true;
          if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
          // 右键语义：空手取半 / 持物放 1
          press.panel.rightClickLoc(press.loc);
          moveDragTo(press.x, press.y);
        }, LONG_MS);
        press = st;
      }, { passive: true });

      document.addEventListener("touchmove", (e) => {
        if (!press) return;
        let t = null;
        for (const tc of e.changedTouches) {
          if (tc.identifier === press.id) { t = tc; break; }
        }
        if (!t) return;
        press.x = t.clientX;
        press.y = t.clientY;
        if (!press.fired) {
          // 计时期间滑动超阈值：视为滚动 / 滑走，取消长按
          if (Math.abs(t.clientX - press.x0) > MOVE_CANCEL ||
              Math.abs(t.clientY - press.y0) > MOVE_CANCEL) {
            clearTimeout(press.timer);
            press.timer = 0;
          }
        } else {
          // 已拿起半堆：拦住滚动，物品片跟随手指
          e.preventDefault();
          if (this.cursor) moveDragTo(press.x, press.y);
        }
      }, { passive: false });

      const endTouch = (e) => {
        if (!press) return;
        let t = null;
        for (const tc of e.changedTouches) {
          if (tc.identifier === press.id) { t = tc; break; }
        }
        if (!t) return;
        const st = press;
        press = null;
        clearTimeout(st.timer);
        if (!st.fired) return;
        // 长按已触发：吞掉浏览器随后合成的 mousedown/mouseup/click，
        // 否则源格会再吃一次左键（把剩下的半堆又拿起 / 来回交换）
        suppressUntil = performance.now() + SUPPRESS_MS;
        // 拖到另一个格子松手：左键语义放下拿起的半堆（合并 / 交换同左键）
        const target = slotAtPoint(st.x, st.y, st.roots);
        if (target && target.dataset.loc !== st.loc) st.panel.clickLoc(target.dataset.loc);
      };
      document.addEventListener("touchend", endTouch);
      document.addEventListener("touchcancel", endTouch);

      // 长按后浏览器仍会补发合成鼠标事件，在捕获阶段统一吞掉
      const killSynth = (e) => {
        if (performance.now() >= suppressUntil) return;
        if (e.type !== "click" && e.type !== "contextmenu" && e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
      };
      document.addEventListener("mousedown", killSynth, true);
      document.addEventListener("mouseup", killSynth, true);
      document.addEventListener("click", killSynth, true);
      document.addEventListener("contextmenu", killSynth, true);
    }
  };

  global.Crafting = Crafting;
})(window);
