/**
 * Zaman Analysis — Daily Analysis Controller
 * Renders:
 * 1. Top "DSE Index Information" table across recent trading dates (DD-MM-YYYY)
 *    with rows: DSE X, Total value in taka, Issue Advanced, Issue Declined,
 *    Issue Unchanged, DSE S, DSE 30.
 * 2. Bottom sector-by-sector tables ("Industry Name: <Sector>") where each stock
 *    links to ./detail.html?symbol=SYMBOL and each date cell displays 2 stacked
 *    values: Volume and Closing Price / LTP.
 */

const state = {
  indexHistory: [],
  daily3m: {},
  marketData: null,
  symbolMeta: {},
  searchQuery: "",
  selectedSector: "all",
  daysLimit: 10,
  colorCode: true,
  theme: localStorage.getItem("zaman_dse_theme") || "dark",
};

const fmtInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtPrice = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function toNum(v) {
  if (v === null || v === undefined || v === "" || v === "--") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatDateDDMMYYYY(isoDate) {
  if (!isoDate || isoDate.length < 10) return isoDate || "--";
  const parts = isoDate.slice(0, 10).split("-");
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem("zaman_dse_theme", state.theme);
  const btn = document.getElementById("btn-theme-toggle");
  if (btn) {
    btn.textContent = state.theme === "dark" ? "Light Mode" : "Dark Mode";
  }
}

async function loadAllDailyData() {
  const badgeText = document.getElementById("daily-session-text");
  if (badgeText) badgeText.textContent = "Loading daily datasets...";

  const cacheBust = `?t=${Date.now()}`;
  const [idxRes, dailyRes, mktRes, metaRes] = await Promise.allSettled([
    fetch(`./data/index_history.json${cacheBust}`, { cache: "no-store" }),
    fetch(`./data/daily_3m.json${cacheBust}`, { cache: "no-store" }),
    fetch(`./data/market_data.json${cacheBust}`, { cache: "no-store" }),
    fetch(`./data/symbol_meta.json${cacheBust}`, { cache: "no-store" }),
  ]);

  if (idxRes.status === "fulfilled" && idxRes.value.ok) {
    state.indexHistory = await idxRes.value.json();
  }
  if (dailyRes.status === "fulfilled" && dailyRes.value.ok) {
    state.daily3m = await dailyRes.value.json();
  }
  if (mktRes.status === "fulfilled" && mktRes.value.ok) {
    state.marketData = await mktRes.value.json();
  }
  if (metaRes.status === "fulfilled" && metaRes.value.ok) {
    state.symbolMeta = await metaRes.value.json();
  }

  populateSectorDropdown();
  renderAll();
}

function getAllDatesDesc() {
  const dateSet = new Set();
  if (Array.isArray(state.indexHistory)) {
    for (const row of state.indexHistory) {
      if (row && row.date) dateSet.add(row.date.slice(0, 10));
    }
  }
  if (state.daily3m) {
    for (const sym of Object.keys(state.daily3m)) {
      const rows = state.daily3m[sym] || [];
      for (const r of rows) {
        if (r && r[0]) dateSet.add(String(r[0]).slice(0, 10));
      }
    }
  }
  if (state.marketData && state.marketData.intraday_date_bst) {
    dateSet.add(String(state.marketData.intraday_date_bst).slice(0, 10));
  }
  return Array.from(dateSet).sort((a, b) => b.localeCompare(a));
}

function buildStocksBySector() {
  const staticMap = new Map();
  const dynamicMap = new Map();

  if (state.marketData) {
    for (const s of state.marketData.static || []) {
      if (s && s.symbol) staticMap.set(s.symbol, s);
    }
    for (const d of state.marketData.dynamic || []) {
      if (d && d.symbol) dynamicMap.set(d.symbol, d);
    }
  }

  const metaObj =
    (state.marketData && state.marketData.symbol_meta) || state.symbolMeta || {};

  const allSymbols = new Set([
    ...Object.keys(state.daily3m || {}),
    ...Object.keys(metaObj),
    ...staticMap.keys(),
    ...dynamicMap.keys(),
  ]);

  const sectorsMap = new Map();

  for (const sym of allSymbols) {
    if (/^TB\d+Y/i.test(sym)) continue;
    const sRow = staticMap.get(sym) || {};
    const mRow = metaObj[sym] || {};
    const dRow = dynamicMap.get(sym) || {};

    const sector = sRow.sector || mRow.sector || "Others";
    if (/G-SEC|T\.BOND/i.test(sector)) continue;
    const category = sRow.category || mRow.category || "";
    const pe1 = toNum(sRow.pe_1);
    const pe2 = toNum(sRow.pe_2);

    // Map date -> { vol, cp }
    const dateMap = new Map();
    const dList = state.daily3m[sym] || [];
    for (const item of dList) {
      if (Array.isArray(item) && item.length >= 3) {
        dateMap.set(String(item[0]).slice(0, 10), {
          vol: toNum(item[1]) ?? 0,
          cp: toNum(item[2]) ?? 0,
        });
      }
    }

    // Always overlay today's live LTP & Volume from market_data.json for the latest session date
    const latestDate = state.marketData && state.marketData.intraday_date_bst;
    if (latestDate && dRow.symbol) {
      const liveVol = toNum(dRow.volume) ?? 0;
      const ltpVal = toNum(dRow.ltp);
      const closeVal = toNum(dRow.close);
      const ycpVal = toNum(dRow.ycp);
      const livePrice =
        ltpVal !== null && ltpVal > 0
          ? ltpVal
          : closeVal !== null && closeVal > 0
          ? closeVal
          : ycpVal ?? 0;
      dateMap.set(latestDate.slice(0, 10), {
        vol: liveVol,
        cp: livePrice,
      });
    }

    if (!sectorsMap.has(sector)) {
      sectorsMap.set(sector, []);
    }
    sectorsMap.get(sector).push({
      symbol: sym,
      sector,
      category,
      pe1,
      pe2,
      dateMap,
    });
  }

  const sortedSectors = Array.from(sectorsMap.keys()).sort((a, b) => {
    if (a === "Others") return 1;
    if (b === "Others") return -1;
    return a.localeCompare(b);
  });

  const result = [];
  for (const sec of sortedSectors) {
    const list = sectorsMap.get(sec) || [];
    list.sort((a, b) => a.symbol.localeCompare(b.symbol));
    result.push({ sector: sec, stocks: list });
  }
  return result;
}

function populateSectorDropdown() {
  const select = document.getElementById("daily-sector-select");
  if (!select) return;
  const groups = buildStocksBySector();
  const current = state.selectedSector;
  select.innerHTML = `<option value="all">All Industries / Sectors (${groups.length})</option>`;
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.sector;
    opt.textContent = `${g.sector} (${g.stocks.length})`;
    select.appendChild(opt);
  }
  select.value = current;
}

