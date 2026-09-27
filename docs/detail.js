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
    selectedSymbol: "ISLAMIINS",
    deltaMetric: "vol", // "vol" | "val" | "ltp"
    colorCode: false,
    sourceLabel: "Snapshot",
    allSymbols: [],
    companyDetailsMap: {},
    daily3mMap: {},
    hourly3mMap: {}, // { [symbol]: { [dateYYYYMMDD]: { [mins]: { v, ltp, val } } } }
    dynamicMap: {},
    staticMap: {},
    historyMap: {}, // from market_data.json
    liveSymbolRows: null, // optional rows fetched directly from Supabase for selectedSymbol
  };

  const fmtInt = (val) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0";
    return Math.round(Number(val)).toLocaleString("en-US");
  };

  const fmtFixed = (val, decimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0.00";
    return Number(val).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  const fmtCompact = (val, maxDecimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0";
    const n = Number(Number(val).toFixed(maxDecimals));
    if (n === 0) return "0";
    return n.toString();
  };

  function formatDateDDMMYYYY(yyyyMmDd) {
    if (!yyyyMmDd || typeof yyyyMmDd !== "string") return yyyyMmDd || "--";
    const parts = yyyyMmDd.split("-");
    if (parts.length !== 3) return yyyyMmDd;
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

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

  function slotKeyToMinutes(slotKey) {
    const timePart = slotKey.split(" ")[1] || "";
    const [hhStr, mmStr] = timePart.split(":");
    const hh = Number(hhStr);
    const mm = Number(mmStr);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  }

  function getSymbolFromURL() {
    const params = new URLSearchParams(window.location.search);
    const sym = (params.get("symbol") || "").trim().toUpperCase();
    return sym || null;
  }

  function setSymbolInURL(symbol) {
    const url = new URL(window.location.href);
    url.searchParams.set("symbol", symbol);
    window.history.replaceState({}, "", url.toString());
  }

  function buildDayWindowsFromPoints(points) {
    // points: [{ slot: "YYYY-MM-DD HH:MM", v, ltp, val }] for a single date
    const byWindow = {};
    const bestDist = {};

    for (const pt of points) {
      const sKey = pt.slot || "";
      const mins = slotKeyToMinutes(sKey);
      if (mins === null) continue;

      if (mins >= 580 && mins <= 885) {
        const snapped = Math.min(870, Math.max(600, Math.round(mins / 30) * 30));
        const dist = Math.abs(mins - snapped);
        if (byWindow[snapped] === undefined || dist <= bestDist[snapped]) {
          byWindow[snapped] = {
            v: Number(pt.v || 0),
            ltp: Number(pt.ltp || 0),
            val: Number(pt.val || 0),
          };
          bestDist[snapped] = dist;
        }
      } else if (mins > 885) {
        if (byWindow[870] === undefined) {
          byWindow[870] = {
            v: Number(pt.v || 0),
            ltp: Number(pt.ltp || 0),
            val: Number(pt.val || 0),
          };
          bestDist[870] = mins - 870;
        }
      }
    }

    return byWindow;
  }

  function getSymbol3MonthRows(symbol) {
    // 1. Gather daily summary rows from daily3mMap[symbol]: [[date, vol, cp], ...]
    const daySummaryMap = {}; // { [date]: { date, vol, cp } }
    const dailyList = state.daily3mMap[symbol] || [];
    for (const item of dailyList) {
      if (Array.isArray(item) && item.length >= 3) {
        const [dt, vol, cp] = item;
        daySummaryMap[dt] = { date: dt, vol: Number(vol || 0), cp: Number(cp || 0) };
      }
    }

    // Also incorporate latest dynamic record if present
    const dyn = state.dynamicMap[symbol];
    if (dyn && dyn.timestamp) {
      const slot = toDhakaSlotKey(dyn.timestamp);
      const dt = slot.split(" ")[0];
      if (dt && !daySummaryMap[dt]) {
        daySummaryMap[dt] = {
          date: dt,
          vol: Number(dyn.volume || 0),
          cp: Number(dyn.close || dyn.ltp || dyn.ycp || 0),
        };
      }
    }

    // 2. Gather half-hourly points per date
    const pointsByDate = {}; // { [date]: [{ slot, v, ltp, val }] }

    // 2a. Pre-archived hourly_3mMap (if available)
    const archivedForSym = state.hourly3mMap[symbol] || {};
    const windowsByDate = {}; // { [date]: { [mins]: { v, ltp, val } } }
    for (const [dt, winObj] of Object.entries(archivedForSym)) {
      windowsByDate[dt] = {};
      for (const [mStr, arr] of Object.entries(winObj)) {
        if (Array.isArray(arr)) {
          windowsByDate[dt][Number(mStr)] = {
            v: Number(arr[0] || 0),
            ltp: Number(arr[1] || 0),
            val: Number(arr[2] || 0),
          };
        } else if (arr && typeof arr === "object") {
          windowsByDate[dt][Number(mStr)] = {
            v: Number(arr.v || 0),
            ltp: Number(arr.ltp || 0),
            val: Number(arr.val || 0),
          };
        }
      }
    }

    // 2b. Points from market_data.json history[symbol]
    const histPts = state.historyMap[symbol] || [];
    for (const p of histPts) {
      const sKey = p.t ? toDhakaSlotKey(p.t) : (p.slot || "");
      const dt = sKey.split(" ")[0];
      if (!dt) continue;
      if (!pointsByDate[dt]) pointsByDate[dt] = [];
      pointsByDate[dt].push({
        slot: sKey,
        v: Number(p.v || 0),
        ltp: Number(p.ltp || 0),
        val: Number(p.val || 0),
      });
    }

    // 2c. Live symbol rows from Supabase (if connected)
    if (Array.isArray(state.liveSymbolRows)) {
      for (const r of state.liveSymbolRows) {
        const sKey = toDhakaSlotKey(r.timestamp);
        const dt = sKey.split(" ")[0];
        if (!dt) continue;
        if (!pointsByDate[dt]) pointsByDate[dt] = [];
        pointsByDate[dt].push({
          slot: sKey,
          v: Number(r.volume || 0),
          ltp: Number(r.ltp || 0),
          val: Number(r.value || 0),
        });
      }
    }

    for (const [dt, pts] of Object.entries(pointsByDate)) {
      const computedWins = buildDayWindowsFromPoints(pts);
      windowsByDate[dt] = { ...(windowsByDate[dt] || {}), ...computedWins };

      // Ensure daySummaryMap has an entry for this date
      const latestPt = pts[pts.length - 1];
      if (!daySummaryMap[dt] && latestPt) {
        daySummaryMap[dt] = {
          date: dt,
          vol: latestPt.v,
          cp: latestPt.ltp,
        };
      }
    }

    // Filter to last 92 days (3 months) and sort descending by date
    const allDates = Array.from(
      new Set([...Object.keys(daySummaryMap), ...Object.keys(windowsByDate)])
    ).sort((a, b) => b.localeCompare(a));

    return allDates.map((dt) => {
      const summary = daySummaryMap[dt] || { date: dt, vol: 0, cp: 0 };
      const wins = windowsByDate[dt] || {};
      // If day summary volume is 0 but windows have volume, use max window volume
      let dayVol = summary.vol;
      let dayCp = summary.cp;
      for (const w of STANDARD_WINDOWS) {
        if (wins[w.mins]) {
          if (wins[w.mins].v > dayVol) dayVol = wins[w.mins].v;
          if (wins[w.mins].ltp > 0) dayCp = dayCp || wins[w.mins].ltp;
        }
      }
      return {
        date: dt,
        dateLabel: formatDateDDMMYYYY(dt),
        volume: dayVol,
        cp: dayCp,
        windows: wins,
      };
    });
  }

  function populateCompanySelect() {
    const select = document.getElementById("detail-company-select");
    select.innerHTML = "";
    for (const sym of state.allSymbols) {
      const cd = state.companyDetailsMap[sym] || {};
      const name = cd.company_name && cd.company_name !== sym ? ` — ${cd.company_name}` : "";
      const opt = document.createElement("option");
      opt.value = sym;
      opt.textContent = `${sym}${name}`;
      select.appendChild(opt);
    }
    if (state.allSymbols.includes(state.selectedSymbol)) {
      select.value = state.selectedSymbol;
    }
  }

  function renderCompanyDetails() {
    const sym = state.selectedSymbol;
    const cd = state.companyDetailsMap[sym] || {};
    const st = state.staticMap[sym] || {};
    const dyn = state.dynamicMap[sym] || {};

    const fullName = (cd.company_name || sym).toUpperCase();
    document.getElementById("detail-company-heading").textContent = `${fullName} (${sym})`;
    document.title = `Zaman Analysis — ${sym} Detail Analysis`;

    const dseLink = document.getElementById("link-dse-official");
    dseLink.href = `https://www.dsebd.org/displayCompany.php?name=${encodeURIComponent(sym)}`;

    const pe1 = st.pe_1 !== null && st.pe_1 !== undefined && Number(st.pe_1) > 0 ? fmtCompact(st.pe_1, 2) : "0";
    const pe2 = st.pe_2 !== null && st.pe_2 !== undefined && Number(st.pe_2) > 0 ? fmtCompact(st.pe_2, 2) : "0";
    const pe3Cand = st.pe_3 ?? st.pe_5 ?? null;
    const pe4Cand = st.pe_4 ?? st.pe_6 ?? null;
    const pe3 = pe3Cand !== null && pe3Cand !== undefined && Number(pe3Cand) > 0 ? fmtCompact(pe3Cand, 2) : "0";
    const pe4 = pe4Cand !== null && pe4Cand !== undefined && Number(pe4Cand) > 0 ? fmtCompact(pe4Cand, 2) : "0";

    const daysRange =
      dyn.low && dyn.high && Number(dyn.low) > 0 && Number(dyn.high) > 0
        ? `${fmtFixed(dyn.low, 2)} - ${fmtFixed(dyn.high, 2)}`
        : cd.days_range || "-";

    const category = cd.category || st.category || "-";

    const tbody = document.getElementById("detail-company-tbody");
    tbody.innerHTML = `
      <tr>
        <td>${fmtInt(cd.total_securities || 0)}</td>
        <td title="Public: ${cd.public_pct ?? 0}%">${fmtInt(cd.public_qty || 0)}</td>
        <td style="padding: 4px;">
          <div class="pe-subgrid">
            <div class="pe-subcell" title="Unaudited / Current Basic P/E">${pe1}</div>
            <div class="pe-subcell" title="Unaudited / Current Diluted P/E">${pe2}</div>
            <div class="pe-subcell" title="Audited / Continuing Basic P/E">${pe3}</div>
            <div class="pe-subcell" title="Audited / Continuing Diluted P/E">${pe4}</div>
          </div>
        </td>
        <td>${category}</td>
        <td>${cd.year_end || "-"}</td>
        <td>${daysRange}</td>
        <td>${cd.week_52_range || "-"}</td>
        <td>${cd.market_lot || "1"}</td>
        <td>${cd.last_agm || "-"}</td>
        <td>${cd.listing_year || "-"}</td>
        <td title="Institute: ${cd.institute_pct ?? 0}%">${fmtInt(cd.institute_qty || 0)}</td>
        <td title="Govt: ${cd.govt_pct ?? 0}%">${fmtInt(cd.govt_qty || 0)}</td>
        <td title="Sponsor/Director: ${cd.sponsor_pct ?? 0}%">${fmtInt(cd.sponsor_qty || 0)}</td>
        <td title="Foreign: ${cd.foreign_pct ?? 0}%">${fmtInt(cd.foreign_qty || 0)}</td>
      </tr>
    `;

    const extraStrip = document.getElementById("detail-extra-strip");
    extraStrip.innerHTML = `
      <span><strong>Industry / Sector:</strong> ${cd.sector || st.sector || "-"}</span>
      <span><strong>Authorized Cap:</strong> ${cd.authorized_cap || "-"} Mn</span>
      <span><strong>Paid-up Cap:</strong> ${cd.paid_up_cap || "-"} Mn</span>
      <span><strong>Face Value:</strong> ${cd.face_value || "-"}</span>
      <span><strong>Reserve &amp; Surplus:</strong> ${cd.reserve_surplus || "-"} Mn</span>
      <span><strong>Shareholding (%):</strong> Sponsor ${cd.sponsor_pct ?? 0}% | Govt ${cd.govt_pct ?? 0}% | Inst ${cd.institute_pct ?? 0}% | Foreign ${cd.foreign_pct ?? 0}% | Public ${cd.public_pct ?? 0}%</span>
    `;
  }

  function render3MonthHourlyTable() {
    const wrap = document.getElementById("detail-hourly-wrap");
    wrap.className = `hourly-table-wrap ${state.colorCode ? "color-coded" : ""}`;

    const thead = document.getElementById("detail-hourly-thead");
    const tbody = document.getElementById("detail-hourly-tbody");

    const winHeaders = STANDARD_WINDOWS.map((w) => `<th>${w.label}</th>`).join("");
    thead.innerHTML = `
      <tr>
        <th>Date</th>
        <th>Volume</th>
        <th>CP/LTP</th>
        ${winHeaders}
      </tr>
    `;

    const dayRows = getSymbol3MonthRows(state.selectedSymbol);
    document.getElementById("detail-status-text").textContent =
      `${state.sourceLabel}: ${state.selectedSymbol} (${dayRows.length} trading days in last 3 months)`;

    if (dayRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="padding: 24px;">No historical records found for ${state.selectedSymbol}.</td></tr>`;
      return;
    }

    const rowsHtml = dayRows
      .map((day) => {
        let prevData = null;

        const winCellsHtml = STANDARD_WINDOWS.map((w) => {
          const data = day.windows[w.mins];
          if (!data) {
            return `<td></td>`;
          }

          const volStr = fmtInt(data.v);
          const ltpStr = fmtCompact(data.ltp, 2);

          let ltpDirClass = "";
          if (prevData && data.ltp > 0 && prevData.ltp > 0) {
            if (data.ltp > prevData.ltp) ltpDirClass = "up";
            else if (data.ltp < prevData.ltp) ltpDirClass = "down";
          }

          // First populated window on this date shows 2 values (Volume & LTP)
          if (!prevData) {
            prevData = data;
            return `<td>
              <div class="hr-cell">
                <div class="hr-vol">${volStr}</div>
                <div class="hr-ltp ${ltpDirClass}">${ltpStr}</div>
              </div>
            </td>`;
          }

          // Subsequent windows on this date show 3 values (Volume, LTP, Change from prev window)
          let deltaStr = "0";
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

          prevData = data;

          return `<td>
            <div class="hr-cell">
              <div class="hr-vol">${volStr}</div>
              <div class="hr-ltp ${ltpDirClass}">${ltpStr}</div>
              <div class="hr-delta">${deltaStr}</div>
            </div>
          </td>`;
        }).join("");

        return `<tr>
          <td style="font-family: Georgia, serif; font-size: 12.5px; white-space: nowrap;">${day.dateLabel}</td>
          <td style="font-family: Georgia, serif; font-size: 12.5px;">${fmtInt(day.volume)}</td>
          <td style="font-family: Georgia, serif; font-size: 12.5px;">${fmtFixed(day.cp, 2)}</td>
          ${winCellsHtml}
        </tr>`;
      })
      .join("");

    tbody.innerHTML = rowsHtml;
  }

  async function fetchLiveSymbolFromSupabase(symbol) {
    const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
    const savedKey = localStorage.getItem(STORAGE_ANON_KEY);
    if (!savedUrl || !savedKey) {
      state.liveSymbolRows = null;
      return;
    }

    try {
      const cleanUrl = savedUrl.replace(/\/+$/, "");
      const cutoff = new Date(Date.now() - 92 * 24 * 3600 * 1000).toISOString();
      const resp = await fetch(
        `${cleanUrl}/rest/v1/dse_dynamic?symbol=eq.${encodeURIComponent(symbol)}&timestamp=gte.${encodeURIComponent(cutoff)}&select=symbol,ltp,volume,value,close,ycp,timestamp&order=timestamp.asc&limit=1000`,
        {
          headers: {
            apikey: savedKey,
            Authorization: `Bearer ${savedKey}`,
          },
        }
      );
      if (resp.ok) {
        state.liveSymbolRows = await resp.json();
        state.sourceLabel = "Supabase Live";
      }
    } catch (e) {
      console.warn("Supabase symbol query fallback:", e);
      state.liveSymbolRows = null;
    }
  }

  async function selectCompany(symbol) {
    state.selectedSymbol = symbol;
    setSymbolInURL(symbol);
    const select = document.getElementById("detail-company-select");
    if (select && select.value !== symbol) {
      select.value = symbol;
    }
    await fetchLiveSymbolFromSupabase(symbol);
    renderCompanyDetails();
    render3MonthHourlyTable();
  }

  async function loadAllData() {
    const [mdResp, cdResp, d3mResp, h3mResp] = await Promise.all([
      fetch(`./data/market_data.json?t=${Date.now()}`).catch(() => null),
      fetch(`./data/company_details.json?t=${Date.now()}`).catch(() => null),
      fetch(`./data/daily_3m.json?t=${Date.now()}`).catch(() => null),
      fetch(`./data/hourly_3m.json?t=${Date.now()}`).catch(() => null),
    ]);

    const payload = mdResp && mdResp.ok ? await mdResp.json() : {};
    const companyDetails = cdResp && cdResp.ok ? await cdResp.json() : {};
    const daily3m = d3mResp && d3mResp.ok ? await d3mResp.json() : {};
    const hourly3m = h3mResp && h3mResp.ok ? await h3mResp.json() : (payload.hourly_3m || {});

    const dynMap = {};
    for (const d of payload.dynamic || []) {
      if (d && d.symbol) dynMap[d.symbol] = d;
    }

    const statMap = {};
    for (const s of payload.static || []) {
      if (!s || !s.symbol) continue;
      const info = s.info && typeof s.info === "object" ? s.info : {};
      statMap[s.symbol] = {
        ...s,
        pe_1: s.pe_1 ?? info.pe_1 ?? null,
        pe_2: s.pe_2 ?? info.pe_2 ?? null,
        pe_3: s.pe_3 ?? info.pe_3 ?? null,
        pe_4: s.pe_4 ?? info.pe_4 ?? null,
        pe_5: s.pe_5 ?? info.pe_5 ?? null,
        pe_6: s.pe_6 ?? info.pe_6 ?? null,
      };
    }

    const allSyms = Array.from(
      new Set([
        ...Object.keys(companyDetails),
        ...Object.keys(dynMap),
        ...Object.keys(statMap),
      ])
    ).sort();

    state.allSymbols = allSyms;
    state.companyDetailsMap = companyDetails;
    state.daily3mMap = daily3m;
    state.hourly3mMap = hourly3m;
    state.dynamicMap = dynMap;
    state.staticMap = statMap;
    state.historyMap = payload.history || {};

    const urlSym = getSymbolFromURL();
    if (urlSym && allSyms.includes(urlSym)) {
      state.selectedSymbol = urlSym;
    } else if (!allSyms.includes(state.selectedSymbol) && allSyms.length > 0) {
      state.selectedSymbol = allSyms[0];
    }

    populateCompanySelect();
    await selectCompany(state.selectedSymbol);
  }

  function exportDetailCSV() {
    const sym = state.selectedSymbol;
    const dayRows = getSymbol3MonthRows(sym);
    const winHeaders = STANDARD_WINDOWS.map((w) => `"${w.label} (Vol | LTP | Delta)"`).join(",");
    const lines = [`date,volume,cp_ltp,${winHeaders}`];

    for (const day of dayRows) {
      let prevData = null;
      const cells = STANDARD_WINDOWS.map((w) => {
        const data = day.windows[w.mins];
        if (!data) return `""`;
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

      lines.push([day.dateLabel, day.volume, fmtFixed(day.cp, 2), ...cells].join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dse_detail_${sym}_3m.csv`;
    a.click();
  }

  function initEvents() {
    document.getElementById("detail-company-select").addEventListener("change", (e) => {
      selectCompany(e.target.value);
    });

    document.getElementById("detail-delta-select").addEventListener("change", (e) => {
      state.deltaMetric = e.target.value;
      render3MonthHourlyTable();
    });

    document.getElementById("chk-detail-color").addEventListener("change", (e) => {
      state.colorCode = e.target.checked;
      render3MonthHourlyTable();
    });

    document.getElementById("btn-export-detail-csv").addEventListener("click", exportDetailCSV);

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
      state.sourceLabel = "Snapshot";
      modal.hidden = true;
      await selectCompany(state.selectedSymbol);
    });

    document.getElementById("btn-save-supabase").addEventListener("click", async () => {
      const u = urlInput.value.trim();
      const k = keyInput.value.trim();
      if (u && k) {
        localStorage.setItem(STORAGE_URL_KEY, u);
        localStorage.setItem(STORAGE_ANON_KEY, k);
        modal.hidden = true;
        await selectCompany(state.selectedSymbol);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    loadAllData().catch((err) => {
      console.error("Failed to load detail analysis data:", err);
      document.getElementById("detail-status-text").textContent = "Detail data unavailable";
    });
  });
})();
