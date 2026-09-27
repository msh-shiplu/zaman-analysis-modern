(function () {
  "use strict";

  const STORAGE_URL_KEY = "zaman_dse_supabase_url";
  const STORAGE_ANON_KEY = "zaman_dse_supabase_key";
  const STORAGE_HOURLY_THEME_KEY = "zaman_dse_hourly_theme";

  const STANDARD_WINDOWS = [
    { mins: 600, label: "10:00 AM" },
    { mins: 630, label: "10:30 AM" },
    { mins: 660, label: "11:00 AM" },
    { mins: 690, label: "11:30 AM" },
    { mins: 720, label: "12:00 PM" },
    { mins: 750, label: "12:30 PM" },
    { mins: 780, label: "1:00 PM" },
    { mins: 810, label: "1:30 PM" },
    { mins: 840, label: "2:00 PM" },
    { mins: 870, label: "2:30 PM" },
  ];

  let state = {
    sessionDate: "--",
    sourceLabel: "Snapshot",
    rawSlots: [], // sorted raw BST slot keys ["2026-09-27 10:50", ...]
    windowToRawSlot: {}, // { 600: "2026-09-27 10:00", 660: "2026-09-27 10:50", ... }
    stocks: [], // [{ symbol, sector, category, pe1, pe2, rawBySlot: { [rawSlot]: { v, ltp, val } } }]
    sectors: [], // sorted list of sector names
    searchQuery: "",
    selectedSector: "all",
    windowMode: "standard", // "standard" | "populated" | "raw"
    deltaMetric: "vol", // "vol" | "val" | "ltp"
    colorCode: true,
  };

  const fmtInt = (val) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0";
    return Math.round(Number(val)).toLocaleString("en-US");
  };

  const fmtCompact = (val, maxDecimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0";
    const n = Number(Number(val).toFixed(maxDecimals));
    if (n === 0) return "0";
    return n.toString();
  };

  function toDhakaSlotKey(isoStr) {
    if (!isoStr) return "";
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 16).replace("T", " ");
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
      const hh = map.hour === "24" ? "00" : map.hour;
      return `${map.year}-${map.month}-${map.day} ${hh}:${map.minute}`;
    } catch (_e) {
      return String(isoStr).slice(0, 16).replace("T", " ");
    }
  }

  function formatSlotTimeLabel(slotKey) {
    const timePart = slotKey.split(" ")[1] || slotKey;
    const [hhStr, mmStr] = timePart.split(":");
    const hh = Number(hhStr);
    if (Number.isNaN(hh)) return timePart;
    const period = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${mmStr} ${period}`;
  }

  function slotKeyToMinutes(slotKey) {
    const timePart = slotKey.split(" ")[1] || "";
    const [hhStr, mmStr] = timePart.split(":");
    const hh = Number(hhStr);
    const mm = Number(mmStr);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  }

  function mapRawSlotsToStandardWindows(rawSlotKeys) {
    const mapping = {};
    const bestDist = {};

    for (const sKey of rawSlotKeys) {
      const mins = slotKeyToMinutes(sKey);
      if (mins === null) continue;

      if (mins >= 580 && mins <= 885) {
        // Snap to nearest 30m window between 10:00 AM (600) and 2:30 PM (870)
        const snapped = Math.min(870, Math.max(600, Math.round(mins / 30) * 30));
        const dist = Math.abs(mins - snapped);
        if (mapping[snapped] === undefined || dist <= bestDist[snapped]) {
          mapping[snapped] = sKey;
          bestDist[snapped] = dist;
        }
      } else if (mins > 885) {
        // Post-close snapshot represents the 2:30 PM (870) closing state if 2:30 PM wasn't captured live
        if (mapping[870] === undefined) {
          mapping[870] = sKey;
          bestDist[870] = mins - 870;
        }
      }
    }
    return mapping;
  }

  function buildHourlyState(payload, symbolMetaFallback) {
    const history = payload.history || {};
    const dynamicLatest = payload.dynamic || [];
    const staticLatest = payload.static || [];
    const symbolMeta = { ...(symbolMetaFallback || {}), ...(payload.symbol_meta || {}) };

    const dynMap = {};
    for (const d of dynamicLatest) {
      if (d && d.symbol) dynMap[d.symbol] = d;
    }

    const statMap = {};
    for (const s of staticLatest) {
      if (!s || !s.symbol) continue;
      const info = s.info && typeof s.info === "object" ? s.info : {};
      statMap[s.symbol] = {
        pe_1: s.pe_1 ?? info.pe_1 ?? null,
        pe_2: s.pe_2 ?? info.pe_2 ?? null,
        sector: s.sector ?? info.sector ?? null,
        category: s.category ?? info.category ?? null,
      };
    }

    const allSlotSet = new Set();
    const allSymbolKeys = Array.from(
      new Set([...Object.keys(history), ...Object.keys(dynMap)])
    ).sort();

    for (const sym of allSymbolKeys) {
      const pts = history[sym] || [];
      for (const p of pts) {
        const sKey = p.t ? toDhakaSlotKey(p.t) : (p.slot || "");
        if (!sKey) continue;
        p._bstSlot = sKey;
        allSlotSet.add(sKey);
      }
    }

    const sortedAllSlots = Array.from(allSlotSet).sort();
    const latestDate =
      payload.intraday_date_bst ||
      (sortedAllSlots.length > 0 ? sortedAllSlots[sortedAllSlots.length - 1].split(" ")[0] : "--");

    const todaySlots = sortedAllSlots.filter((k) => k.startsWith(latestDate));
    const activeRawSlots = todaySlots.length > 0 ? todaySlots : sortedAllSlots;
    const windowToRawSlot = mapRawSlotsToStandardWindows(activeRawSlots);

    const stocks = [];
    const sectorSet = new Set();

    for (const sym of allSymbolKeys) {
      if (/^TB\d+Y/i.test(sym)) continue;
      const st = statMap[sym] || {};
      const sm = symbolMeta[sym] || {};
      const sector = st.sector || sm.sector || "Others";
      if (/G-SEC|T\.BOND/i.test(sector)) continue;
      const category = st.category || sm.category || "";
      sectorSet.add(sector);

      const rawBySlot = {};
      const pts = (history[sym] || []).filter((p) => activeRawSlots.includes(p._bstSlot));
      for (const p of pts) {
        rawBySlot[p._bstSlot] = {
          v: Number(p.v || 0),
          ltp: Number(p.ltp || 0),
          val: Number(p.val || 0),
        };
      }

      stocks.push({
        symbol: sym,
        sector,
        category,
        pe1: st.pe_1,
        pe2: st.pe_2,
        rawBySlot,
      });
    }

    const sortedSectors = Array.from(sectorSet).sort((a, b) => a.localeCompare(b));

    state.sessionDate = latestDate;
    state.rawSlots = activeRawSlots;
    state.windowToRawSlot = windowToRawSlot;
    state.stocks = stocks;
    state.sectors = sortedSectors;

    populateSectorSelect(sortedSectors);
    updateSessionBadge();
  }

  function populateSectorSelect(sectors) {
    const select = document.getElementById("sector-filter-select");
    const currentVal = state.selectedSector;
    select.innerHTML = `<option value="all">All Industries / Sectors (${sectors.length})</option>`;
    for (const sec of sectors) {
      const count = state.stocks.filter((s) => s.sector === sec).length;
      const opt = document.createElement("option");
      opt.value = sec;
      opt.textContent = `${sec} (${count})`;
      select.appendChild(opt);
    }
    if (sectors.includes(currentVal)) {
      select.value = currentVal;
    } else {
      state.selectedSector = "all";
    }
  }

  function updateSessionBadge() {
    const badgeText = document.getElementById("hourly-session-text");
    const populatedCount = Object.keys(state.windowToRawSlot).length;
    badgeText.textContent = `${state.sourceLabel}: ${state.sessionDate} (${populatedCount} windows)`;
  }

  function getActiveColumns() {
    if (state.windowMode === "raw") {
      return state.rawSlots.map((sKey) => ({
        key: sKey,
        label: formatSlotTimeLabel(sKey),
        rawSlot: sKey,
      }));
    }

    if (state.windowMode === "populated") {
      return STANDARD_WINDOWS.filter((w) => state.windowToRawSlot[w.mins]).map((w) => ({
        key: `w_${w.mins}`,
        label: w.label,
        rawSlot: state.windowToRawSlot[w.mins],
      }));
    }

    // Default: "standard" — 10:00 AM, 10:30 AM, 11:00 AM, ..., up to the latest window (or 2:30 PM)
    const populatedMins = Object.keys(state.windowToRawSlot).map(Number);
    const maxMins = populatedMins.length > 0 ? Math.max(...populatedMins, 870) : 870;
    return STANDARD_WINDOWS.filter((w) => w.mins <= maxMins).map((w) => ({
      key: `w_${w.mins}`,
      label: w.label,
      rawSlot: state.windowToRawSlot[w.mins] || null,
    }));
  }

  function formatStockNameCell(stock) {
    const pe1Str = stock.pe1 !== null && stock.pe1 !== undefined && Number(stock.pe1) > 0
      ? fmtCompact(stock.pe1, 2)
      : "0";
    const pe2Str = stock.pe2 !== null && stock.pe2 !== undefined && Number(stock.pe2) > 0
      ? fmtCompact(stock.pe2, 2)
      : "0";
    const detailUrl = `./detail.html?symbol=${encodeURIComponent(stock.symbol)}`;
    const catHtml = stock.category ? `<sub class="stock-cat-sub">${stock.category}</sub>` : "";
    return `<sub class="stock-pe-sub">${pe1Str}/${pe2Str}</sub><a href="${detailUrl}" class="stock-code-link">${stock.symbol}</a>${catHtml}`;
  }

  function renderHourlyTables() {
    const container = document.getElementById("hourly-sectors-container");
    container.className = state.colorCode ? "color-coded" : "";
    container.innerHTML = "";

    const cols = getActiveColumns();
    const q = state.searchQuery.trim().toUpperCase();

    const sectorsToRender =
      state.selectedSector === "all"
        ? state.sectors
        : state.sectors.filter((s) => s === state.selectedSector);

    const frag = document.createDocumentFragment();
    let totalRendered = 0;

    for (const sectorName of sectorsToRender) {
      const sectorStocks = state.stocks.filter((s) => {
        if (s.sector !== sectorName) return false;
        if (q && !s.symbol.toUpperCase().includes(q)) return false;
        return true;
      });

      if (sectorStocks.length === 0) continue;
      totalRendered += sectorStocks.length;

      const section = document.createElement("div");
      section.className = "industry-section";

      const heading = document.createElement("h2");
      heading.className = "industry-heading";
      heading.textContent = `Industry Name: ${sectorName}`;
      section.appendChild(heading);

      const tableWrap = document.createElement("div");
      tableWrap.className = "hourly-table-wrap";

      const colHeadersHtml = cols.map((c) => `<th>${c.label}</th>`).join("");

      const rowsHtml = sectorStocks
        .map((stock) => {
          let prevData = null;
          let seenFirstPopulated = false;

          const cellsHtml = cols
            .map((col, colIdx) => {
              const data = col.rawSlot ? stock.rawBySlot[col.rawSlot] : null;
              if (!data) {
                return `<td><div class="hr-cell"><span class="text-flat">-</span></div></td>`;
              }

              const volStr = fmtInt(data.v);
              const ltpStr = fmtCompact(data.ltp, 2);

              let ltpDirClass = "";
              if (prevData && data.ltp > 0 && prevData.ltp > 0) {
                if (data.ltp > prevData.ltp) ltpDirClass = "up";
                else if (data.ltp < prevData.ltp) ltpDirClass = "down";
              }

              // Very first window of the day (10:00 AM or first populated column) shows 2 values: Volume & LTP
              if (!seenFirstPopulated && colIdx === 0) {
                seenFirstPopulated = true;
                prevData = data;
                return `<td>
                  <div class="hr-cell">
                    <div class="hr-vol">${volStr}</div>
                    <div class="hr-ltp ${ltpDirClass}">${ltpStr}</div>
                  </div>
                </td>`;
              }

              seenFirstPopulated = true;

              // Calculate 3rd value: change from previous populated window
              let deltaStr = "0";
              if (prevData) {
                if (state.deltaMetric === "vol") {
                  const dVol = Math.max(0, data.v - prevData.v);
                  deltaStr = fmtInt(dVol);
                } else if (state.deltaMetric === "val") {
                  const dVal = Math.max(0, Number((data.val - prevData.val).toFixed(3)));
                  deltaStr = fmtCompact(dVal, 3);
                } else if (state.deltaMetric === "ltp") {
                  const dLtp =
                    data.ltp > 0 && prevData.ltp > 0
                      ? Number((data.ltp - prevData.ltp).toFixed(2))
                      : 0;
                  deltaStr = (dLtp > 0 ? "+" : "") + fmtCompact(dLtp, 2);
                }
              } else {
                // If earlier columns had no snapshot, first populated mid-day column shows 2 lines (Volume & LTP)
                prevData = data;
                return `<td>
                  <div class="hr-cell">
                    <div class="hr-vol">${volStr}</div>
                    <div class="hr-ltp ${ltpDirClass}">${ltpStr}</div>
                  </div>
                </td>`;
              }

              prevData = data;

              return `<td>
                <div class="hr-cell">
                  <div class="hr-vol">${volStr}</div>
                  <div class="hr-ltp ${ltpDirClass}">${ltpStr}</div>
                  <div class="hr-delta">${deltaStr}</div>
                </div>
              </td>`;
            })
            .join("");

          return `<tr>
            <td class="stock-name-cell">${formatStockNameCell(stock)}</td>
            ${cellsHtml}
          </tr>`;
        })
        .join("");

      tableWrap.innerHTML = `
        <table class="hourly-sector-table">
          <thead>
            <tr>
              <th>Name of Stock</th>
              ${colHeadersHtml}
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      `;

      section.appendChild(tableWrap);
      frag.appendChild(section);
    }

    if (totalRendered === 0) {
      container.innerHTML = `<div class="kpi-card" style="text-align: center; padding: 32px;">No matching stocks found.</div>`;
    } else {
      container.appendChild(frag);
    }
  }

  async function fetchSymbolMetaFallback() {
    try {
      const resp = await fetch(`./data/symbol_meta.json?t=${Date.now()}`);
      if (resp.ok) return await resp.json();
    } catch (_e) {
      // Ignore fallback error
    }
    return {};
  }

  async function loadData() {
    const symbolMetaFallback = await fetchSymbolMetaFallback();
    const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
    const savedKey = localStorage.getItem(STORAGE_ANON_KEY);

    if (savedUrl && savedKey) {
      try {
        await loadFromSupabaseLive(savedUrl, savedKey, symbolMetaFallback);
        return;
      } catch (e) {
        console.warn("Supabase live fetch failed, falling back to snapshot:", e);
      }
    }

    const resp = await fetch(`./data/market_data.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    state.sourceLabel = "Snapshot";
    buildHourlyState(payload, symbolMetaFallback);
    renderHourlyTables();
  }

  async function loadFromSupabaseLive(url, key, symbolMetaFallback) {
    const cleanUrl = url.replace(/\/+$/, "");
    const allRows = [];
    for (let page = 0; page < 5; page++) {
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

    let staticRows = [];
    try {
      const statResp = await fetch(`${cleanUrl}/rest/v1/dse_static?select=*&limit=1000`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });
      if (statResp.ok) staticRows = await statResp.json();
    } catch (_e) {
      // Optional static fetch
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
    buildHourlyState({ dynamic: latestDyn, static: staticRows, history }, symbolMetaFallback);
    renderHourlyTables();
  }

  function exportHourlyCSV() {
    const cols = getActiveColumns();
    const colHeaders = cols.map((c) => `"${c.label} (Vol | LTP | Delta)"`).join(",");
    const lines = [`industry,symbol,category,pe_1,pe_2,${colHeaders}`];
    const q = state.searchQuery.trim().toUpperCase();

    for (const stock of state.stocks) {
      if (state.selectedSector !== "all" && stock.sector !== state.selectedSector) continue;
      if (q && !stock.symbol.toUpperCase().includes(q)) continue;

      let prevData = null;
      const cellStrs = cols.map((col) => {
        const data = col.rawSlot ? stock.rawBySlot[col.rawSlot] : null;
        if (!data) return `"-"`;
        let deltaVal = 0;
        if (prevData) {
          if (state.deltaMetric === "vol") deltaVal = Math.max(0, data.v - prevData.v);
          else if (state.deltaMetric === "val") deltaVal = Math.max(0, Number((data.val - prevData.val).toFixed(3)));
          else if (state.deltaMetric === "ltp") deltaVal = Number((data.ltp - prevData.ltp).toFixed(2));
        }
        const str = prevData
          ? `${data.v} / ${fmtCompact(data.ltp, 2)} / ${deltaVal}`
          : `${data.v} / ${fmtCompact(data.ltp, 2)}`;
        prevData = data;
        return `"${str}"`;
      });

      lines.push([
        `"${stock.sector}"`,
        stock.symbol,
        stock.category || "",
        stock.pe1 ?? 0,
        stock.pe2 ?? 0,
        ...cellStrs,
      ].join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dse_hourly_analysis_${state.sessionDate}.csv`;
    a.click();
  }

  function initEvents() {
    document.getElementById("hourly-search-input").addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderHourlyTables();
    });

    document.getElementById("sector-filter-select").addEventListener("change", (e) => {
      state.selectedSector = e.target.value;
      renderHourlyTables();
    });

    document.getElementById("window-mode-select").addEventListener("change", (e) => {
      state.windowMode = e.target.value;
      renderHourlyTables();
    });

    document.getElementById("delta-metric-select").addEventListener("change", (e) => {
      state.deltaMetric = e.target.value;
      const labelEl = document.getElementById("legend-third-label");
      if (state.deltaMetric === "vol") labelEl.textContent = "Δ Volume from prev window";
      else if (state.deltaMetric === "val") labelEl.textContent = "Δ Value (Mn) from prev window";
      else labelEl.textContent = "Δ LTP from prev window";
      renderHourlyTables();
    });

    document.getElementById("chk-color-code").addEventListener("change", (e) => {
      state.colorCode = e.target.checked;
      renderHourlyTables();
    });

    document.getElementById("btn-export-hourly-csv").addEventListener("click", exportHourlyCSV);

    const savedTheme = localStorage.getItem(STORAGE_HOURLY_THEME_KEY) || "light";
    document.documentElement.setAttribute("data-theme", savedTheme);
    const themeBtn = document.getElementById("btn-theme-toggle");
    themeBtn.textContent = savedTheme === "dark" ? "Light Mode" : "Dark Mode";
    themeBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(STORAGE_HOURLY_THEME_KEY, next);
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
      console.error("Failed to load hourly analysis data:", err);
      document.getElementById("hourly-session-text").textContent = "Session data unavailable";
    });
  });
})();