function renderIndexInformationTable(datesToShow) {
  const thead = document.getElementById("dse-index-thead");
  const tbody = document.getElementById("dse-index-tbody");
  if (!thead || !tbody) return;

  const idxByDate = new Map();
  for (const r of state.indexHistory || []) {
    if (r && r.date) idxByDate.set(r.date.slice(0, 10), r);
  }

  let thHtml = `<tr><th></th>`;
  for (const d of datesToShow) {
    thHtml += `<th>${formatDateDDMMYYYY(d)}</th>`;
  }
  thHtml += `</tr>`;
  thead.innerHTML = thHtml;

  const colorClass = state.colorCode ? "color-coded" : "";

  // Build the 7 rows matching the user's screenshot:
  // 1. DSE X
  // 2. Total value in taka
  // 3. Issue Advanced
  // 4. Issue Declined
  // 5. Issue Unchanged
  // 6. DSE S
  // 7. DSE 30
  let rowDsex = `<tr><td class="stock-name-cell">DSE X</td>`;
  let rowVal = `<tr><td class="stock-name-cell">Total value in taka</td>`;
  let rowAdv = `<tr><td class="stock-name-cell">Issue Advanced</td>`;
  let rowDec = `<tr><td class="stock-name-cell">Issue Declined</td>`;
  let rowFlat = `<tr><td class="stock-name-cell">Issue Unchanged</td>`;
  let rowDses = `<tr><td class="stock-name-cell">DSE S</td>`;
  let rowDs30 = `<tr><td class="stock-name-cell">DSE 30</td>`;

  for (const d of datesToShow) {
    const rec = idxByDate.get(d);
    if (!rec) {
      rowDsex += `<td>--</td>`;
      rowVal += `<td>--</td>`;
      rowAdv += `<td>--</td>`;
      rowDec += `<td>--</td>`;
      rowFlat += `<td>--</td>`;
      rowDses += `<td>--</td>`;
      rowDs30 += `<td>--</td>`;
      continue;
    }

    const dsexChgClass =
      rec.dsex_chg > 0 ? "up" : rec.dsex_chg < 0 ? "down" : "";
    const dsesChgClass =
      rec.dses_chg > 0 ? "up" : rec.dses_chg < 0 ? "down" : "";
    const ds30ChgClass =
      rec.ds30_chg > 0 ? "up" : rec.ds30_chg < 0 ? "down" : "";

    rowDsex += `<td><div class="hr-cell ${colorClass}"><span class="hr-vol">${fmtPrice.format(rec.dsex || 0)}</span><span class="hr-ltp ${dsexChgClass}">${fmtPrice.format(rec.dsex_chg || 0)}</span></div></td>`;
    rowVal += `<td><div class="hr-cell"><span class="hr-vol">${Math.round(rec.value || 0)}</span><span class="hr-ltp">mn</span></div></td>`;
    rowAdv += `<td><span class="hr-vol">${rec.adv ?? 0}</span></td>`;
    rowDec += `<td><span class="hr-vol">${rec.dec ?? 0}</span></td>`;
    rowFlat += `<td><span class="hr-vol">${rec.flat ?? 0}</span></td>`;
    rowDses += `<td><div class="hr-cell ${colorClass}"><span class="hr-vol">${fmtPrice.format(rec.dses || 0)}</span><span class="hr-ltp ${dsesChgClass}">${fmtPrice.format(rec.dses_chg || 0)}</span></div></td>`;
    rowDs30 += `<td><div class="hr-cell ${colorClass}"><span class="hr-vol">${fmtPrice.format(rec.ds30 || 0)}</span><span class="hr-ltp ${ds30ChgClass}">${fmtPrice.format(rec.ds30_chg || 0)}</span></div></td>`;
  }

  rowDsex += `</tr>`;
  rowVal += `</tr>`;
  rowAdv += `</tr>`;
  rowDec += `</tr>`;
  rowFlat += `</tr>`;
  rowDses += `</tr>`;
  rowDs30 += `</tr>`;

  tbody.innerHTML =
    rowDsex + rowVal + rowAdv + rowDec + rowFlat + rowDses + rowDs30;
}

