(function () {
  "use strict";

  const STORAGE_URL_KEY = "zaman_dse_supabase_url";
  const STORAGE_ANON_KEY = "zaman_dse_supabase_key";
  const STORAGE_THEME_KEY = "zaman_dse_theme";

  let state = {
    rows: [],
    historyMap: {},
    generatedAt: null,
    sourceLabel: "GitHub Pages Snapshot",
    searchQuery: "",
    activeFilter: "all",
    sortField: "value",
    sortAsc: false,
    selectedSymbol: null,
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

  const fmtDhakaTime = (isoStr) => {
    if (!isoStr) return "Unknown time";
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return isoStr;
      return d.toLocaleString("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }) + " BST";
    } catch (_e) {
      return isoStr;
    }
  };

  function getBestPE(stat) {
    if (!stat) return null;
    const candidates = [stat.pe_1, stat.pe_2, stat.pe_3, stat.pe_4, stat.pe_5, stat.pe_6];
    for (const c of candidates) {
      const n = Number(c);
      if (c !== null && c !== undefined && !Number.isNaN(n) && n > 0) {
        return n;
      }
    }
    return null;
  }

  function mergeDatasets(dynamicList, staticList, historyObj) {
    const staticMap = {};
    for (const s of staticList || []) {
      if (!s || !s.symbol) continue;
      const info = s.info && typeof s.info === "object" ? s.info : {};
      staticMap[s.symbol] = {
        symbol: s.symbol,
        close: s.close ?? info.close ?? null,
        ycp: s.ycp ?? info.ycp ?? null,
        pe_1: s.pe_1 ?? info.pe_1 ?? null,
        pe_2: s.pe_2 ?? info.pe_2 ?? null,
        pe_3: s.pe_3 ?? info.pe_3 ?? null,
        pe_4: s.pe_4 ?? info.pe_4 ?? null,
        pe_5: s.pe_5 ?? info.pe_5 ?? null,
        pe_6: s.pe_6 ?? info.pe_6 ?? null,
        updated_at: s.updated_at ?? s.timestamp ?? null,
      };
    }

    const dynamicMap = {};
    for (const d of dynamicList || []) {
      if (!d || !d.symbol) continue;
      if (!dynamicMap[d.symbol]) {
        dynamicMap[d.symbol] = d;
      }
    }

    const allSymbols = Array.from(
      new Set([...Object.keys(dynamicMap), ...Object.keys(staticMap)])
    ).sort();

    const merged = [];
    for (const sym of allSymbols) {
      const d = dynamicMap[sym] || {};
      const s = staticMap[sym] || {};

      const ltp = d.ltp !== undefined && d.ltp !== null ? Number(d.ltp) : null;
      const ycp =
        d.ycp !== undefined && d.ycp !== null
          ? Number(d.ycp)
          : s.ycp !== undefined && s.ycp !== null
          ? Number(s.ycp)
          : null;
      const high = d.high !== undefined && d.high !== null ? Number(d.high) : null;
      const low = d.low !== undefined && d.low !== null ? Number(d.low) : null;
      const close =
        d.close !== undefined && d.close !== null && Number(d.close) > 0
          ? Number(d.close)
          : s.close !== undefined && s.close !== null && Number(s.close) > 0
          ? Number(s.close)
          : ltp;

      let change = d.change !== undefined && d.change !== null ? Number(d.change) : null;
      if ((change === null || Number.isNaN(change)) && ltp && ycp && ltp > 0 && ycp > 0) {
        change = Number((ltp - ycp).toFixed(2));
      }

      let pctChange = null;
      if (ltp && ycp && ltp > 0 && ycp > 0) {
        pctChange = Number((((ltp - ycp) / ycp) * 100).toFixed(2));
      } else if (change !== null && ycp && ycp > 0) {
        pctChange = Number(((change / ycp) * 100).toFixed(2));
      }

      const peBest = getBestPE(s);

      merged.push({
        symbol: sym,
        ltp,
        high,
        low,
        close,
        ycp,
        change,
        pct_change: pctChange,
        trade: d.trade !== undefined && d.trade !== null ? Number(d.trade) : 0,
        value: d.value !== undefined && d.value !== null ? Number(d.value) : 0,
        volume: d.volume !== undefined && d.volume !== null ? Number(d.volume) : 0,
        timestamp: d.timestamp || s.updated_at || null,
        pe_1: s.pe_1 !== undefined && s.pe_1 !== null ? Number(s.pe_1) : null,
        pe_2: s.pe_2 !== undefined && s.pe_2 !== null ? Number(s.pe_2) : null,
        pe_3: s.pe_3 !== undefined && s.pe_3 !== null ? Number(s.pe_3) : null,
        pe_4: s.pe_4 !== undefined && s.pe_4 !== null ? Number(s.pe_4) : null,
        pe_5: s.pe_5 !== undefined && s.pe_5 !== null ? Number(s.pe_5) : null,
        pe_6: s.pe_6 !== undefined && s.pe_6 !== null ? Number(s.pe_6) : null,
        pe_best: peBest,
      });
    }

    state.rows = merged;
    state.historyMap = historyObj || {};
    if (!state.selectedSymbol && merged.length > 0) {
      const topByVal = [...merged].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
      state.selectedSymbol = topByVal ? topByVal.symbol : merged[0].symbol;
    }
  }

  function renderKPIs() {
    let adv = 0;
    let dec = 0;
    let flat = 0;
    let totalVal = 0;
    let totalVol = 0;
    let totalTrades = 0;
    let activeSyms = 0;
    const positivePEs = [];

    for (const r of state.rows) {
      if (r.ltp && r.ltp > 0) {
        activeSyms++;
        if (r.change > 0) adv++;
        else if (r.change < 0) dec++;
        else flat++;
      }
      totalVal += r.value || 0;
      totalVol += r.volume || 0;
      totalTrades += r.trade || 0;
      if (r.pe_best && r.pe_best > 0 && r.pe_best < 500) {
        positivePEs.push(r.pe_best);
      }
    }

    const totalBreadth = Math.max(adv + dec + flat, 1);
    document.getElementById("kpi-breadth-summary").textContent = `${adv} / ${flat} / ${dec}`;
    document.getElementById("kpi-adv-count").textContent = `${adv} Adv`;
    document.getElementById("kpi-flat-count").textContent = `${flat} Unch`;
    document.getElementById("kpi-dec-count").textContent = `${dec} Dec`;

    document.getElementById("breadth-bar-up").style.width = `${((adv / totalBreadth) * 100).toFixed(1)}%`;
    document.getElementById("breadth-bar-flat").style.width = `${((flat / totalBreadth) * 100).toFixed(1)}%`;
    document.getElementById("breadth-bar-down").style.width = `${((dec / totalBreadth) * 100).toFixed(1)}%`;

    document.getElementById("kpi-total-value").textContent = `BDT ${fmtNum(totalVal, 2)} Mn`;
    document.getElementById("kpi-total-trades").textContent = `${fmtInt(totalTrades)} total trades`;
    document.getElementById("kpi-total-volume").textContent = fmtInt(totalVol);
    document.getElementById("kpi-active-symbols").textContent = `${activeSyms} traded / ${state.rows.length} listed`;

    positivePEs.sort((a, b) => a - b);
    const medianPE =
      positivePEs.length > 0
        ? positivePEs[Math.floor(positivePEs.length / 2)]
        : null;
    document.getElementById("kpi-median-pe").textContent = medianPE ? `${fmtNum(medianPE, 2)}x` : "--";
    document.getElementById("kpi-pe-coverage").textContent = `${positivePEs.length} companies with P/E data`;

    const badgeText = document.getElementById("last-updated-text");
    badgeText.textContent = `${state.sourceLabel}: ${fmtDhakaTime(state.generatedAt)}`;
  }

  function renderMiniList(containerId, items, metricFormatter) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = "";
    for (const item of items) {
      const div = document.createElement("div");
      div.className = "mini-row";
      div.innerHTML = `
        <span class="mini-sym">${item.symbol}</span>
        <div class="mini-metrics">${metricFormatter(item)}</div>
      `;
      div.addEventListener("click", () => selectSymbol(item.symbol));
      el.appendChild(div);
    }
  }

  function renderTopMovers() {
    const traded = state.rows.filter((r) => r.ltp && r.ltp > 0 && r.pct_change !== null);

    const topGainers = [...traded]
      .filter((r) => r.pct_change > 0)
      .sort((a, b) => b.pct_change - a.pct_change)
      .slice(0, 5);

    const topLosers = [...traded]
      .filter((r) => r.pct_change < 0)
      .sort((a, b) => a.pct_change - b.pct_change)
      .slice(0, 5);

    const topValue = [...state.rows]
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    const lowPE = [...state.rows]
      .filter((r) => r.ltp > 0 && r.pe_best && r.pe_best > 0)
      .sort((a, b) => a.pe_best - b.pe_best)
      .slice(0, 5);

    renderMiniList("list-top-gainers", topGainers, (r) =>
      `<span>${fmtNum(r.ltp)}</span><span class="badge badge-up">+${fmtNum(r.pct_change)}%</span>`
    );

    renderMiniList("list-top-losers", topLosers, (r) =>
      `<span>${fmtNum(r.ltp)}</span><span class="badge badge-down">${fmtNum(r.pct_change)}%</span>`
    );

    renderMiniList("list-top-value", topValue, (r) =>
      `<span class="text-up">${fmtNum(r.value)} Mn</span><span>${fmtNum(r.ltp)}</span>`
    );

    renderMiniList("list-low-pe", lowPE, (r) =>
      `<span class="badge badge-up">${fmtNum(r.pe_best)}x</span><span>${fmtNum(r.ltp)}</span>`
    );
  }

  function getFilteredAndSortedRows() {
    const q = state.searchQuery.trim().toUpperCase();
    let list = state.rows.filter((r) => {
      if (q && !r.symbol.toUpperCase().includes(q)) return false;
      if (state.activeFilter === "gainers") return r.change !== null && r.change > 0;
      if (state.activeFilter === "losers") return r.change !== null && r.change < 0;
      if (state.activeFilter === "active") return r.value && r.value >= 10;
      if (state.activeFilter === "low_pe") return r.pe_best && r.pe_best > 0 && r.pe_best < 15;
      return true;
    });

    const field = state.sortField;
    const dir = state.sortAsc ? 1 : -1;

    list.sort((a, b) => {
      const va = a[field];
      const vb = b[field];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string") {
        return va.localeCompare(vb) * dir;
      }
      return (va - vb) * dir;
    });

    return list;
  }

  function renderTable() {
    const tbody = document.getElementById("screener-tbody");
    const rows = getFilteredAndSortedRows();
    const fragment = document.createDocumentFragment();

    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.symbol === state.selectedSymbol) {
        tr.classList.add("selected");
      }

      let dirClass = "text-flat";
      let badgeClass = "badge-flat";
      let sign = "";
      if (r.change > 0) {
        dirClass = "text-up";
        badgeClass = "badge-up";
        sign = "+";
      } else if (r.change < 0) {
        dirClass = "text-down";
        badgeClass = "badge-down";
      }

      const chgStr = r.change !== null ? `${sign}${fmtNum(r.change)}` : "--";
      const pctStr = r.pct_change !== null ? `${sign}${fmtNum(r.pct_change)}%` : "--";

      tr.innerHTML = `
        <td>${r.symbol}</td>
        <td class="${dirClass}">${fmtNum(r.ltp)}</td>
        <td class="${dirClass}">${chgStr}</td>
        <td><span class="badge ${badgeClass}">${pctStr}</span></td>
        <td>${fmtNum(r.ycp)}</td>
        <td>${fmtNum(r.high)}</td>
        <td>${fmtNum(r.low)}</td>
        <td>${fmtInt(r.volume)}</td>
        <td>${fmtNum(r.value, 2)}</td>
        <td>${fmtInt(r.trade)}</td>
        <td>${r.pe_best ? fmtNum(r.pe_best, 2) : "--"}</td>
      `;

      tr.addEventListener("click", () => selectSymbol(r.symbol));
      fragment.appendChild(tr);
    }

    tbody.innerHTML = "";
    tbody.appendChild(fragment);
  }

  function renderSVGChart(symbol, row) {
    const svg = document.getElementById("insp-price-svg");
    const ptsLabel = document.getElementById("insp-chart-points");
    if (!svg) return;

    let series = (state.historyMap && state.historyMap[symbol]) ? [...state.historyMap[symbol]] : [];
    series = series.filter((p) => p && p.ltp !== null && p.ltp !== undefined && Number(p.ltp) > 0);

    // If only 1 timestamp is available, synthesize an intraday reference path using YCP -> Low -> High -> LTP
    let isSynthetic = false;
    if (series.length < 2 && row) {
      isSynthetic = true;
      const pts = [];
      if (row.ycp > 0) pts.push({ label: "YCP", ltp: row.ycp });
      if (row.low > 0) pts.push({ label: "Day Low", ltp: row.low });
      if (row.high > 0) pts.push({ label: "Day High", ltp: row.high });
      if (row.ltp > 0) pts.push({ label: "LTP", ltp: row.ltp });
      series = pts;
    }

    if (series.length === 0) {
      svg.innerHTML = `<text x="190" y="95" text-anchor="middle" fill="var(--text-muted)" font-size="12">No traded price points available</text>`;
      ptsLabel.textContent = "0 pts";
      return;
    }

    ptsLabel.textContent = isSynthetic ? "Intraday Range Profile" : `${series.length} snapshots`;

    const w = 380;
    const h = 185;
    const padX = 14;
    const padY = 22;

    const prices = series.map((p) => Number(p.ltp));
    let minP = Math.min(...prices);
    let maxP = Math.max(...prices);
    if (minP === maxP) {
      minP -= 0.5;
      maxP += 0.5;
    }

    const isUp = prices[prices.length - 1] >= prices[0];
    const strokeColor = isUp ? "var(--up-color)" : "var(--down-color)";
    const fillColor = isUp ? "rgba(16, 185, 129, 0.16)" : "rgba(244, 63, 94, 0.16)";

    const coords = series.map((pt, i) => {
      const x =
        series.length === 1
          ? w / 2
          : padX + (i / (series.length - 1)) * (w - padX * 2);
      const y =
        padY + (1 - (Number(pt.ltp) - minP) / (maxP - minP)) * (h - padY * 2);
      return { x, y, pt };
    });

    const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const areaPoints = `${coords[0].x.toFixed(1)},${h - padY} ${polylinePoints} ${coords[coords.length - 1].x.toFixed(1)},${h - padY}`;

    const circles = coords
      .map(
        (c) =>
          `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.2" fill="${strokeColor}" />`
      )
      .join("");

    svg.innerHTML = `
      <line x1="${padX}" y1="${padY}" x2="${w - padX}" y2="${padY}" stroke="var(--border-subtle)" stroke-dasharray="3,3" />
      <line x1="${padX}" y1="${h - padY}" x2="${w - padX}" y2="${h - padY}" stroke="var(--border-subtle)" stroke-dasharray="3,3" />
      <polygon points="${areaPoints}" fill="${fillColor}" />
      <polyline fill="none" stroke="${strokeColor}" stroke-width="2.2" points="${polylinePoints}" />
      ${circles}
      <text x="${padX}" y="${padY - 6}" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">High: ${fmtNum(maxP)}</text>
      <text x="${padX}" y="${h - 5}" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">Low: ${fmtNum(minP)}</text>
    `;
  }

  function selectSymbol(symbol) {
    state.selectedSymbol = symbol;
    const row = state.rows.find((r) => r.symbol === symbol);
    if (!row) return;

    document.getElementById("insp-symbol").textContent = row.symbol;
    document.getElementById("insp-updated").textContent = fmtDhakaTime(row.timestamp || state.generatedAt);
    document.getElementById("insp-ltp").textContent = row.ltp ? `BDT ${fmtNum(row.ltp)}` : "--";

    const badge = document.getElementById("insp-change-badge");
    badge.className = "badge";
    if (row.change > 0) {
      badge.classList.add("badge-up");
      badge.textContent = `+${fmtNum(row.change)} (+${fmtNum(row.pct_change)}%)`;
    } else if (row.change < 0) {
      badge.classList.add("badge-down");
      badge.textContent = `${fmtNum(row.change)} (${fmtNum(row.pct_change)}%)`;
    } else {
      badge.classList.add("badge-flat");
      badge.textContent = "0.00 (0.00%)";
    }

    document.getElementById("insp-low-label").textContent = `Low: ${fmtNum(row.low)}`;
    document.getElementById("insp-high-label").textContent = `High: ${fmtNum(row.high)}`;
    const rangeFill = document.getElementById("insp-range-fill");
    if (row.high && row.low && row.high > row.low && row.ltp) {
      const pct = Math.min(100, Math.max(0, ((row.ltp - row.low) / (row.high - row.low)) * 100));
      rangeFill.style.width = `${pct.toFixed(1)}%`;
    } else {
      rangeFill.style.width = "50%";
    }

    document.getElementById("insp-ycp").textContent = fmtNum(row.ycp);
    document.getElementById("insp-close").textContent = fmtNum(row.close);
    document.getElementById("insp-volume").textContent = fmtInt(row.volume);
    document.getElementById("insp-value").textContent = `${fmtNum(row.value)} Mn`;
    document.getElementById("insp-trade").textContent = fmtInt(row.trade);
    const avgTrade =
      row.trade && row.trade > 0 && row.value
        ? (row.value * 1000000) / row.trade
        : null;
    document.getElementById("insp-avg-trade").textContent = avgTrade ? `BDT ${fmtInt(avgTrade)}` : "--";

    document.getElementById("insp-pe1").textContent = row.pe_1 ? `${fmtNum(row.pe_1)}x` : "n/a";
    document.getElementById("insp-pe2").textContent = row.pe_2 ? `${fmtNum(row.pe_2)}x` : "n/a";
    document.getElementById("insp-pe3").textContent = row.pe_3 ? `${fmtNum(row.pe_3)}x` : "n/a";
    document.getElementById("insp-pe4").textContent = row.pe_4 ? `${fmtNum(row.pe_4)}x` : "n/a";
    document.getElementById("insp-pe5").textContent = row.pe_5 ? `${fmtNum(row.pe_5)}x` : "n/a";
    document.getElementById("insp-pe6").textContent = row.pe_6 ? `${fmtNum(row.pe_6)}x` : "n/a";

    renderSVGChart(symbol, row);
    renderTable();
  }

  async function loadSnapshotData() {
    const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
    const savedKey = localStorage.getItem(STORAGE_ANON_KEY);

    if (savedUrl && savedKey) {
      try {
        await fetchFromSupabaseLive(savedUrl, savedKey);
        return;
      } catch (err) {
        console.warn("Live Supabase fetch failed, falling back to GitHub Pages snapshot:", err);
      }
    }

    const resp = await fetch(`./data/market_data.json?t=${Date.now()}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} loading market_data.json`);
    }
    const payload = await resp.json();
    state.generatedAt = payload.generated_at;
    state.sourceLabel = "Snapshot";
    mergeDatasets(payload.dynamic, payload.static, payload.history);
    renderKPIs();
    renderTopMovers();
    renderTable();
    if (state.selectedSymbol) {
      selectSymbol(state.selectedSymbol);
    }
  }

  async function fetchFromSupabaseLive(url, key) {
    const cleanUrl = url.replace(/\/+$/, "");
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
    };

    const [dynResp, statResp] = await Promise.all([
      fetch(`${cleanUrl}/rest/v1/dse_dynamic?select=*&order=timestamp.desc&limit=2500`, { headers }),
      fetch(`${cleanUrl}/rest/v1/dse_static?select=*&limit=1000`, { headers }),
    ]);

    if (!dynResp.ok || !statResp.ok) {
      throw new Error("Supabase REST API rejected request. Check URL, anon key, and RLS SELECT policies.");
    }

    const dynRows = await dynResp.json();
    const statRows = await statResp.json();

    const historyMap = {};
    const latestDyn = [];
    const seen = new Set();

    for (const r of dynRows) {
      if (!r.symbol) continue;
      if (!seen.has(r.symbol)) {
        seen.add(r.symbol);
        latestDyn.push(r);
      }
      if (!historyMap[r.symbol]) historyMap[r.symbol] = [];
      historyMap[r.symbol].push({
        t: r.timestamp,
        ltp: r.ltp,
        v: r.volume,
        val: r.value,
        chg: r.change,
      });
    }
    for (const sym of Object.keys(historyMap)) {
      historyMap[sym].reverse();
    }

    state.generatedAt = latestDyn[0]?.timestamp || new Date().toISOString();
    state.sourceLabel = "Supabase Live";
    mergeDatasets(latestDyn, statRows, historyMap);
    renderKPIs();
    renderTopMovers();
    renderTable();
    if (state.selectedSymbol) {
      selectSymbol(state.selectedSymbol);
    }
  }

  function exportCurrentTableCSV() {
    const rows = getFilteredAndSortedRows();
    const headers = [
      "symbol", "ltp", "change", "pct_change", "ycp", "high", "low",
      "volume", "value_mn", "trades", "pe_1", "pe_2", "pe_3", "pe_4", "pe_5", "pe_6", "timestamp"
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push([
        r.symbol,
        r.ltp ?? "",
        r.change ?? "",
        r.pct_change ?? "",
        r.ycp ?? "",
        r.high ?? "",
        r.low ?? "",
        r.volume ?? "",
        r.value ?? "",
        r.trade ?? "",
        r.pe_1 ?? "",
        r.pe_2 ?? "",
        r.pe_3 ?? "",
        r.pe_4 ?? "",
        r.pe_5 ?? "",
        r.pe_6 ?? "",
        r.timestamp ?? "",
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dse_screener_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function initEvents() {
    // Search input
    document.getElementById("symbol-search-input").addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderTable();
    });

    // Filter pills
    document.querySelectorAll("#screener-filter-group .filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#screener-filter-group .filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeFilter = btn.dataset.filter;
        renderTable();
      });
    });

    // Table column sorting
    document.querySelectorAll("#screener-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (state.sortField === field) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortField = field;
          state.sortAsc = field === "symbol" || field === "pe_best";
        }
        renderTable();
      });
    });

    // CSV Export
    document.getElementById("btn-export-csv").addEventListener("click", exportCurrentTableCSV);

    // Theme toggle
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

    // Supabase Live Modal
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
      await loadSnapshotData();
    });

    document.getElementById("btn-save-supabase").addEventListener("click", async () => {
      const u = urlInput.value.trim();
      const k = keyInput.value.trim();
      if (u && k) {
        localStorage.setItem(STORAGE_URL_KEY, u);
        localStorage.setItem(STORAGE_ANON_KEY, k);
        modal.hidden = true;
        await loadSnapshotData();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    loadSnapshotData().catch((err) => {
      console.error("Error loading market data:", err);
      document.getElementById("last-updated-text").textContent = "Snapshot unavailable";
    });
  });
})();
