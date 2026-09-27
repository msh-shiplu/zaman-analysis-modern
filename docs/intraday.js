(function () {
  "use strict";

  const STORAGE_URL_KEY = "zaman_dse_supabase_url";
  const STORAGE_ANON_KEY = "zaman_dse_supabase_key";
  const STORAGE_THEME_KEY = "zaman_dse_theme";

  let state = {
    sessionDate: "--",
    slots: [], // [{ slot: "2026-09-27 10:50", timeShort: "10:50 BST", timestamp, adv, dec, flat, total_value, total_volume, total_trades, delta_value, delta_volume, delta_trades }]
    symbols: [], // [{ symbol, ycp, latest_ltp, latest_chg, latest_pct, latest_val, latest_vol, latest_slot_delta, bySlot: { [slotKey]: { ltp, chg, val, v, trd, delta_ltp, delta_val, delta_v, delta_trd } } }]
    selectedSlot: "matrix", // "matrix" or specific slotKey
    matrixMetric: "ltp", // "ltp" | "delta_vol" | "delta_val" | "vol" | "val" | "trd"
    searchQuery: "",
    activeFilter: "all",
    sortField: "latest_val",
    sortAsc: false,
    selectedSymbol: null,
    sourceLabel: "Snapshot",
  };

  const fmtNum = (val, decimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "--";
    return Number(val).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  const fmtInt = (val) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "--";
    return Math.round(Number(val)).toLocaleString("en-US");
  };

  function toDhakaSlotKey(isoStr) {
    if (!isoStr) return "";
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 16);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Dhaka",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
    } catch (_e) {
      return String(isoStr).slice(0, 16);
    }
  }

  function formatSlotTimeLabel(slotKey) {
    // slotKey is "YYYY-MM-DD HH:MM" in BST
    const timePart = slotKey.split(" ")[1] || slotKey;
    const [hhStr, mmStr] = timePart.split(":");
    const hh = Number(hhStr);
    if (Number.isNaN(hh)) return timePart;
    const period = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${mmStr} ${period}`;
  }

  function buildIntradayState(payload) {
    const history = payload.history || {};
    const dynamicLatest = payload.dynamic || [];

    const dynMap = {};
    for (const d of dynamicLatest) {
      if (d && d.symbol) dynMap[d.symbol] = d;
    }

    // Collect all slot keys across history
    const slotAgg = {};
    const allSymbolKeys = Array.from(new Set([...Object.keys(history), ...Object.keys(dynMap)])).sort();

    for (const sym of allSymbolKeys) {
      const pts = history[sym] || [];
      for (const p of pts) {
        const sKey = p.slot || toDhakaSlotKey(p.t);
        if (!sKey) continue;
        p._slotKey = sKey;
        if (!slotAgg[sKey]) {
          slotAgg[sKey] = {
            slot: sKey,
            timestamp: p.t,
            symbols: 0,
            adv: 0,
            dec: 0,
            flat: 0,
            total_value: 0,
            total_volume: 0,
            total_trades: 0,
          };
        }
        const agg = slotAgg[sKey];
        agg.symbols++;
        const ltp = Number(p.ltp || 0);
        const chg = p.chg !== null && p.chg !== undefined ? Number(p.chg) : 0;
        if (ltp > 0) {
          if (chg > 0) agg.adv++;
          else if (chg < 0) agg.dec++;
          else agg.flat++;
        }
        agg.total_value += Number(p.val || 0);
        agg.total_volume += Number(p.v || 0);
        agg.total_trades += Number(p.trd || 0);
      }
    }

    const sortedSlotKeys = Object.keys(slotAgg).sort();
    // Filter to the latest date in BST so only today's session slots are shown
    const latestDate =
      payload.intraday_date_bst ||
      (sortedSlotKeys.length > 0 ? sortedSlotKeys[sortedSlotKeys.length - 1].split(" ")[0] : "--");

    const todaySlotKeys = sortedSlotKeys.filter((k) => k.startsWith(latestDate));
    const activeSlotKeys = todaySlotKeys.length > 0 ? todaySlotKeys : sortedSlotKeys;

    const slotsList = activeSlotKeys.map((k, idx) => {
      const curr = slotAgg[k];
      const prev = idx > 0 ? slotAgg[activeSlotKeys[idx - 1]] : null;
      return {
        ...curr,
        timeShort: formatSlotTimeLabel(k),
        delta_value: prev ? Math.max(0, curr.total_value - prev.total_value) : curr.total_value,
        delta_volume: prev ? Math.max(0, curr.total_volume - prev.total_volume) : curr.total_volume,
        delta_trades: prev ? Math.max(0, curr.total_trades - prev.total_trades) : curr.total_trades,
      };
    });

    const symbolsList = [];
    for (const sym of allSymbolKeys) {
      const d = dynMap[sym] || {};
      const pts = (history[sym] || []).filter((p) => activeSlotKeys.includes(p._slotKey));

      const bySlot = {};
      let prevPt = null;
      for (const p of pts) {
        const sKey = p._slotKey;
        const ltp = p.ltp !== null && p.ltp !== undefined ? Number(p.ltp) : null;
        const val = Number(p.val || 0);
        const v = Number(p.v || 0);
        const trd = Number(p.trd || 0);
        const chg = p.chg !== null && p.chg !== undefined ? Number(p.chg) : null;
        const ycp = p.ycp !== null && p.ycp !== undefined ? Number(p.ycp) : (d.ycp ? Number(d.ycp) : null);

        const prevLtp = prevPt && prevPt.ltp > 0 ? prevPt.ltp : ycp;
        const deltaLtp =
          ltp && prevLtp && ltp > 0 && prevLtp > 0 ? Number((ltp - prevLtp).toFixed(2)) : 0;
        const deltaVal = prevPt ? Math.max(0, Number((val - prevPt.val).toFixed(3))) : val;
        const deltaV = prevPt ? Math.max(0, v - prevPt.v) : v;
        const deltaTrd = prevPt ? Math.max(0, trd - prevPt.trd) : trd;

        const entry = {
          slot: sKey,
          t: p.t,
          ltp,
          ycp,
          chg,
          val,
          v,
          trd,
          delta_ltp: deltaLtp,
          delta_val: deltaVal,
          delta_v: deltaV,
          delta_trd: deltaTrd,
        };
        bySlot[sKey] = entry;
        prevPt = entry;
      }

      const lastSlotKey = activeSlotKeys[activeSlotKeys.length - 1];
      const latestSlotObj = bySlot[lastSlotKey] || {};
      const ycp =
        d.ycp !== undefined && d.ycp !== null
          ? Number(d.ycp)
          : latestSlotObj.ycp ?? null;
      const latestLtp =
        d.ltp !== undefined && d.ltp !== null
          ? Number(d.ltp)
          : latestSlotObj.ltp ?? null;
      const latestChg =
        d.change !== undefined && d.change !== null
          ? Number(d.change)
          : latestSlotObj.chg ?? null;
      const latestPct =
        latestLtp && ycp && latestLtp > 0 && ycp > 0
          ? Number((((latestLtp - ycp) / ycp) * 100).toFixed(2))
          : null;

      symbolsList.push({
        symbol: sym,
        ycp,
        latest_ltp: latestLtp,
        latest_chg: latestChg,
        latest_pct: latestPct,
        latest_val: d.value !== undefined && d.value !== null ? Number(d.value) : (latestSlotObj.val || 0),
        latest_vol: d.volume !== undefined && d.volume !== null ? Number(d.volume) : (latestSlotObj.v || 0),
        latest_trd: d.trade !== undefined && d.trade !== null ? Number(d.trade) : (latestSlotObj.trd || 0),
        latest_slot_delta: latestSlotObj.delta_ltp || 0,
        bySlot,
      });
    }

    state.sessionDate = latestDate;
    state.slots = slotsList;
    state.symbols = symbolsList;

    if (!state.selectedSymbol && symbolsList.length > 0) {
      const top = [...symbolsList].sort((a, b) => (b.latest_val || 0) - (a.latest_val || 0))[0];
      state.selectedSymbol = top ? top.symbol : symbolsList[0].symbol;
    }
  }

  function renderSessionKPIs() {
    document.getElementById("kpi-session-date").textContent = state.sessionDate;
    document.getElementById("kpi-slot-count").textContent = `${state.slots.length} half-hourly snapshots today`;

    const activeSlot =
      state.selectedSlot === "matrix"
        ? state.slots[state.slots.length - 1]
        : state.slots.find((s) => s.slot === state.selectedSlot) || state.slots[state.slots.length - 1];

    if (activeSlot) {
      document.getElementById("kpi-latest-delta-val").textContent = `+BDT ${fmtNum(activeSlot.delta_value, 2)} Mn`;
      document.getElementById("kpi-latest-delta-trades").textContent = `+${fmtInt(activeSlot.delta_trades)} trades in slot (${activeSlot.timeShort})`;
      document.getElementById("kpi-latest-delta-vol").textContent = `+${fmtInt(activeSlot.delta_volume)}`;
      document.getElementById("kpi-cum-vol").textContent = `Cumulative: ${fmtInt(activeSlot.total_volume)} shares (BDT ${fmtNum(activeSlot.total_value, 1)} Mn)`;
      document.getElementById("kpi-slot-breadth").textContent = `${activeSlot.adv} / ${activeSlot.flat} / ${activeSlot.dec}`;
      document.getElementById("kpi-slot-adv").textContent = `${activeSlot.adv} Adv`;
      document.getElementById("kpi-slot-flat").textContent = `${activeSlot.flat} Unch`;
      document.getElementById("kpi-slot-dec").textContent = `${activeSlot.dec} Dec`;
      document.getElementById("intraday-session-text").textContent = `${state.sourceLabel}: ${state.sessionDate} (${state.slots.length} slots)`;
    }
  }

  function renderSlotStrip() {
    const strip = document.getElementById("slot-strip");
    strip.innerHTML = "";

    // 1. All-Slots Side-by-Side Matrix Card
    const matrixCard = document.createElement("div");
    matrixCard.className = `slot-card ${state.selectedSlot === "matrix" ? "active" : ""}`;
    matrixCard.innerHTML = `
      <div class="slot-time">
        <span>All Slots Matrix</span>
        <span class="badge badge-up">${state.slots.length}x</span>
      </div>
      <div class="slot-meta">Compare all half-hours side-by-side</div>
    `;
    matrixCard.addEventListener("click", () => {
      state.selectedSlot = "matrix";
      document.getElementById("matrix-metric-select").hidden = false;
      document.getElementById("matrix-metric-label").hidden = false;
      renderSlotStrip();
      renderSessionKPIs();
      renderIntradayTable();
    });
    strip.appendChild(matrixCard);

    // 2. Individual Half-Hourly Time Slot Cards
    for (const s of state.slots) {
      const card = document.createElement("div");
      card.className = `slot-card ${state.selectedSlot === s.slot ? "active" : ""}`;
      card.innerHTML = `
        <div class="slot-time">
          <span>${s.timeShort} BST</span>
          <span class="text-up">+${fmtNum(s.delta_value, 1)}M</span>
        </div>
        <div class="slot-meta">Cum: ${fmtNum(s.total_value, 1)}M | ${s.adv}▲ ${s.dec}▼</div>
      `;
      card.addEventListener("click", () => {
        state.selectedSlot = s.slot;
        document.getElementById("matrix-metric-select").hidden = true;
        document.getElementById("matrix-metric-label").hidden = true;
        renderSlotStrip();
        renderSessionKPIs();
        renderIntradayTable();
      });
      strip.appendChild(card);
    }
  }

  function getFilteredSymbols() {
    const q = state.searchQuery.trim().toUpperCase();
    let list = state.symbols.filter((item) => {
      if (q && !item.symbol.toUpperCase().includes(q)) return false;
      if (state.activeFilter === "gainers") return item.latest_chg !== null && item.latest_chg > 0;
      if (state.activeFilter === "losers") return item.latest_chg !== null && item.latest_chg < 0;
      if (state.activeFilter === "slot_up") return item.latest_slot_delta > 0;
      if (state.activeFilter === "active") return item.latest_val >= 10;
      return true;
    });

    const f = state.sortField;
    const dir = state.sortAsc ? 1 : -1;

    list.sort((a, b) => {
      let va = a[f];
      let vb = b[f];
      if (f.startsWith("slot:")) {
        const sKey = f.slice(5);
        const cellA = a.bySlot[sKey];
        const cellB = b.bySlot[sKey];
        va = cellA ? getCellNumericValue(cellA) : null;
        vb = cellB ? getCellNumericValue(cellB) : null;
      }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });

    return list;
  }

  function getCellNumericValue(cell) {
    if (!cell) return null;
    switch (state.matrixMetric) {
      case "ltp": return cell.ltp;
      case "delta_vol": return cell.delta_v;
      case "delta_val": return cell.delta_val;
      case "vol": return cell.v;
      case "val": return cell.val;
      case "trd": return cell.trd;
      default: return cell.ltp;
    }
  }

  function formatMatrixCell(cell) {
    if (!cell) return `<span class="text-flat">--</span>`;
    const m = state.matrixMetric;
    if (m === "ltp") {
      if (!cell.ltp || cell.ltp <= 0) return `<span class="text-flat">0.00</span>`;
      let cls = "";
      let arrow = "";
      if (cell.delta_ltp > 0) {
        cls = "text-up";
        arrow = ` (+${fmtNum(cell.delta_ltp, 1)})`;
      } else if (cell.delta_ltp < 0) {
        cls = "text-down";
        arrow = ` (${fmtNum(cell.delta_ltp, 1)})`;
      } else if (cell.chg > 0) {
        cls = "text-up";
      } else if (cell.chg < 0) {
        cls = "text-down";
      }
      return `<span class="${cls}">${fmtNum(cell.ltp)}${arrow}</span>`;
    }
    if (m === "delta_vol") {
      return cell.delta_v > 0 ? `<span class="text-up">+${fmtInt(cell.delta_v)}</span>` : `<span class="text-flat">0</span>`;
    }
    if (m === "delta_val") {
      return cell.delta_val > 0 ? `<span class="text-up">+${fmtNum(cell.delta_val, 2)}</span>` : `<span class="text-flat">0.00</span>`;
    }
    if (m === "vol") return fmtInt(cell.v);
    if (m === "val") return fmtNum(cell.val, 2);
    if (m === "trd") return fmtInt(cell.trd);
    return fmtNum(cell.ltp);
  }

  function renderIntradayTable() {
    const thead = document.getElementById("intraday-thead");
    const tbody = document.getElementById("intraday-tbody");
    const rows = getFilteredSymbols();

    if (state.selectedSlot === "matrix") {
      const slotHeaders = state.slots
        .map((s) => `<th data-sort="slot:${s.slot}">${s.timeShort}</th>`)
        .join("");

      thead.innerHTML = `
        <tr>
          <th data-sort="symbol">Symbol</th>
          <th data-sort="ycp">YCP</th>
          ${slotHeaders}
          <th data-sort="latest_chg">Day Chg</th>
          <th data-sort="latest_pct">% Chg</th>
          <th data-sort="latest_val">Cum. Val (Mn)</th>
        </tr>
      `;

      const frag = document.createDocumentFragment();
      for (const r of rows) {
        const tr = document.createElement("tr");
        if (r.symbol === state.selectedSymbol) tr.classList.add("selected");

        const slotCells = state.slots
          .map((s) => `<td>${formatMatrixCell(r.bySlot[s.slot])}</td>`)
          .join("");

        let badgeClass = "badge-flat";
        let sign = "";
        if (r.latest_chg > 0) {
          badgeClass = "badge-up";
          sign = "+";
        } else if (r.latest_chg < 0) {
          badgeClass = "badge-down";
        }

        tr.innerHTML = `
          <td>${r.symbol}</td>
          <td>${fmtNum(r.ycp)}</td>
          ${slotCells}
          <td class="${r.latest_chg > 0 ? "text-up" : r.latest_chg < 0 ? "text-down" : "text-flat"}">${r.latest_chg !== null ? sign + fmtNum(r.latest_chg) : "--"}</td>
          <td><span class="badge ${badgeClass}">${r.latest_pct !== null ? sign + fmtNum(r.latest_pct) + "%" : "--"}</span></td>
          <td>${fmtNum(r.latest_val, 2)}</td>
        `;
        tr.addEventListener("click", () => selectSymbol(r.symbol));
        frag.appendChild(tr);
      }
      tbody.innerHTML = "";
      tbody.appendChild(frag);
    } else {
      // Single Half-Hourly Slot Snapshot View
      const sKey = state.selectedSlot;
      thead.innerHTML = `
        <tr>
          <th data-sort="symbol">Symbol</th>
          <th data-sort="ycp">YCP</th>
          <th data-sort="slot:${sKey}">Slot LTP</th>
          <th data-sort="latest_slot_delta">Slot Δ Price</th>
          <th data-sort="latest_chg">Day Chg</th>
          <th data-sort="latest_pct">% Chg</th>
          <th>30m Δ Vol</th>
          <th>30m Δ Val (Mn)</th>
          <th data-sort="latest_vol">Cum. Volume</th>
          <th data-sort="latest_val">Cum. Value (Mn)</th>
          <th data-sort="latest_trd">Trades</th>
        </tr>
      `;

      const frag = document.createDocumentFragment();
      for (const r of rows) {
        const cell = r.bySlot[sKey] || {};
        const tr = document.createElement("tr");
        if (r.symbol === state.selectedSymbol) tr.classList.add("selected");

        const chg = cell.chg !== undefined ? cell.chg : r.latest_chg;
        const pct = cell.ltp && r.ycp ? (((cell.ltp - r.ycp) / r.ycp) * 100) : r.latest_pct;
        let dirClass = "text-flat";
        let badgeClass = "badge-flat";
        let sign = "";
        if (chg > 0) {
          dirClass = "text-up";
          badgeClass = "badge-up";
          sign = "+";
        } else if (chg < 0) {
          dirClass = "text-down";
          badgeClass = "badge-down";
        }

        const slotDelta = cell.delta_ltp || 0;
        const slotDeltaClass = slotDelta > 0 ? "text-up" : slotDelta < 0 ? "text-down" : "text-flat";
        const slotDeltaStr = slotDelta > 0 ? `+${fmtNum(slotDelta)}` : fmtNum(slotDelta);

        tr.innerHTML = `
          <td>${r.symbol}</td>
          <td>${fmtNum(r.ycp)}</td>
          <td class="${dirClass}">${fmtNum(cell.ltp)}</td>
          <td class="${slotDeltaClass}">${slotDeltaStr}</td>
          <td class="${dirClass}">${chg !== null && chg !== undefined ? sign + fmtNum(chg) : "--"}</td>
          <td><span class="badge ${badgeClass}">${pct !== null && pct !== undefined ? sign + fmtNum(pct) + "%" : "--"}</span></td>
          <td class="text-up">+${fmtInt(cell.delta_v || 0)}</td>
          <td class="text-up">+${fmtNum(cell.delta_val || 0, 2)}</td>
          <td>${fmtInt(cell.v)}</td>
          <td>${fmtNum(cell.val, 2)}</td>
          <td>${fmtInt(cell.trd)}</td>
        `;
        tr.addEventListener("click", () => selectSymbol(r.symbol));
        frag.appendChild(tr);
      }
      tbody.innerHTML = "";
      tbody.appendChild(frag);
    }

    // Bind column header sorting
    thead.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (state.sortField === field) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortField = field;
          state.sortAsc = field === "symbol";
        }
        renderIntradayTable();
      });
    });
  }

  function selectSymbol(symbol) {
    state.selectedSymbol = symbol;
    const item = state.symbols.find((s) => s.symbol === symbol);
    if (!item) return;

    document.getElementById("intra-insp-symbol").textContent = item.symbol;
    document.getElementById("intra-insp-sub").textContent = `YCP: BDT ${fmtNum(item.ycp)} | Cum. Val: ${fmtNum(item.latest_val)} Mn`;
    document.getElementById("intra-insp-ltp").textContent = item.latest_ltp ? `BDT ${fmtNum(item.latest_ltp)}` : "--";

    const badge = document.getElementById("intra-insp-badge");
    badge.className = "badge";
    if (item.latest_chg > 0) {
      badge.classList.add("badge-up");
      badge.textContent = `+${fmtNum(item.latest_chg)} (+${fmtNum(item.latest_pct)}%)`;
    } else if (item.latest_chg < 0) {
      badge.classList.add("badge-down");
      badge.textContent = `${fmtNum(item.latest_chg)} (${fmtNum(item.latest_pct)}%)`;
    } else {
      badge.classList.add("badge-flat");
      badge.textContent = "0.00 (0.00%)";
    }

    // Render symbol's half-hourly log table
    const logTbody = document.getElementById("intra-symbol-log-tbody");
    logTbody.innerHTML = "";
    const pts = [];
    for (const s of state.slots) {
      const cell = item.bySlot[s.slot];
      if (!cell) continue;
      pts.push({ ...cell, timeShort: s.timeShort });
      const tr = document.createElement("tr");
      const dCls = cell.delta_ltp > 0 ? "text-up" : cell.delta_ltp < 0 ? "text-down" : "text-flat";
      const dSign = cell.delta_ltp > 0 ? "+" : "";
      tr.innerHTML = `
        <td>${s.timeShort}</td>
        <td>${fmtNum(cell.ltp)}</td>
        <td class="${dCls}">${dSign}${fmtNum(cell.delta_ltp)}</td>
        <td>+${fmtInt(cell.delta_v)}</td>
        <td>+${fmtNum(cell.delta_val, 2)}M</td>
        <td>${fmtInt(cell.v)}</td>
      `;
      logTbody.appendChild(tr);
    }

    renderSymbolDualSVG(pts, item);
    renderIntradayTable();
  }

  function renderSymbolDualSVG(pts, item) {
    const svg = document.getElementById("intra-insp-svg");
    const ptsEl = document.getElementById("intra-insp-points");
    ptsEl.textContent = `${pts.length} half-hour slots`;

    const valid = pts.filter((p) => p.ltp && p.ltp > 0);
    if (valid.length === 0) {
      svg.innerHTML = `<text x="190" y="95" text-anchor="middle" fill="var(--text-muted)" font-size="12">No half-hourly trades recorded</text>`;
      return;
    }

    const w = 380;
    const h = 185;
    const padX = 24;
    const padTop = 22;
    const padBot = 26;
    const chartH = h - padTop - padBot;

    const prices = valid.map((p) => p.ltp);
    if (item.ycp && item.ycp > 0) prices.push(item.ycp);
    let minP = Math.min(...prices);
    let maxP = Math.max(...prices);
    if (minP === maxP) {
      minP -= 0.5;
      maxP += 0.5;
    }

    const maxVol = Math.max(...valid.map((p) => p.delta_v || 0), 1);

    const coords = valid.map((p, idx) => {
      const x = valid.length === 1 ? w / 2 : padX + (idx / (valid.length - 1)) * (w - padX * 2);
      const y = padTop + (1 - (p.ltp - minP) / (maxP - minP)) * chartH;
      const barH = ((p.delta_v || 0) / maxVol) * (chartH * 0.38);
      return { x, y, barH, p };
    });

    const isUp = valid[valid.length - 1].ltp >= (item.ycp || valid[0].ltp);
    const strokeColor = isUp ? "var(--up-color)" : "var(--down-color)";

    const barsSvg = coords
      .map(
        (c) =>
          `<rect x="${(c.x - 10).toFixed(1)}" y="${(h - padBot - c.barH).toFixed(1)}" width="20" height="${Math.max(2, c.barH).toFixed(1)}" fill="var(--accent-soft)" stroke="var(--accent-primary)" stroke-width="0.8" rx="2" />`
      )
      .join("");

    const linePts = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const dotsSvg = coords
      .map(
        (c) =>
          `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.8" fill="${strokeColor}" />
           <text x="${c.x.toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">${c.p.timeShort.replace(" AM", "a").replace(" PM", "p")}</text>`
      )
      .join("");

    svg.innerHTML = `
      <line x1="${padX}" y1="${padTop}" x2="${w - padX}" y2="${padTop}" stroke="var(--border-subtle)" stroke-dasharray="3,3" />
      <line x1="${padX}" y1="${h - padBot}" x2="${w - padX}" y2="${h - padBot}" stroke="var(--border-subtle)" />
      ${barsSvg}
      <polyline fill="none" stroke="${strokeColor}" stroke-width="2.4" points="${linePts}" />
      ${dotsSvg}
      <text x="${padX}" y="${padTop - 6}" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">Max: ${fmtNum(maxP)}</text>
      <text x="${w - padX}" y="${padTop - 6}" text-anchor="end" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">Min: ${fmtNum(minP)}</text>
    `;
  }

  async function loadData() {
    const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
    const savedKey = localStorage.getItem(STORAGE_ANON_KEY);

    if (savedUrl && savedKey) {
      try {
        await loadFromSupabaseLive(savedUrl, savedKey);
        return;
      } catch (e) {
        console.warn("Supabase live fetch failed, falling back to snapshot:", e);
      }
    }

    const resp = await fetch(`./data/market_data.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    state.sourceLabel = "Snapshot";
    buildIntradayState(payload);
    renderSlotStrip();
    renderSessionKPIs();
    renderIntradayTable();
    if (state.selectedSymbol) selectSymbol(state.selectedSymbol);
  }

  async function loadFromSupabaseLive(url, key) {
    const cleanUrl = url.replace(/\/+$/, "");
    const allRows = [];
    for (let page = 0; page < 4; page++) {
      const start = page * 1000;
      const end = start + 999;
      const resp = await fetch(
        `${cleanUrl}/rest/v1/dse_dynamic?select=*&order=timestamp.desc`,
        {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            Range: `${start}-${end}`,
          },
        }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const rows = await resp.json();
      allRows.push(...rows);
      if (rows.length < 1000) break;
    }

    const history = {};
    const latestDyn = [];
    const seen = new Set();
    for (const r of allRows) {
      if (!r.symbol) continue;
      if (!seen.has(r.symbol)) {
        seen.add(r.symbol);
        latestDyn.push(r);
      }
      const sKey = toDhakaSlotKey(r.timestamp);
      if (!history[r.symbol]) history[r.symbol] = [];
      history[r.symbol].push({
        t: r.timestamp,
        slot: sKey,
        ltp: r.ltp,
        high: r.high,
        low: r.low,
        ycp: r.ycp,
        chg: r.change,
        trd: r.trade,
        val: r.value,
        v: r.volume,
      });
    }
    for (const sym of Object.keys(history)) {
      history[sym].reverse();
    }

    state.sourceLabel = "Supabase Live";
    buildIntradayState({ dynamic: latestDyn, history });
    renderSlotStrip();
    renderSessionKPIs();
    renderIntradayTable();
    if (state.selectedSymbol) selectSymbol(state.selectedSymbol);
  }

  function exportIntradayCSV() {
    const rows = getFilteredSymbols();
    const slotHeaders = state.slots.map((s) => `"${s.timeShort} (${state.matrixMetric})"`).join(",");
    const lines = [`symbol,ycp,${slotHeaders},day_chg,pct_chg,cum_val_mn,cum_vol`];
    for (const r of rows) {
      const vals = state.slots.map((s) => {
        const c = r.bySlot[s.slot];
        const v = c ? getCellNumericValue(c) : "";
        return v ?? "";
      });
      lines.push([
        r.symbol,
        r.ycp ?? "",
        ...vals,
        r.latest_chg ?? "",
        r.latest_pct ?? "",
        r.latest_val ?? "",
        r.latest_vol ?? "",
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dse_half_hourly_${state.sessionDate}.csv`;
    a.click();
  }

  function initEvents() {
    document.getElementById("intraday-search-input").addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderIntradayTable();
    });

    document.getElementById("matrix-metric-select").addEventListener("change", (e) => {
      state.matrixMetric = e.target.value;
      renderIntradayTable();
    });

    document.querySelectorAll("#intraday-filter-group .filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#intraday-filter-group .filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeFilter = btn.dataset.filter;
        renderIntradayTable();
      });
    });

    document.getElementById("btn-export-intraday-csv").addEventListener("click", exportIntradayCSV);

    const savedTheme = localStorage.getItem(STORAGE_THEME_KEY) || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);
    const themeBtn = document.getElementById("btn-theme-toggle");
    themeBtn.textContent = savedTheme === "dark" ? "Light Mode" : "Dark Mode";
    themeBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(STORAGE_THEME_KEY, next);
      themeBtn.textContent = next === "dark" ? "Light Mode" : "Dark Mode";
    });

    const modal = document.getElementById("supabase-modal");
    const urlInput = document.getElementById("input-supabase-url");
    const keyInput = document.getElementById("input-supabase-key");

    document.getElementById("btn-supabase-config").addEventListener("click", () => {
      urlInput.value = localStorage.getItem(STORAGE_URL_KEY) || "";
      keyInput.value = localStorage.getItem(STORAGE_ANON_KEY) || "";
      modal.hidden = false;
    });

    document.getElementById("btn-close-modal").addEventListener("click", () => {
      modal.hidden = true;
    });

    document.getElementById("btn-clear-supabase").addEventListener("click", async () => {
      localStorage.removeItem(STORAGE_URL_KEY);
      localStorage.removeItem(STORAGE_ANON_KEY);
      modal.hidden = true;
      await loadData();
    });

    document.getElementById("btn-save-supabase").addEventListener("click", async () => {
      const u = urlInput.value.trim();
      const k = keyInput.value.trim();
      if (u && k) {
        localStorage.setItem(STORAGE_URL_KEY, u);
        localStorage.setItem(STORAGE_ANON_KEY, k);
        modal.hidden = true;
        await loadData();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    loadData().catch((err) => {
      console.error("Failed to load intraday data:", err);
      document.getElementById("intraday-session-text").textContent = "Session data unavailable";
    });
  });
})();