function renderSectorDailyTables(allDatesDesc, datesToShow) {
  const container = document.getElementById("daily-sectors-container");
  if (!container) return;

  const groups = buildStocksBySector();
  const q = state.searchQuery.trim().toUpperCase();
  const colorClass = state.colorCode ? "color-coded" : "";

  // Map each date to its immediate prior trading date in allDatesDesc for price-change coloring
  const prevDateMap = new Map();
  for (let i = 0; i < allDatesDesc.length - 1; i++) {
    prevDateMap.set(allDatesDesc[i], allDatesDesc[i + 1]);
  }

  let html = "";
  let totalVisibleStocks = 0;

  for (const group of groups) {
    if (state.selectedSector !== "all" && group.sector !== state.selectedSector) {
      continue;
    }

    const filteredStocks = group.stocks.filter((st) => {
      if (!q) return true;
      return (
        st.symbol.toUpperCase().includes(q) ||
        st.sector.toUpperCase().includes(q)
      );
    });

    if (filteredStocks.length === 0) continue;
    totalVisibleStocks += filteredStocks.length;

    let theadCells = `<th>Name of Stock</th>`;
    for (const d of datesToShow) {
      theadCells += `<th>${formatDateDDMMYYYY(d)}</th>`;
    }

    let rowsHtml = "";
    for (const st of filteredStocks) {
      const pe1Str = st.pe1 !== null ? fmtPrice.format(st.pe1) : "";
      const pe2Str = st.pe2 !== null ? fmtPrice.format(st.pe2) : "";
      const peSub =
        pe1Str || pe2Str ? `${pe1Str}${pe2Str ? "/" + pe2Str : ""}` : "";

      let cellsHtml = `<td class="stock-name-cell">
        ${peSub ? `<span class="stock-pe-sub">${peSub}</span>` : ""}
        <a class="stock-code-link" href="./detail.html?symbol=${encodeURIComponent(st.symbol)}" title="Click to view Detail Analysis &amp; 3-Month Hourly History for ${st.symbol}">${st.symbol}</a>
        ${st.category ? `<span class="stock-cat-sub">${st.category}</span>` : ""}
      </td>`;

      for (const d of datesToShow) {
        const entry = st.dateMap.get(d);
        const vol = entry ? entry.vol : 0;
        const cp = entry ? entry.cp : 0;

        let dirClass = "";
        if (state.colorCode && entry && cp > 0) {
          const prevD = prevDateMap.get(d);
          const prevEntry = prevD ? st.dateMap.get(prevD) : null;
          if (prevEntry && prevEntry.cp > 0) {
            if (cp > prevEntry.cp) dirClass = "up";
            else if (cp < prevEntry.cp) dirClass = "down";
          }
        }

        cellsHtml += `<td>
          <div class="hr-cell ${colorClass}">
            <span class="hr-vol">${fmtInt.format(vol)}</span>
            <span class="hr-ltp ${dirClass}">${fmtPrice.format(cp)}</span>
          </div>
        </td>`;
      }

      rowsHtml += `<tr>${cellsHtml}</tr>`;
    }

    html += `
      <section class="industry-section">
        <h2 class="industry-heading">Industry Name: ${group.sector}</h2>
        <div class="hourly-table-wrap">
          <table class="hourly-sector-table">
            <thead>
              <tr>${theadCells}</tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  if (!html) {
    html = `<div class="empty-state">No matching stocks found for "${state.searchQuery}".</div>`;
  }

  container.innerHTML = html;

  const badgeText = document.getElementById("daily-session-text");
  if (badgeText && datesToShow.length > 0) {
    badgeText.textContent = `Latest: ${formatDateDDMMYYYY(datesToShow[0])} • Showing ${datesToShow.length} Trading Days (${totalVisibleStocks} stocks)`;
  }
}

function renderAll() {
  const allDatesDesc = getAllDatesDesc();
  const datesToShow = allDatesDesc.slice(0, state.daysLimit);
  renderIndexInformationTable(datesToShow);
  renderSectorDailyTables(allDatesDesc, datesToShow);
}

function exportDailyCsv() {
  const allDatesDesc = getAllDatesDesc();
  const datesToShow = allDatesDesc.slice(0, state.daysLimit);
  const groups = buildStocksBySector();

  const headers = ["Sector", "Symbol", "Category", "PE1", "PE2"];
  for (const d of datesToShow) {
    const label = formatDateDDMMYYYY(d);
    headers.push(`${label} Volume`, `${label} Close`);
  }

  const lines = [headers.join(",")];
  for (const g of groups) {
    if (state.selectedSector !== "all" && g.sector !== state.selectedSector) {
      continue;
    }
    for (const st of g.stocks) {
      const row = [
        `"${g.sector.replace(/"/g, '""')}"`,
        st.symbol,
        st.category || "",
        st.pe1 !== null ? st.pe1 : "",
        st.pe2 !== null ? st.pe2 : "",
      ];
      for (const d of datesToShow) {
        const entry = st.dateMap.get(d);
        row.push(entry ? entry.vol : 0, entry ? entry.cp.toFixed(2) : "0.00");
      }
      lines.push(row.join(","));
    }
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dse_daily_analysis_${datesToShow[0] || "latest"}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bindEvents() {
  const searchInput = document.getElementById("daily-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value || "";
      renderAll();
    });
  }

  const sectorSelect = document.getElementById("daily-sector-select");
  if (sectorSelect) {
    sectorSelect.addEventListener("change", (e) => {
      state.selectedSector = e.target.value || "all";
      renderAll();
    });
  }

  const daysSelect = document.getElementById("daily-days-select");
  if (daysSelect) {
    daysSelect.addEventListener("change", (e) => {
      state.daysLimit = Number(e.target.value) || 10;
      renderAll();
    });
  }

  const chkColor = document.getElementById("chk-daily-color");
  if (chkColor) {
    chkColor.addEventListener("change", (e) => {
      state.colorCode = Boolean(e.target.checked);
      renderAll();
    });
  }

  const btnTheme = document.getElementById("btn-theme-toggle");
  if (btnTheme) {
    btnTheme.addEventListener("click", () => {
      applyTheme(state.theme === "dark" ? "light" : "dark");
    });
  }

  const btnExport = document.getElementById("btn-export-daily-csv");
  if (btnExport) {
    btnExport.addEventListener("click", exportDailyCsv);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(state.theme);
  bindEvents();
  loadAllDailyData();
});
