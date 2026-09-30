/**
 * Zaman Analysis — Decision Radar & Breakout Signals (docs/radar.js)
 *
 * Combines:
 *  1. Today's Intraday / Half-Hourly data (market_data.json or Supabase Live, with hourly_3m.json fallback)
 *  2. 3-Month Daily History (daily_3m.json -> 20-Day Avg Volume, Relative Volume RVOL, Multi-Day Streaks, 3M Support/Resistance)
 *  3. Company Details & Metadata (symbol_meta.json + company_details.json -> Sector, Category A/B/Z, P/E, Institutional/Sponsor Holding %)
 *  4. Personal Starred Watchlist persisted in localStorage
 */
(function () {
  "use strict";

  const STORAGE_URL_KEY = "zaman_dse_supabase_url";
  const STORAGE_ANON_KEY = "zaman_dse_supabase_key";
  const STORAGE_THEME_KEY = "zaman_dse_theme";
  const STORAGE_WATCHLIST_KEY = "zaman_dse_watchlist_v1";
  const STORAGE_WL_COLLAPSED_KEY = "zaman_dse_watchlist_collapsed";

  const DEFAULT_STARTER_WATCHLIST = ["GP", "BRACBANK", "BATBC", "SQURPHARMA", "BXPHARMA", "CITYBANK"];

  let state = {
    sessionDate: "--",
    latestWindowLabel: "--",
    sourceLabel: "Snapshot",
    stocks: [], // enriched decision objects
    sectors: [],
    watchlist: new Set(),
    watchlistCollapsed: false,
    searchQuery: "",
    selectedSector: "all",
    selectedCategory: "all",
    activeFilter: "all",
    sortField: "score",
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

  const fmtCompact = (val, maxDecimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0";
    return Number(val).toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDecimals,
    });
  };

  const fmtInt = (val) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "0";
    return Math.round(Number(val)).toLocaleString("en-US");
  };

  function loadWatchlistFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_WATCHLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          state.watchlist = new Set(parsed.map((s) => String(s).trim().toUpperCase()).filter(Boolean));
          return;
        }
      }
    } catch (_e) {}
    state.watchlist = new Set(DEFAULT_STARTER_WATCHLIST);
    saveWatchlistToStorage();
  }

  function saveWatchlistToStorage() {
    try {
      localStorage.setItem(STORAGE_WATCHLIST_KEY, JSON.stringify(Array.from(state.watchlist)));
    } catch (_e) {}
  }

  function toggleWatchlistSymbol(symbol) {
    const sym = String(symbol || "").trim().toUpperCase();
    if (!sym) return;
    if (state.watchlist.has(sym)) {
      state.watchlist.delete(sym);
    } else {
      state.watchlist.add(sym);
    }
    saveWatchlistToStorage();
    renderWatchlistSection();
    renderRadarTable();
    if (state.selectedSymbol === sym) {
      updateInspectorStarButton(sym);
    }
  }

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

  function minsToTimeLabel(mins) {
    const m = Number(mins);
    if (Number.isNaN(m)) return String(mins);
    const hh = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    const period = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${mm} ${period}`;
  }

  function formatStockCellHtml(st, includeStar = true) {
    const isStarred = state.watchlist.has(st.symbol);
    const starBtnHtml = includeStar
      ? `<button type="button" class="star-btn ${isStarred ? "starred" : ""}" data-star-symbol="${st.symbol}" title="${
          isStarred ? "Remove from Watchlist" : "Pin to Watchlist"
        }">${isStarred ? "★" : "☆"}</button>`
      : "";
    const pe1Str = st.pe1 !== null && st.pe1 !== undefined && Number(st.pe1) > 0 ? fmtCompact(st.pe1, 1) : "0";
    const pe2Str = st.pe2 !== null && st.pe2 !== undefined && Number(st.pe2) > 0 ? fmtCompact(st.pe2, 1) : "0";
    const catHtml = st.category ? `<sub class="stock-cat-sub">${st.category}</sub>` : "";
    return `${starBtnHtml}<sub class="stock-pe-sub">${pe1Str}/${pe2Str}</sub><a href="./detail.html?symbol=${encodeURIComponent(
      st.symbol
    )}" class="stock-code-link" data-prevent-row="1" title="Open 3-Month Detail Analysis for ${st.symbol}">${
      st.symbol
    }</a>${catHtml}`;
  }

  /**
   * Builds the unified Decision Radar dataset from:
   *  - marketPayload (from market_data.json or Supabase live, optional)
   *  - daily3m (from daily_3m.json)
   *  - hourly3m (from hourly_3m.json)
   *  - symbolMeta (from symbol_meta.json)
   *  - companyDetails (from company_details.json)
   */
  function buildDecisionState(marketPayload, daily3m, hourly3m, symbolMeta, companyDetails) {
    const dynamicList = (marketPayload && marketPayload.dynamic) || [];
    const staticList = (marketPayload && marketPayload.static) || [];
    const historyMap = (marketPayload && marketPayload.history) || {};

    const dynBySym = {};
    for (const d of dynamicList) {
      if (d && d.symbol && !dynBySym[d.symbol]) {
        dynBySym[d.symbol] = d;
      }
    }

    const statBySym = {};
    for (const s of staticList) {
      if (s && s.symbol) {
        const info = s.info && typeof s.info === "object" ? s.info : {};
        statBySym[s.symbol] = {
          pe_1: s.pe_1 ?? info.pe_1 ?? null,
          pe_2: s.pe_2 ?? info.pe_2 ?? null,
          sector: s.sector ?? info.sector ?? null,
          category: s.category ?? info.category ?? null,
          ycp: s.ycp ?? info.ycp ?? null,
          close: s.close ?? info.close ?? null,
        };
      }
    }

    // Determine latest session date across marketPayload or hourly3m / daily3m
    let latestDate = "";
    for (const sym of Object.keys(hourly3m || {})) {
      for (const dKey of Object.keys(hourly3m[sym] || {})) {
        if (dKey > latestDate) latestDate = dKey;
      }
    }
    for (const sym of Object.keys(daily3m || {})) {
      const arr = daily3m[sym];
      if (Array.isArray(arr) && arr.length > 0 && arr[0][0] > latestDate) {
        latestDate = arr[0][0];
      }
    }
    if (marketPayload && marketPayload.generated_at) {
      const genSlot = toDhakaSlotKey(marketPayload.generated_at);
      const genDate = genSlot.split(" ")[0];
      if (genDate && genDate >= latestDate && dynamicList.length > 0) {
        latestDate = genDate;
      }
    }
    state.sessionDate = latestDate || "Latest Session";

    // Collect all symbols (excluding G-SEC Treasury Bonds TB*)
    const symbolSet = new Set([
      ...Object.keys(daily3m || {}),
      ...Object.keys(hourly3m || {}),
      ...Object.keys(symbolMeta || {}),
      ...Object.keys(dynBySym),
    ]);

    const allSymbols = Array.from(symbolSet)
      .filter((sym) => sym && !/^TB\d+Y/i.test(sym))
      .sort();

    let latestSlotMinsGlobal = 0;
    const enrichedStocks = [];

    for (const sym of allSymbols) {
      const meta = (symbolMeta && symbolMeta[sym]) || {};
      const cdet = (companyDetails && companyDetails[sym]) || {};
      const stat = statBySym[sym] || {};
      const dyn = dynBySym[sym] || {};

      const sector = meta.sector || cdet.sector || stat.sector || "Miscellaneous";
      if (/G-SEC|T\.Bond/i.test(sector)) continue;

      const category = (meta.category || cdet.category || stat.category || "").trim().toUpperCase();
      const pe1Raw = stat.pe_1 ?? meta.pe_1 ?? cdet.pe_1 ?? null;
      const pe2Raw = stat.pe_2 ?? meta.pe_2 ?? cdet.pe_2 ?? null;
      const pe1 = pe1Raw !== null && pe1Raw !== undefined && !Number.isNaN(Number(pe1Raw)) ? Number(pe1Raw) : null;
      const pe2 = pe2Raw !== null && pe2Raw !== undefined && !Number.isNaN(Number(pe2Raw)) ? Number(pe2Raw) : null;

      // Extract daily history: array of [dateStr, vol, closePrice], sorted newest-first
      const rawDaily = Array.isArray(daily3m && daily3m[sym]) ? daily3m[sym] : [];
      const dailySeries = rawDaily
        .filter((item) => Array.isArray(item) && item.length >= 3 && Number(item[2]) > 0)
        .map((item) => ({
          date: String(item[0]),
          vol: Number(item[1] || 0),
          cp: Number(item[2] || 0),
        }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      // Extract today's half-hourly slots from hourly3m[sym][latestDate] or marketPayload.history
      const slotPoints = [];
      const hrByDate = (hourly3m && hourly3m[sym]) || {};
      const hrLatestDate = hrByDate[latestDate] ? latestDate : Object.keys(hrByDate).sort().pop();

      if (hrLatestDate && hrByDate[hrLatestDate]) {
        const slotsObj = hrByDate[hrLatestDate];
        const sortedMins = Object.keys(slotsObj)
          .map(Number)
          .filter((m) => !Number.isNaN(m))
          .sort((a, b) => a - b);
        for (const m of sortedMins) {
          const tuple = slotsObj[String(m)];
          if (Array.isArray(tuple) && tuple.length >= 2) {
            const v = Number(tuple[0] || 0);
            const ltp = Number(tuple[1] || 0);
            const val = Number(tuple[2] || 0);
            if (v > 0 || ltp > 0) {
              slotPoints.push({
                mins: m,
                label: minsToTimeLabel(m),
                v,
                ltp,
                val,
                vwap: v > 0 && val > 0 ? Number(((val * 1000000) / v).toFixed(2)) : ltp,
              });
              if (hrLatestDate === latestDate && m > latestSlotMinsGlobal) {
                latestSlotMinsGlobal = m;
              }
            }
          }
        }
      } else if (Array.isArray(historyMap[sym]) && historyMap[sym].length > 0) {
        for (const p of historyMap[sym]) {
          const sKey = p.t ? toDhakaSlotKey(p.t) : p.slot || "";
          const timePart = sKey.split(" ")[1] || "10:00";
          const [hh, mm] = timePart.split(":").map(Number);
          const mins = (hh || 10) * 60 + (mm || 0);
          const v = Number(p.v || 0);
          const ltp = Number(p.ltp || 0);
          const val = Number(p.val || 0);
          if (v > 0 || ltp > 0) {
            slotPoints.push({
              mins,
              label: minsToTimeLabel(mins),
              v,
              ltp,
              val,
              vwap: v > 0 && val > 0 ? Number(((val * 1000000) / v).toFixed(2)) : ltp,
            });
          }
        }
      }

      const lastSlot = slotPoints.length > 0 ? slotPoints[slotPoints.length - 1] : null;
      const prevSlot = slotPoints.length > 1 ? slotPoints[slotPoints.length - 2] : null;

      // Determine today's live/latest LTP, Volume, Value (Mn), YCP, High, Low
      const latestDaily = dailySeries.length > 0 ? dailySeries[0] : null;
      const prevDaily = dailySeries.length > 1 ? dailySeries[1] : null;

      let ltp = Number(dyn.ltp || 0);
      if (ltp <= 0 && lastSlot && lastSlot.ltp > 0) ltp = lastSlot.ltp;
      if (ltp <= 0 && latestDaily && latestDaily.cp > 0) ltp = latestDaily.cp;

      let volume = Number(dyn.volume || 0);
      if (volume <= 0 && lastSlot && lastSlot.v > 0) volume = lastSlot.v;
      if (volume <= 0 && latestDaily && latestDaily.vol > 0) volume = latestDaily.vol;

      let valueMn = Number(dyn.value || 0);
      if (valueMn <= 0 && lastSlot && lastSlot.val > 0) valueMn = lastSlot.val;

      let ycp = Number(dyn.ycp || stat.ycp || 0);
      if (ycp <= 0) {
        if (latestDaily && latestDaily.date === latestDate && prevDaily) {
          ycp = prevDaily.cp;
        } else if (latestDaily) {
          ycp = latestDaily.cp;
        }
      }

      // Intraday High & Low (from dynamic or across today's slots)
      let high = Number(dyn.high || 0);
      let low = Number(dyn.low || 0);
      if ((high <= 0 || low <= 0) && slotPoints.length > 0) {
        const slotPrices = slotPoints.map((s) => s.ltp).filter((p) => p > 0);
        if (slotPrices.length > 0) {
          if (high <= 0) high = Math.max(...slotPrices, ltp);
          if (low <= 0) low = Math.min(...slotPrices, ltp);
        }
      }
      if (high <= 0) high = Math.max(ltp, ycp);
      if (low <= 0) low = Math.min(ltp > 0 ? ltp : ycp, ycp > 0 ? ycp : ltp);

      const change = ltp > 0 && ycp > 0 ? Number((ltp - ycp).toFixed(2)) : 0;
      const pct_change = ltp > 0 && ycp > 0 ? Number(((change / ycp) * 100).toFixed(2)) : 0;

      // Intraday VWAP = (Value in Mn * 1,000,000) / Volume
      let vwap = null;
      let vwap_pct = null;
      if (volume > 0 && valueMn > 0) {
        vwap = Number(((valueMn * 1000000) / volume).toFixed(2));
        if (vwap > 0 && ltp > 0) {
          vwap_pct = Number((((ltp - vwap) / vwap) * 100).toFixed(2));
        }
      } else if (lastSlot && lastSlot.vwap > 0) {
        vwap = lastSlot.vwap;
        if (vwap > 0 && ltp > 0) {
          vwap_pct = Number((((ltp - vwap) / vwap) * 100).toFixed(2));
        }
      }

      // Day Range Position (0% = at Day Low, 100% = at Day High)
      let day_range_pct = 50;
      if (high > low && ltp > 0) {
        day_range_pct = Math.max(0, Math.min(100, Math.round(((ltp - low) / (high - low)) * 100)));
      } else if (pct_change > 0) {
        day_range_pct = 80;
      } else if (pct_change < 0) {
        day_range_pct = 20;
      }

      // 20-Day Average Volume & Relative Volume (RVOL)
      // Exclude today's entry if dailySeries[0].date === latestDate
      const historicalDays =
        dailySeries.length > 1 && dailySeries[0].date === latestDate
          ? dailySeries.slice(1, 21)
          : dailySeries.slice(0, 20);

      let avg_vol_20d = 0;
      if (historicalDays.length > 0) {
        const sumVol = historicalDays.reduce((acc, d) => acc + (d.vol || 0), 0);
        avg_vol_20d = Math.round(sumVol / historicalDays.length);
      }
      const rvol = avg_vol_20d > 0 && volume > 0 ? Number((volume / avg_vol_20d).toFixed(2)) : 0;

      // Latest 30m Window Delta Volume, Delta LTP & Burst Ratio
      let slot_delta_vol = 0;
      let slot_delta_ltp = 0;
      let slot_burst_ratio = 1;
      if (lastSlot && prevSlot) {
        slot_delta_vol = Math.max(0, lastSlot.v - prevSlot.v);
        slot_delta_ltp =
          lastSlot.ltp > 0 && prevSlot.ltp > 0 ? Number((lastSlot.ltp - prevSlot.ltp).toFixed(2)) : 0;
        const avgSlotVol = slotPoints.length > 1 ? lastSlot.v / slotPoints.length : slot_delta_vol;
        slot_burst_ratio = avgSlotVol > 0 ? Number((slot_delta_vol / avgSlotVol).toFixed(2)) : 1;
      } else if (lastSlot) {
        slot_delta_vol = lastSlot.v;
        slot_delta_ltp = change;
      }

      // Multi-Day Streak from dailySeries (including today's move)
      // Build chronological recent closes
      const combinedDaily = [...dailySeries];
      if (ltp > 0 && (!combinedDaily.length || combinedDaily[0].date !== latestDate)) {
        combinedDaily.unshift({ date: latestDate, vol: volume, cp: ltp });
      }
      let streak = 0;
      for (let i = 0; i < combinedDaily.length - 1; i++) {
        const curr = combinedDaily[i].cp;
        const prev = combinedDaily[i + 1].cp;
        if (curr <= 0 || prev <= 0) break;
        const diff = Number((curr - prev).toFixed(2));
        if (i === 0) {
          if (diff > 0) streak = 1;
          else if (diff < 0) streak = -1;
          else break;
        } else {
          if (streak > 0 && diff > 0) streak++;
          else if (streak < 0 && diff < 0) streak--;
          else break;
        }
      }

      // 3-Month High / Low & 3M Range Position
      const prices3m = combinedDaily.map((d) => d.cp).filter((p) => p > 0);
      const high_3m = prices3m.length > 0 ? Math.max(...prices3m, ltp) : high;
      const low_3m = prices3m.length > 0 ? Math.min(...prices3m, ltp > 0 ? ltp : high_3m) : low;
      let range_3m_pct = 50;
      if (high_3m > low_3m && ltp > 0) {
        range_3m_pct = Math.max(0, Math.min(100, Math.round(((ltp - low_3m) / (high_3m - low_3m)) * 100)));
      }

      // Shareholding quality (Sponsor + Institute + Foreign %)
      const sponsorPct = Number(cdet.sponsor_pct || 0);
      const instPct = Number(cdet.institute_pct || 0);
      const foreignPct = Number(cdet.foreign_pct || 0);
      const strongHandsPct = Number((sponsorPct + instPct + foreignPct).toFixed(1));

      // Compute Composite Decision Score (0 - 100) & Action Signal Classification
      let score = 50;

      // 1. VWAP Control (+/- 18 pts)
      if (vwap_pct !== null) {
        if (vwap_pct >= 1.0) score += 18;
        else if (vwap_pct > 0) score += 12;
        else if (vwap_pct === 0) score += 4;
        else if (vwap_pct < -1.0) score -= 18;
        else score -= 10;
      }

      // 2. Relative Volume (+/- 18 pts)
      if (rvol >= 2.5) score += pct_change >= 0 && (vwap_pct === null || vwap_pct >= 0) ? 18 : -10;
      else if (rvol >= 1.5) score += pct_change >= 0 && (vwap_pct === null || vwap_pct >= 0) ? 14 : -6;
      else if (rvol >= 1.1) score += pct_change >= 0 ? 7 : -3;
      else if (rvol < 0.5) score -= 6;

      // 3. Latest 30m Window Momentum (+/- 10 pts)
      if (slot_delta_ltp > 0 && slot_burst_ratio >= 1.2) score += 10;
      else if (slot_delta_ltp > 0) score += 6;
      else if (slot_delta_ltp < 0 && slot_burst_ratio >= 1.2) score -= 10;
      else if (slot_delta_ltp < 0) score -= 5;

      // 4. Day Range Position (+/- 8 pts)
      if (day_range_pct >= 75) score += 8;
      else if (day_range_pct >= 55) score += 4;
      else if (day_range_pct <= 25) score -= 8;

      // 5. Streak & 3M Position (+/- 8 pts)
      if (streak >= 2) score += 6;
      else if (streak === 1) score += 3;
      else if (streak <= -2) score -= 5;

      // 6. Fundamental Category & P/E (+/- 6 pts)
      if (category === "A") score += 4;
      else if (category === "Z") score -= 5;
      if (pe1 !== null && pe1 > 0 && pe1 <= 15) score += 3;

      score = Math.max(5, Math.min(99, Math.round(score)));

      // Determine Primary Signal Verdict & Filter Flags
      const isAboveVwap = vwap_pct !== null ? vwap_pct >= 0 : pct_change >= 0;
      const isBreakout = volume > 0 && rvol >= 1.5 && pct_change > 0 && isAboveVwap && day_range_pct >= 55;
      const isSurge30m =
        volume > 0 && slot_delta_ltp > 0 && slot_delta_vol > 5000 && slot_burst_ratio >= 1.15 && isAboveVwap;
      const isAccumulation = volume > 0 && streak >= 2 && rvol >= 1.0 && isAboveVwap;
      const isSupportBounce =
        volume > 0 && range_3m_pct <= 35 && pct_change > 0 && isAboveVwap && rvol >= 0.9;
      const isDistribution =
        volume > 0 &&
        ((rvol >= 1.3 && vwap_pct !== null && vwap_pct < -0.3) ||
          (rvol >= 1.4 && day_range_pct <= 30 && pct_change <= 0) ||
          (vwap_pct !== null && vwap_pct <= -1.2 && volume >= 50000));

      let signal_type = "neutral";
      let signal_label = "Neutral / Hold";
      let signal_rank = 3;
      let signal_reason = "Normal trading activity within average volume and range.";

      if (isDistribution) {
        signal_type = "distribution";
        signal_label = "⚠️ Distribution Warning";
        signal_rank = 1;
        signal_reason = `High volume (${rvol}x 20D avg) but LTP (${fmtCompact(
          ltp
        )}) is fading below intraday VWAP (${fmtCompact(vwap)}) or near day low (${day_range_pct}% range). Sellers absorbing bids.`;
      } else if (isBreakout) {
        signal_type = "breakout";
        signal_label = "🟢 Volume Breakout";
        signal_rank = 6;
        signal_reason = `Unusual volume inflow (${rvol}x 20D avg) with buyers holding LTP ${
          vwap_pct !== null ? `+${vwap_pct}% above VWAP` : "near day high"
        } (${day_range_pct}% of day range).`;
      } else if (isSurge30m) {
        signal_type = "surge30m";
        signal_label = "🚀 30m Slot Surge";
        signal_rank = 5;
        signal_reason = `Fresh buying burst in the latest 30m window (+${fmtCompact(
          slot_delta_ltp
        )} BDT on ${fmtInt(slot_delta_vol)} shares, ${slot_burst_ratio}x slot pace).`;
      } else if (isSupportBounce) {
        signal_type = "support_bounce";
        signal_label = "🔄 3M Support Bounce";
        signal_rank = 4;
        signal_reason = `Reversing upward from bottom ${range_3m_pct}% of its 3-month range (${fmtCompact(
          low_3m
        )}–${fmtCompact(high_3m)}) with buyers above VWAP.`;
      } else if (isAccumulation) {
        signal_type = "accumulation";
        signal_label = "📈 Multi-Day Accum.";
        signal_rank = 4;
        signal_reason = `${streak} consecutive positive closes on ${rvol}x 20-day average volume with price holding above VWAP.`;
      } else if (pct_change < -1.0 && !isAboveVwap) {
        signal_type = "weak";
        signal_label = "🔻 Seller Control";
        signal_rank = 2;
        signal_reason = `Trading below intraday VWAP (${
          vwap_pct !== null ? `${vwap_pct}%` : "--"
        }) with negative price momentum (${pct_change}%).`;
      }

      enrichedStocks.push({
        symbol: sym,
        company_name: cdet.company_name || sym,
        sector,
        category,
        pe1,
        pe2,
        ltp,
        ycp,
        high,
        low,
        change,
        pct_change,
        volume,
        valueMn,
        vwap,
        vwap_pct,
        day_range_pct,
        avg_vol_20d,
        rvol,
        slot_delta_vol,
        slot_delta_ltp,
        slot_burst_ratio,
        streak,
        high_3m,
        low_3m,
        range_3m_pct,
        strongHandsPct,
        sponsorPct,
        instPct,
        score,
        signal_type,
        signal_label,
        signal_rank,
        signal_reason,
        isBreakout,
        isSurge30m,
        isAccumulation,
        isSupportBounce,
        isDistribution,
        isAboveVwap,
        slotPoints,
        dailySeries: combinedDaily.slice(0, 22),
      });
    }

    state.stocks = enrichedStocks;
    state.latestWindowLabel = latestSlotMinsGlobal > 0 ? minsToTimeLabel(latestSlotMinsGlobal) : "Market Close";

    const sectorCounts = {};
    for (const s of enrichedStocks) {
      sectorCounts[s.sector] = (sectorCounts[s.sector] || 0) + 1;
    }
    state.sectors = Object.keys(sectorCounts).sort();

    populateDropdowns(sectorCounts);
    updateSessionBadge();
    renderKPIs();
    renderWatchlistSection();
    renderSignalBuckets();
    renderRadarTable();

    if (!state.selectedSymbol && enrichedStocks.length > 0) {
      const topBreakout =
        enrichedStocks.find((s) => s.isBreakout) ||
        enrichedStocks.slice().sort((a, b) => b.score - a.score)[0];
      if (topBreakout) {
        selectSymbol(topBreakout.symbol);
      }
    } else if (state.selectedSymbol) {
      selectSymbol(state.selectedSymbol);
    }
  }

  function populateDropdowns(sectorCounts) {
    const secSelect = document.getElementById("radar-sector-select");
    if (secSelect) {
      const current = secSelect.value || "all";
      secSelect.innerHTML = `<option value="all">All Sectors (${state.stocks.length})</option>`;
      for (const sec of state.sectors) {
        const opt = document.createElement("option");
        opt.value = sec;
        opt.textContent = `${sec} (${sectorCounts[sec]})`;
        secSelect.appendChild(opt);
      }
      if (state.sectors.includes(current)) secSelect.value = current;
    }

    const datalist = document.getElementById("all-symbols-datalist");
    if (datalist) {
      datalist.innerHTML = state.stocks
        .map((s) => `<option value="${s.symbol}">${s.company_name} (${s.sector})</option>`)
        .join("");
    }
  }

  function updateSessionBadge() {
    const el = document.getElementById("radar-session-text");
    if (el) {
      el.textContent = `${state.sourceLabel}: ${state.sessionDate} (${state.latestWindowLabel})`;
    }
  }

  function renderKPIs() {
    const traded = state.stocks.filter((s) => s.volume > 0 && s.ltp > 0);
    const breakouts = traded.filter((s) => s.isBreakout).sort((a, b) => b.rvol - a.rvol);
    const surges = traded.filter((s) => s.isSurge30m).sort((a, b) => b.slot_delta_vol - a.slot_delta_vol);
    const buyers = traded.filter((s) => s.vwap_pct !== null && s.vwap_pct >= 0);
    const sellers = traded.filter((s) => s.vwap_pct !== null && s.vwap_pct < 0);
    const dists = traded.filter((s) => s.isDistribution).sort((a, b) => b.rvol - a.rvol);

    document.getElementById("kpi-breakout-count").textContent = `${breakouts.length} Stocks`;
    document.getElementById("kpi-breakout-sub").textContent =
      breakouts.length > 0
        ? `Leaders: ${breakouts
            .slice(0, 3)
            .map((s) => `${s.symbol} (${s.rvol}x)`)
            .join(", ")}`
        : "No RVOL ≥ 1.5x breakouts yet";

    document.getElementById("kpi-surge30m-count").textContent = `${surges.length} Stocks`;
    document.getElementById("kpi-surge30m-sub").textContent =
      surges.length > 0
        ? `Window ${state.latestWindowLabel}: ${surges
            .slice(0, 3)
            .map((s) => s.symbol)
            .join(", ")}`
        : `Latest window: ${state.latestWindowLabel}`;

    const totalVwap = buyers.length + sellers.length || 1;
    const buyerPct = Math.round((buyers.length / totalVwap) * 100);
    const sellerPct = 100 - buyerPct;
    document.getElementById("kpi-vwap-breadth").textContent = `${buyerPct}% Buyers / ${sellerPct}% Sellers`;
    document.getElementById("vwap-bar-buyers").style.width = `${buyerPct}%`;
    document.getElementById("vwap-bar-sellers").style.width = `${sellerPct}%`;
    document.getElementById("kpi-vwap-above").textContent = `${buyers.length} Above VWAP`;
    document.getElementById("kpi-vwap-below").textContent = `${sellers.length} Below VWAP`;

    document.getElementById("kpi-dist-count").textContent = `${dists.length} Alerts`;
    document.getElementById("kpi-dist-sub").textContent =
      dists.length > 0
        ? `Watch: ${dists
            .slice(0, 3)
            .map((s) => s.symbol)
            .join(", ")}`
        : "Low distribution pressure";
  }

  function renderSignalBadgeHtml(st) {
    let cls = "badge-flat";
    if (st.signal_type === "breakout" || st.signal_type === "surge30m" || st.signal_type === "accumulation" || st.signal_type === "support_bounce") {
      cls = "badge-up";
    } else if (st.signal_type === "distribution" || st.signal_type === "weak") {
      cls = "badge-down";
    }
    return `<span class="badge ${cls}">${st.signal_label}</span>`;
  }

  function renderScorePillHtml(score) {
    let cls = "score-pill-neutral";
    if (score >= 68) cls = "score-pill-bull";
    else if (score <= 38) cls = "score-pill-bear";
    return `<span class="score-pill ${cls}">${score}</span>`;
  }

  function renderWatchlistSection() {
    const tbody = document.getElementById("watchlist-tbody");
    const bodyEl = document.getElementById("watchlist-body");
    const toggleBtn = document.getElementById("btn-watchlist-toggle");
    if (!tbody || !bodyEl) return;

    bodyEl.hidden = state.watchlistCollapsed;
    if (toggleBtn) {
      toggleBtn.textContent = state.watchlistCollapsed ? "Show Watchlist" : "Hide";
    }

    const starredStocks = state.stocks.filter((s) => state.watchlist.has(s.symbol));
    const buyersCount = starredStocks.filter((s) => s.isAboveVwap).length;
    const rvolCount = starredStocks.filter((s) => s.rvol >= 1.5).length;
    const warnCount = starredStocks.filter((s) => s.isDistribution || !s.isAboveVwap).length;

    document.getElementById("wl-pill-total").textContent = `${starredStocks.length} Starred`;
    document.getElementById("wl-pill-buyers").textContent = `${buyersCount} Above VWAP`;
    document.getElementById("wl-pill-rvol").textContent = `${rvolCount} RVOL ≥ 1.5x`;
    document.getElementById("wl-pill-warn").textContent = `${warnCount} Below VWAP / Warn`;

    if (starredStocks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 18px; color: var(--text-muted);">No stocks pinned yet. Click ☆ next to any stock below or type a symbol above and click <strong>+ Pin</strong>.</td></tr>`;
      return;
    }

    tbody.innerHTML = starredStocks
      .sort((a, b) => b.score - a.score)
      .map((st) => {
        const chgCls = st.pct_change > 0 ? "text-up" : st.pct_change < 0 ? "text-down" : "text-flat";
        const vwapCls =
          st.vwap_pct !== null ? (st.vwap_pct >= 0 ? "text-up" : "text-down") : "text-flat";
        const rvolCls = st.rvol >= 1.5 ? (st.pct_change >= 0 ? "text-up" : "text-down") : "text-flat";
        const slotCls = st.slot_delta_ltp > 0 ? "text-up" : st.slot_delta_ltp < 0 ? "text-down" : "text-flat";
        const streakStr = st.streak > 0 ? `+${st.streak}D` : st.streak < 0 ? `${st.streak}D` : "0D";
        const streakCls = st.streak > 0 ? "text-up" : st.streak < 0 ? "text-down" : "text-flat";

        return `<tr data-symbol="${st.symbol}" class="${state.selectedSymbol === st.symbol ? "selected" : ""}">
          <td class="stock-name-cell">${formatStockCellHtml(st, true)}</td>
          <td style="text-align: left;">${renderSignalBadgeHtml(st)}</td>
          <td>${renderScorePillHtml(st.score)}</td>
          <td class="${chgCls}" style="font-weight: 600;">${fmtCompact(st.ltp, 2)}</td>
          <td class="${chgCls}">${st.pct_change > 0 ? "+" : ""}${fmtNum(st.pct_change, 2)}%</td>
          <td>${st.vwap !== null ? fmtCompact(st.vwap, 2) : "--"}</td>
          <td class="${vwapCls}" style="font-weight: 600;">${
            st.vwap_pct !== null ? `${st.vwap_pct > 0 ? "+" : ""}${fmtNum(st.vwap_pct, 2)}%` : "--"
          }</td>
          <td class="${rvolCls}" style="font-weight: 600;">${st.rvol > 0 ? `${fmtNum(st.rvol, 2)}x` : "--"}</td>
          <td class="${slotCls}">${fmtInt(st.slot_delta_vol)} (${
            st.slot_delta_ltp > 0 ? "+" : ""
          }${fmtCompact(st.slot_delta_ltp, 2)})</td>
          <td class="${streakCls}" style="font-weight: 600;">${streakStr}</td>
          <td>${st.range_3m_pct}%</td>
        </tr>`;
      })
      .join("");
  }

  function renderSignalBuckets() {
    const traded = state.stocks.filter((s) => s.volume > 0 && s.ltp > 0);

    const topBreakouts = traded
      .filter((s) => s.isBreakout)
      .sort((a, b) => b.rvol - a.rvol)
      .slice(0, 5);

    const top30m = traded
      .filter((s) => s.slot_delta_ltp > 0 && s.slot_delta_vol > 0)
      .sort((a, b) => b.slot_burst_ratio * b.slot_delta_ltp - a.slot_burst_ratio * a.slot_delta_ltp)
      .slice(0, 5);

    const topStreak = traded
      .filter((s) => s.streak >= 2 && s.isAboveVwap)
      .sort((a, b) => b.streak - a.streak || b.rvol - a.rvol)
      .slice(0, 5);

    const topDist = traded
      .filter((s) => s.isDistribution)
      .sort((a, b) => (a.vwap_pct ?? 0) - (b.vwap_pct ?? 0))
      .slice(0, 5);

    const fillList = (elId, items, rightRender) => {
      const container = document.getElementById(elId);
      if (!container) return;
      if (items.length === 0) {
        container.innerHTML = `<div class="mini-row"><span class="text-flat">None matching right now</span></div>`;
        return;
      }
      container.innerHTML = items
        .map(
          (st) => `<div class="mini-row" data-symbol="${st.symbol}">
            <span class="mini-sym">${formatStockCellHtml(st, false)}</span>
            <span>${rightRender(st)}</span>
          </div>`
        )
        .join("");
    };

    fillList(
      "list-radar-breakouts",
      topBreakouts,
      (s) => `<span class="badge badge-up">${fmtNum(s.rvol, 1)}x / +${fmtNum(s.pct_change, 1)}%</span>`
    );
    fillList(
      "list-radar-30m-burst",
      top30m,
      (s) => `<span class="badge badge-up">+${fmtCompact(s.slot_delta_ltp, 1)} (${fmtNum(s.slot_burst_ratio, 1)}x)</span>`
    );
    fillList(
      "list-radar-streak",
      topStreak,
      (s) =>
        `<span class="badge badge-up">+${s.streak}D / ${
          s.vwap_pct !== null ? `+${fmtNum(s.vwap_pct, 1)}%` : ""
        }</span>`
    );
    fillList(
      "list-radar-distribution",
      topDist,
      (s) =>
        `<span class="badge badge-down">${
          s.vwap_pct !== null ? `${fmtNum(s.vwap_pct, 1)}% VWAP` : `${s.day_range_pct}% Pos`
        } (${fmtNum(s.rvol, 1)}x)</span>`
    );
  }

  function getFilteredAndSortedStocks() {
    const q = state.searchQuery.trim().toUpperCase();
    const filtered = state.stocks.filter((st) => {
      if (state.activeFilter !== "watchlist" && st.volume <= 0 && st.ltp <= 0) return false;
      if (q && !st.symbol.toUpperCase().includes(q) && !st.sector.toUpperCase().includes(q)) {
        return false;
      }
      if (state.selectedSector !== "all" && st.sector !== state.selectedSector) {
        return false;
      }
      if (state.selectedCategory === "A" && st.category !== "A") return false;
      if (state.selectedCategory === "AB" && st.category !== "A" && st.category !== "B") return false;
      if (state.selectedCategory === "Z" && st.category !== "Z") return false;

      switch (state.activeFilter) {
        case "watchlist":
          return state.watchlist.has(st.symbol);
        case "breakout":
          return st.isBreakout;
        case "surge30m":
          return st.isSurge30m;
        case "accumulation":
          return st.isAccumulation;
        case "support_bounce":
          return st.isSupportBounce;
        case "vwap_buyers":
          return st.vwap_pct !== null && st.vwap_pct > 0;
        case "distribution":
          return st.isDistribution;
        default:
          return true;
      }
    });

    const field = state.sortField;
    const dir = state.sortAsc ? 1 : -1;

    filtered.sort((a, b) => {
      if (field === "symbol") {
        return a.symbol.localeCompare(b.symbol) * dir;
      }
      const va = a[field] !== null && a[field] !== undefined ? Number(a[field]) : -999999;
      const vb = b[field] !== null && b[field] !== undefined ? Number(b[field]) : -999999;
      if (va === vb) return b.score - a.score;
      return (va - vb) * dir;
    });

    return filtered;
  }

  function renderRadarTable() {
    const tbody = document.getElementById("radar-tbody");
    if (!tbody) return;

    const rows = getFilteredAndSortedStocks();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 28px; color: var(--text-muted);">No stocks match the current signal filter. Try switching filter pills above.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((st) => {
        const chgCls = st.pct_change > 0 ? "text-up" : st.pct_change < 0 ? "text-down" : "text-flat";
        const vwapCls =
          st.vwap_pct !== null ? (st.vwap_pct >= 0 ? "text-up" : "text-down") : "text-flat";
        const rvolCls =
          st.rvol >= 1.5 ? (st.pct_change >= 0 && st.isAboveVwap ? "text-up" : "text-down") : "";
        const slotCls = st.slot_delta_ltp > 0 ? "text-up" : st.slot_delta_ltp < 0 ? "text-down" : "text-flat";
        const streakStr = st.streak > 0 ? `+${st.streak}D` : st.streak < 0 ? `${st.streak}D` : "0D";
        const streakCls = st.streak > 0 ? "text-up" : st.streak < 0 ? "text-down" : "text-flat";

        return `<tr data-symbol="${st.symbol}" class="${state.selectedSymbol === st.symbol ? "selected" : ""}">
          <td class="stock-name-cell">${formatStockCellHtml(st, true)}</td>
          <td style="text-align: left;">${renderSignalBadgeHtml(st)}</td>
          <td>${renderScorePillHtml(st.score)}</td>
          <td class="${chgCls}" style="font-weight: 600;">${fmtCompact(st.ltp, 2)}</td>
          <td class="${chgCls}">${st.pct_change > 0 ? "+" : ""}${fmtNum(st.pct_change, 2)}%</td>
          <td>${st.vwap !== null ? fmtCompact(st.vwap, 2) : "--"}</td>
          <td class="${vwapCls}" style="font-weight: 600;">${
            st.vwap_pct !== null ? `${st.vwap_pct > 0 ? "+" : ""}${fmtNum(st.vwap_pct, 2)}%` : "--"
          }</td>
          <td class="${rvolCls}" style="font-weight: 600;" title="Today Vol: ${fmtInt(
            st.volume
          )} | 20D Avg: ${fmtInt(st.avg_vol_20d)}">${st.rvol > 0 ? `${fmtNum(st.rvol, 2)}x` : "--"}</td>
          <td class="${slotCls}">${fmtInt(st.slot_delta_vol)} (${
            st.slot_delta_ltp > 0 ? "+" : ""
          }${fmtCompact(st.slot_delta_ltp, 2)})</td>
          <td>
            <div class="mini-range-cell" title="Low: ${fmtCompact(st.low)} | High: ${fmtCompact(st.high)}">
              <div class="mini-range-bar"><div class="mini-range-fill" style="width: ${st.day_range_pct}%"></div></div>
              <span>${st.day_range_pct}%</span>
            </div>
          </td>
          <td class="${streakCls}" style="font-weight: 600;">${streakStr}</td>
          <td title="3M Low: ${fmtCompact(st.low_3m)} | 3M High: ${fmtCompact(st.high_3m)}">${st.range_3m_pct}%</td>
        </tr>`;
      })
      .join("");
  }

  function updateInspectorStarButton(symbol) {
    const starBtn = document.getElementById("insp-star-btn");
    if (!starBtn) return;
    const isStarred = state.watchlist.has(symbol);
    starBtn.textContent = isStarred ? "★" : "☆";
    starBtn.classList.toggle("starred", isStarred);
    starBtn.onclick = () => toggleWatchlistSymbol(symbol);
  }

  function setChecklistItem(idx, statusType, detailText) {
    const checklist = document.getElementById("insp-checklist");
    if (!checklist) return;
    const items = checklist.querySelectorAll(".check-item");
    const item = items[idx];
    if (!item) return;
    const badge = item.querySelector(".check-status");
    const detail = item.querySelector(".check-detail");
    if (badge) {
      badge.className = `check-status check-${statusType}`;
      badge.textContent = statusType === "pass" ? "BULL" : statusType === "warn" ? "WARN" : "NEUT";
    }
    if (detail) {
      detail.textContent = detailText;
    }
  }

  function selectSymbol(symbol) {
    const st = state.stocks.find((s) => s.symbol === symbol);
    if (!st) return;
    state.selectedSymbol = symbol;

    document.getElementById("insp-radar-symbol").textContent = st.symbol;
    document.getElementById("insp-radar-cat").textContent = `Cat ${st.category || "-"}`;
    document.getElementById("insp-radar-sector").textContent = `${st.company_name} • ${st.sector}`;
    document.getElementById("insp-radar-ltp").textContent = `${fmtCompact(st.ltp, 2)} BDT`;

    const chgBadge = document.getElementById("insp-radar-chg");
    chgBadge.textContent = `${st.change > 0 ? "+" : ""}${fmtCompact(st.change, 2)} (${
      st.pct_change > 0 ? "+" : ""
    }${fmtNum(st.pct_change, 2)}%)`;
    chgBadge.className = `badge ${
      st.pct_change > 0 ? "badge-up" : st.pct_change < 0 ? "badge-down" : "badge-flat"
    }`;

    updateInspectorStarButton(symbol);

    const banner = document.getElementById("insp-verdict-banner");
    banner.className = `radar-verdict-banner verdict-${
      st.score >= 65 ? "bull" : st.score <= 40 ? "bear" : "neutral"
    }`;
    document.getElementById("insp-verdict-label").textContent = st.signal_label;
    document.getElementById("insp-verdict-score").textContent = `Score: ${st.score}/100`;
    document.getElementById("insp-verdict-reason").textContent = st.signal_reason;

    // Populate 6-Point Checklist
    // 1. Intraday VWAP Control
    const vwapState =
      st.vwap_pct === null ? "neutral" : st.vwap_pct >= 0.2 ? "pass" : st.vwap_pct < -0.2 ? "warn" : "neutral";
    setChecklistItem(
      0,
      vwapState,
      st.vwap !== null
        ? `LTP ${fmtCompact(st.ltp)} vs VWAP ${fmtCompact(st.vwap)} (${
            st.vwap_pct > 0 ? "+" : ""
          }${fmtNum(st.vwap_pct, 2)}%) — ${st.vwap_pct >= 0 ? "Buyers in control" : "Below VWAP (Seller pressure)"}`
        : "Insufficient turnover data to compute VWAP"
    );

    // 2. Relative Volume (RVOL vs 20D)
    const rvolState =
      st.rvol >= 1.4 ? (st.isAboveVwap ? "pass" : "warn") : st.rvol >= 0.9 ? "neutral" : "warn";
    setChecklistItem(
      1,
      rvolState,
      `Today Vol: ${fmtInt(st.volume)} vs 20D Avg: ${fmtInt(st.avg_vol_20d)} (${fmtNum(st.rvol, 2)}x normal volume)`
    );

    // 3. Latest 30m Window Burst
    const slotState =
      st.slot_delta_ltp > 0 && st.slot_burst_ratio >= 1.1
        ? "pass"
        : st.slot_delta_ltp < 0
        ? "warn"
        : "neutral";
    setChecklistItem(
      2,
      slotState,
      `Latest 30m Vol: ${fmtInt(st.slot_delta_vol)} (${fmtNum(st.slot_burst_ratio, 1)}x slot avg), Price Δ: ${
        st.slot_delta_ltp > 0 ? "+" : ""
      }${fmtCompact(st.slot_delta_ltp, 2)} BDT`
    );

    // 4. Day Range Position
    const dayPosState = st.day_range_pct >= 65 ? "pass" : st.day_range_pct <= 35 ? "warn" : "neutral";
    setChecklistItem(
      3,
      dayPosState,
      `At ${st.day_range_pct}% of Today's Range (Low: ${fmtCompact(st.low)} — High: ${fmtCompact(st.high)})`
    );

    // 5. Multi-Day Streak & 3M Range
    const streakState =
      st.streak >= 2 || (st.range_3m_pct <= 35 && st.pct_change > 0)
        ? "pass"
        : st.streak <= -2
        ? "warn"
        : "neutral";
    setChecklistItem(
      4,
      streakState,
      `Streak: ${st.streak > 0 ? `+${st.streak}` : st.streak} days | 3M Range Pos: ${
        st.range_3m_pct
      }% (${fmtCompact(st.low_3m)}–${fmtCompact(st.high_3m)})`
    );

    // 6. Fundamental & Holding Quality
    const fundState =
      st.category === "A" && (st.pe1 === null || (st.pe1 > 0 && st.pe1 <= 20))
        ? "pass"
        : st.category === "Z"
        ? "warn"
        : "neutral";
    setChecklistItem(
      5,
      fundState,
      `Cat ${st.category || "-"} | P/E: ${st.pe1 ? fmtCompact(st.pe1, 1) : "n/a"} | Sponsor+Inst Holding: ${
        st.strongHandsPct > 0 ? `${st.strongHandsPct}%` : "n/a"
      }`
    );

    const detailLink = document.getElementById("insp-detail-link");
    if (detailLink) {
      detailLink.href = `./detail.html?symbol=${encodeURIComponent(st.symbol)}`;
      detailLink.textContent = `Open Full 3-Month Detail Analysis for ${st.symbol} →`;
    }

    renderIntradayVwapChart(st);
    renderDailyRvolChart(st);

    // Highlight active row in both tables
    document.querySelectorAll("#radar-tbody tr, #watchlist-tbody tr").forEach((tr) => {
      tr.classList.toggle("selected", tr.dataset.symbol === symbol);
    });
  }

  function renderIntradayVwapChart(st) {
    const svg = document.getElementById("insp-intra-vwap-svg");
    const label = document.getElementById("insp-intra-slots-label");
    if (!svg) return;

    const pts = st.slotPoints || [];
    if (label) label.textContent = `${pts.length} half-hourly slots`;

    if (pts.length === 0) {
      svg.innerHTML = `<text x="190" y="80" text-anchor="middle" fill="var(--text-muted)" font-size="12">No intraday slot points available</text>`;
      return;
    }

    const W = 380;
    const H = 155;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const prices = [];
    for (const p of pts) {
      if (p.ltp > 0) prices.push(p.ltp);
      if (p.vwap > 0) prices.push(p.vwap);
    }
    const minP = Math.min(...prices) * 0.996;
    const maxP = Math.max(...prices) * 1.004 || minP + 1;

    const xFor = (i) => (pts.length === 1 ? padL + plotW / 2 : padL + (i / (pts.length - 1)) * plotW);
    const yFor = (val) => padT + plotH - ((val - minP) / (maxP - minP || 1)) * plotH;

    const ltpPoints = pts.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.ltp).toFixed(1)}`).join(" ");
    const vwapPoints = pts.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.vwap || p.ltp).toFixed(1)}`).join(" ");

    const strokeColor = st.isAboveVwap ? "var(--up-color)" : "var(--down-color)";

    svg.innerHTML = `
      <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--border-subtle)" stroke-dasharray="2,2" />
      <line x1="${padL}" y1="${padT + plotH / 2}" x2="${W - padR}" y2="${padT + plotH / 2}" stroke="var(--border-subtle)" stroke-dasharray="2,2" />
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--border-subtle)" />
      <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" fill="var(--text-muted)" font-size="9.5">${fmtCompact(maxP, 1)}</text>
      <text x="${padL - 4}" y="${H - padB}" text-anchor="end" fill="var(--text-muted)" font-size="9.5">${fmtCompact(minP, 1)}</text>
      <polyline fill="none" stroke="var(--accent-primary)" stroke-width="1.5" stroke-dasharray="4,3" points="${vwapPoints}" />
      <polyline fill="none" stroke="${strokeColor}" stroke-width="2.2" points="${ltpPoints}" />
      ${pts
        .map(
          (p, i) =>
            `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.ltp).toFixed(1)}" r="2.8" fill="${strokeColor}" />`
        )
        .join("")}
      <text x="${padL}" y="${H - 6}" fill="var(--text-muted)" font-size="9.5">${pts[0].label}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="var(--text-muted)" font-size="9.5">${
        pts[pts.length - 1].label
      }</text>
    `;
  }

  function renderDailyRvolChart(st) {
    const svg = document.getElementById("insp-daily-rvol-svg");
    const label = document.getElementById("insp-daily-days-label");
    if (!svg) return;

    const days = (st.dailySeries || []).slice(0, 20).reverse();
    if (label) label.textContent = `Last ${days.length} trading days`;

    if (days.length === 0) {
      svg.innerHTML = `<text x="190" y="80" text-anchor="middle" fill="var(--text-muted)" font-size="12">No 20-day history available</text>`;
      return;
    }

    const W = 380;
    const H = 155;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxVol = Math.max(...days.map((d) => d.vol), st.avg_vol_20d || 1, 1);
    const prices = days.map((d) => d.cp).filter((p) => p > 0);
    const minP = Math.min(...prices) * 0.99;
    const maxP = Math.max(...prices) * 1.01 || minP + 1;

    const barW = Math.max(4, Math.floor(plotW / days.length) - 3);
    const xFor = (i) => padL + (i + 0.5) * (plotW / days.length);
    const yPrice = (p) => padT + plotH * 0.55 - ((p - minP) / (maxP - minP || 1)) * (plotH * 0.5);
    const yVol = (v) => padT + plotH - (v / maxVol) * (plotH * 0.42);

    const avgVolY = yVol(st.avg_vol_20d || 0);
    const priceLine = days.map((d, i) => `${xFor(i).toFixed(1)},${yPrice(d.cp).toFixed(1)}`).join(" ");

    svg.innerHTML = `
      <line x1="${padL}" y1="${avgVolY.toFixed(1)}" x2="${W - padR}" y2="${avgVolY.toFixed(
        1
      )}" stroke="var(--accent-primary)" stroke-width="1" stroke-dasharray="3,3" />
      ${days
        .map((d, i) => {
          const prevCp = i > 0 ? days[i - 1].cp : d.cp;
          const barColor = d.cp >= prevCp ? "var(--up-color)" : "var(--down-color)";
          const topY = yVol(d.vol);
          const barH = Math.max(2, padT + plotH - topY);
          return `<rect x="${(xFor(i) - barW / 2).toFixed(1)}" y="${topY.toFixed(
            1
          )}" width="${barW}" height="${barH.toFixed(1)}" fill="${barColor}" opacity="0.55" rx="1" />`;
        })
        .join("")}
      <polyline fill="none" stroke="var(--text-primary)" stroke-width="1.8" points="${priceLine}" />
      <text x="${padL - 4}" y="${padT + 6}" text-anchor="end" fill="var(--text-muted)" font-size="9.5">${fmtCompact(
        maxP,
        1
      )}</text>
      <text x="${padL - 4}" y="${(padT + plotH * 0.55).toFixed(
        0
      )}" text-anchor="end" fill="var(--text-muted)" font-size="9.5">${fmtCompact(minP, 1)}</text>
      <text x="${padL}" y="${H - 5}" fill="var(--text-muted)" font-size="9.5">${days[0].date}</text>
      <text x="${W - padR}" y="${H - 5}" text-anchor="end" fill="var(--text-muted)" font-size="9.5">${
        days[days.length - 1].date
      }</text>
    `;
  }

  function exportRadarCSV() {
    const rows = getFilteredAndSortedStocks();
    const headers = [
      "symbol",
      "sector",
      "category",
      "signal_verdict",
      "score",
      "ltp",
      "pct_change",
      "vwap",
      "vwap_pct",
      "rvol_20d",
      "volume_today",
      "avg_vol_20d",
      "slot_30m_delta_vol",
      "slot_30m_delta_ltp",
      "day_range_pct",
      "streak_days",
      "range_3m_pct",
      "pe1",
      "pe2",
      "starred",
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.symbol,
          `"${(r.sector || "").replace(/"/g, '""')}"`,
          r.category || "",
          `"${r.signal_label}"`,
          r.score,
          r.ltp,
          r.pct_change,
          r.vwap ?? "",
          r.vwap_pct ?? "",
          r.rvol,
          r.volume,
          r.avg_vol_20d,
          r.slot_delta_vol,
          r.slot_delta_ltp,
          r.day_range_pct,
          r.streak,
          r.range_3m_pct,
          r.pe1 ?? "",
          r.pe2 ?? "",
          state.watchlist.has(r.symbol) ? "YES" : "NO",
        ].join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dse_decision_radar_${state.sessionDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function safeFetchJson(url) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
    } catch (_e) {}
    return null;
  }

  async function loadAllRadarData() {
    const ts = Date.now();
    const [marketPayload, daily3m, hourly3m, symbolMeta, companyDetails] = await Promise.all([
      safeFetchJson(`./data/market_data.json?t=${ts}`),
      safeFetchJson(`./data/daily_3m.json?t=${ts}`),
      safeFetchJson(`./data/hourly_3m.json?t=${ts}`),
      safeFetchJson(`./data/symbol_meta.json?t=${ts}`),
      safeFetchJson(`./data/company_details.json?t=${ts}`),
    ]);

    const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
    const savedKey = localStorage.getItem(STORAGE_ANON_KEY);

    if (savedUrl && savedKey) {
      try {
        const cleanUrl = savedUrl.replace(/\/+$/, "");
        const headers = { apikey: savedKey, Authorization: `Bearer ${savedKey}` };
        const [dynResp, statResp] = await Promise.all([
          fetch(`${cleanUrl}/rest/v1/dse_dynamic?select=*&order=timestamp.desc&limit=2500`, { headers }),
          fetch(`${cleanUrl}/rest/v1/dse_static?select=*&limit=1000`, { headers }),
        ]);
        if (dynResp.ok && statResp.ok) {
          const dynRows = await dynResp.json();
          const statRows = await statResp.json();
          const history = {};
          const latestDyn = [];
          const seen = new Set();
          for (const r of dynRows) {
            if (!r.symbol) continue;
            if (!seen.has(r.symbol)) {
              seen.add(r.symbol);
              latestDyn.push(r);
            }
            if (!history[r.symbol]) history[r.symbol] = [];
            history[r.symbol].push({
              t: r.timestamp,
              ltp: r.ltp,
              v: r.volume,
              val: r.value,
              chg: r.change,
            });
          }
          for (const sym of Object.keys(history)) history[sym].reverse();
          state.sourceLabel = "Supabase Live";
          buildDecisionState(
            { generated_at: latestDyn[0]?.timestamp, dynamic: latestDyn, static: statRows, history },
            daily3m || {},
            hourly3m || {},
            symbolMeta || {},
            companyDetails || {}
          );
          return;
        }
      } catch (e) {
        console.warn("Supabase live fetch failed on Radar, falling back to snapshot archives:", e);
      }
    }

    state.sourceLabel = "Snapshot";
    buildDecisionState(
      marketPayload || {},
      daily3m || {},
      hourly3m || {},
      symbolMeta || {},
      companyDetails || {}
    );
  }

  function setActiveFilterPill(filterName) {
    state.activeFilter = filterName;
    document.querySelectorAll("#radar-filter-group .filter-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === filterName);
    });
    renderRadarTable();
  }

  function initEvents() {
    loadWatchlistFromStorage();
    state.watchlistCollapsed = localStorage.getItem(STORAGE_WL_COLLAPSED_KEY) === "1";

    // Search box
    document.getElementById("radar-search-input").addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderRadarTable();
    });

    // Sector filter
    document.getElementById("radar-sector-select").addEventListener("change", (e) => {
      state.selectedSector = e.target.value;
      renderRadarTable();
    });

    // Category filter
    document.getElementById("radar-category-select").addEventListener("change", (e) => {
      state.selectedCategory = e.target.value;
      renderRadarTable();
    });

    // Filter pills
    document.querySelectorAll("#radar-filter-group .filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveFilterPill(btn.dataset.filter);
      });
    });

    // Clickable KPI cards for quick filtering
    document.querySelectorAll(".radar-kpi-clickable").forEach((card) => {
      card.addEventListener("click", () => {
        const qf = card.getAttribute("data-QuickFilter");
        if (qf) setActiveFilterPill(qf);
      });
    });

    // Sortable table headers
    document.querySelectorAll("#radar-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (state.sortField === field) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortField = field;
          state.sortAsc = field === "symbol";
        }
        renderRadarTable();
      });
    });

    // Delegated click handler for table rows, star buttons, and mini-lists
    document.body.addEventListener("click", (e) => {
      const starBtn = e.target.closest("[data-star-symbol]");
      if (starBtn) {
        e.stopPropagation();
        toggleWatchlistSymbol(starBtn.getAttribute("data-star-symbol"));
        return;
      }

      if (e.target.closest("[data-prevent-row]")) {
        return;
      }

      const rowOrMini = e.target.closest("tr[data-symbol], .mini-row[data-symbol]");
      if (rowOrMini) {
        const sym = rowOrMini.getAttribute("data-symbol");
        if (sym) selectSymbol(sym);
      }
    });

    // Watchlist add button & Enter key
    const addInput = document.getElementById("watchlist-add-input");
    const handleAddWatchlist = () => {
      if (!addInput) return;
      const raw = addInput.value.trim().toUpperCase();
      if (!raw) return;
      const match = state.stocks.find((s) => s.symbol === raw);
      if (match) {
        state.watchlist.add(match.symbol);
        saveWatchlistToStorage();
        addInput.value = "";
        state.watchlistCollapsed = false;
        localStorage.setItem(STORAGE_WL_COLLAPSED_KEY, "0");
        renderWatchlistSection();
        renderRadarTable();
        selectSymbol(match.symbol);
      }
    };
    document.getElementById("btn-watchlist-add").addEventListener("click", handleAddWatchlist);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddWatchlist();
      }
    });

    // Watchlist collapse toggle
    document.getElementById("btn-watchlist-toggle").addEventListener("click", () => {
      state.watchlistCollapsed = !state.watchlistCollapsed;
      localStorage.setItem(STORAGE_WL_COLLAPSED_KEY, state.watchlistCollapsed ? "1" : "0");
      renderWatchlistSection();
    });

    // Export CSV
    document.getElementById("btn-export-radar-csv").addEventListener("click", exportRadarCSV);

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

    // Supabase modal
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
      await loadAllRadarData();
    });

    document.getElementById("btn-save-supabase").addEventListener("click", async () => {
      const u = urlInput.value.trim();
      const k = keyInput.value.trim();
      if (u && k) {
        localStorage.setItem(STORAGE_URL_KEY, u);
        localStorage.setItem(STORAGE_ANON_KEY, k);
        modal.hidden = true;
        await loadAllRadarData();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    loadAllRadarData().catch((err) => {
      console.error("Failed to load Decision Radar data:", err);
      document.getElementById("radar-session-text").textContent = "Error loading signals";
    });
  });
})();
