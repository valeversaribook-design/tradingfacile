"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import JSZip from "jszip";
import "./style.css";

const TZ = "Europe/Rome";

function toNum(v) {
  const s = String(v ?? "").trim().replace(/\s/g, "");
  if (s === "") return NaN;
  if (s.includes(",") && s.includes(".")) return Number(s.replace(/\./g, "").replace(",", "."));
  if (s.includes(",")) return Number(s.replace(",", "."));
  return Number(s);
}

function findHeader(row, names) {
  const map = {};
  Object.keys(row).forEach(k => {
    map[k.toLowerCase().trim().replace("\ufeff", "")] = k;
  });
  for (const name of names) if (map[name]) return map[name];
  return null;
}

function parseDate(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;

  // TradingView CSV: timestamp UNIX UTC.
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw));

  const d1 = new Date(raw.replace(" ", "T"));
  if (!Number.isNaN(d1.getTime())) return d1;

  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d2 = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || "00"}`);
    if (!Number.isNaN(d2.getTime())) return d2;
  }

  return null;
}

function partsIT(d) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d).reduce((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {});
}

function dayKey(d) {
  const p = partsIT(d);
  return `${p.year}-${p.month}-${p.day}`;
}

function dayLabel(d) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(d);
}

function itDate(d, seconds = true) {
  if (!d) return "-";
  const p = partsIT(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}${seconds ? ":" + p.second : ""}`;
}

function reportDate(d) {
  const p = partsIT(d);
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function htmlDate(d) {
  const p = partsIT(d);
  return `${p.year}-${p.month}-${p.day}`;
}

function htmlTime(d) {
  const p = partsIT(d);
  return `${p.hour}:${p.minute}:${p.second}`;
}

function dateFromInputs(dateStr, timeStr) {
  const safeDate = dateStr || "2026-01-01";
  const safeTime = (timeStr || "00:00:00").length === 5 ? `${timeStr}:00` : (timeStr || "00:00:00");
  const [y, m, d] = safeDate.split("-").map(Number);
  const [hh, mm, ss] = safeTime.split(":").map(Number);

  // Crea una data locale browser. Per il report conta il testo mostrato e la coerenza interna.
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0);
}

function money(v) {
  return Number(v || 0).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).replace(/\./g, " ");
}

function price(v) {
  return Number(v || 0).toFixed(2);
}

function pnl(side, entry, exit, lot, pointValue) {
  return side === "buy"
    ? (Number(exit) - Number(entry)) * Number(lot) * Number(pointValue)
    : (Number(entry) - Number(exit)) * Number(lot) * Number(pointValue);
}

function rand(min, max) {
  return Number(min) + Math.random() * (Number(max) - Number(min));
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function choose(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function ohlcValues(c) {
  return [
    { label: "open", value: c.open },
    { label: "high", value: c.high },
    { label: "low", value: c.low },
    { label: "close", value: c.close }
  ];
}

function nearestOHLC(c, target) {
  const values = ohlcValues(c);
  if (target === null || Number.isNaN(target)) return choose(values);
  return values.reduce((best, item) =>
    Math.abs(item.value - target) < Math.abs(best.value - target) ? item : best
  , values[0]);
}

function pickCandleNear(pool, target, startIndex = 0, endIndex = pool.length - 1) {
  const from = Math.max(0, startIndex);
  const to = Math.min(pool.length - 1, endIndex);
  let best = null;

  for (let i = from; i <= to; i++) {
    const c = pool[i];
    const nearest = nearestOHLC(c, target);
    const distance = target === null || Number.isNaN(target) ? Math.random() : Math.abs(nearest.value - target);

    if (!best || distance < best.distance) {
      best = { index: i, candle: c, value: nearest.value, source: nearest.label, distance };
    }
  }

  return best;
}

function withRandomSecond(d) {
  const x = new Date(d);
  x.setSeconds(randInt(0, 59));
  return x;
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function formatCandle(c) {
  return `${itDate(c.time, false)} | O ${price(c.open)} H ${price(c.high)} L ${price(c.low)} C ${price(c.close)}`;
}

function renderReportBlob(trades, layout, tab, deposit, credit, withdrawal) {
  const totalProfit = trades.reduce((a, t) => a + Number(t.profit || 0), 0);
  const balance = Number(deposit || 0) + Number(credit || 0) - Number(withdrawal || 0) + totalProfit;

  const canvas = document.createElement("canvas");
  canvas.width = 828;
  canvas.height = 1792;
  const ctx = canvas.getContext("2d");

  const dark = layout === "dark";
  const compact = layout === "compact";
  ctx.fillStyle = dark ? "#080808" : "#ffffff";
  ctx.fillRect(0, 0, 828, 1792);

  const blue = "#2391f0";
  const red = "#e1323c";
  const main = dark ? "#fff" : "#151515";
  const muted = dark ? "#d0d0d0" : "#555";
  const grey = dark ? "#b0b0b0" : "#707070";
  const line = dark ? "#2d2d2d" : "#e6e6e6";

  if (dark) {
    ctx.fillStyle = "#161616";
    ctx.strokeStyle = "#464646";
    roundRect(ctx, 35, 35, 758, 82, 42, true, true);
    ["Day", "Week", "Month", "Custom"].forEach((t, i) => {
      const x = 35 + i * 758 / 4;
      if (t === tab) {
        ctx.fillStyle = "#414141";
        roundRect(ctx, x + 8, 43, 758 / 4 - 16, 66, 36, true, false);
      }
      ctx.fillStyle = "#fff";
      ctx.font = "700 32px Arial";
      ctx.fillText(t, x + 758 / 8 - ctx.measureText(t).width / 2, 89);
    });
  } else {
    ctx.fillStyle = "#eee";
    ctx.strokeStyle = "#ddd";
    roundRect(ctx, 95, 24, 618, 66, 8, true, true);
    ["Day", "Week", "Month", "Custom"].forEach((t, i) => {
      const x = 95 + i * 618 / 4;
      if (t === tab) {
        ctx.fillStyle = "#fff";
        roundRect(ctx, x + 4, 28, 618 / 4 - 8, 58, 6, true, false);
      }
      ctx.fillStyle = "#151515";
      ctx.font = "700 30px Arial";
      ctx.fillText(t, x + 618 / 8 - ctx.measureText(t).width / 2, 67);
    });
  }

  const top = dark ? 150 : 118;
  const rowH = compact ? 96 : (dark ? 106 : 116);
  const maxRows = compact ? 11 : (dark ? 10 : 9);

  trades.slice(0, maxRows).forEach((t, i) => {
    const y = top + i * rowH;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, y + rowH - 2);
    ctx.lineTo(828, y + rowH - 2);
    ctx.stroke();

    ctx.font = "700 32px Arial";
    ctx.fillStyle = main;
    ctx.fillText("XAUUSD, ", 20, y + (dark ? 34 : 40));

    const bw = ctx.measureText("XAUUSD, ").width;
    ctx.fillStyle = t.side === "buy" ? blue : red;
    ctx.fillText(`${t.side} ${Number(t.lot).toFixed(2)}`, 20 + bw, y + (dark ? 34 : 40));

    ctx.font = "28px Arial";
    ctx.fillStyle = muted;
    ctx.fillText(`${price(t.entry)} → ${price(t.exit)}`, 20, y + (dark ? 78 : 86));

    ctx.font = "700 26px Arial";
    const dt = reportDate(t.closeTime);
    ctx.fillStyle = muted;
    ctx.fillText(dt, 808 - ctx.measureText(dt).width, y + (dark ? 42 : 46));

    ctx.font = "700 32px Arial";
    const pp = money(t.profit);
    ctx.fillStyle = Number(t.profit) >= 0 ? blue : red;
    ctx.fillText(pp, 808 - ctx.measureText(pp).width, y + (dark ? 84 : 92));
  });

  const sy = 1792 - 315;
  ctx.strokeStyle = line;
  ctx.beginPath();
  ctx.moveTo(0, sy);
  ctx.lineTo(828, sy);
  ctx.stroke();

  [
    ["Profit:", totalProfit],
    ["Credit:", Number(credit || 0)],
    ["Deposit:", Number(deposit || 0)],
    ["Withdrawal:", Number(withdrawal || 0)],
    ["Balance:", balance]
  ].forEach((r, i) => {
    const y = sy + 50 + i * 40;
    ctx.font = "700 32px Arial";
    ctx.fillStyle = grey;
    ctx.fillText(r[0], 20, y);
    const val = money(r[1]);
    ctx.fillText(val, 798 - ctx.measureText(val).width, y);
  });

  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

export default function LucaTradingAuto() {
  const [candles, setCandles] = useState([]);
  const [trades, setTrades] = useState([]);
  const [autoSets, setAutoSets] = useState([]);

  const [layout, setLayout] = useState("white");
  const [tab, setTab] = useState("Week");
  const [pointValue, setPointValue] = useState(100);
  const [deposit, setDeposit] = useState(0);
  const [credit, setCredit] = useState(0);
  const [withdrawal, setWithdrawal] = useState(0);

  const [dayFrom, setDayFrom] = useState("");
  const [dayTo, setDayTo] = useState("");
  const [startHour, setStartHour] = useState("08:00");
  const [endHour, setEndHour] = useState("22:00");

  const [screenCount, setScreenCount] = useState(1);
  const [autoPositive, setAutoPositive] = useState(3);
  const [autoNegative, setAutoNegative] = useState(0);
  const [profitMin, setProfitMin] = useState(100);
  const [profitMax, setProfitMax] = useState(300);
  const [lotMin, setLotMin] = useState(0.02);
  const [lotMax, setLotMax] = useState(0.10);

  const [scenario1Side, setScenario1Side] = useState("auto");
  const [scenario1Open, setScenario1Open] = useState("");
  const [scenario1Close, setScenario1Close] = useState("");

  const [scenario2Side, setScenario2Side] = useState("auto");
  const [scenario2Open, setScenario2Open] = useState("");
  const [scenario2Close, setScenario2Close] = useState("");

  const [scenario3Side, setScenario3Side] = useState("auto");
  const [scenario3Open, setScenario3Open] = useState("");
  const [scenario3Close, setScenario3Close] = useState("");

  const totalProfit = useMemo(() => trades.reduce((a, t) => a + Number(t.profit || 0), 0), [trades]);

  const dayOptions = useMemo(() => {
    const map = new Map();
    candles.forEach(c => {
      const key = dayKey(c.time);
      if (!map.has(key)) map.set(key, { key, label: dayLabel(c.time) });
    });
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [candles]);

  const selectedFrom = dayFrom || dayOptions[0]?.key || "";
  const selectedTo = dayTo || dayOptions.at(-1)?.key || "";

  const selectedDayKeys = useMemo(() => {
    const from = selectedFrom <= selectedTo ? selectedFrom : selectedTo;
    const to = selectedFrom <= selectedTo ? selectedTo : selectedFrom;
    return dayOptions.map(d => d.key).filter(k => k >= from && k <= to);
  }, [dayOptions, selectedFrom, selectedTo]);

  const selectedCandles = useMemo(() => {
    if (!selectedDayKeys.length) return candles;
    const set = new Set(selectedDayKeys);
    return candles.filter(c => set.has(dayKey(c.time)));
  }, [candles, selectedDayKeys]);

  function loadCSV(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: res => {
        const rows = res.data.filter(Boolean);
        if (!rows.length) return alert("CSV vuoto.");

        const h = {
          time: findHeader(rows[0], ["time", "datetime", "date", "data", "timestamp", "time utc", "time (utc)"]),
          open: findHeader(rows[0], ["open", "apertura", "otwarcie"]),
          high: findHeader(rows[0], ["high", "massimo", "max", "najwyzszy", "najwyższy"]),
          low: findHeader(rows[0], ["low", "minimo", "min", "najnizszy", "najniższy"]),
          close: findHeader(rows[0], ["close", "chiusura", "zamkniecie", "zamknięcie"]),
          volume: findHeader(rows[0], ["volume", "vol", "tick volume"])
        };

        if (!h.time || !h.open || !h.high || !h.low || !h.close) {
          return alert("CSV non valido. Servono colonne time, open, high, low, close.");
        }

        const parsed = rows.map((r, index) => {
          const t = parseDate(r[h.time]);
          return {
            id: `row_${index}`,
            rowIndex: index + 1,
            rawTime: String(r[h.time]),
            time: t,
            open: toNum(r[h.open]),
            high: toNum(r[h.high]),
            low: toNum(r[h.low]),
            close: toNum(r[h.close]),
            volume: h.volume ? toNum(r[h.volume]) : 0
          };
        })
        .filter(c => c.time && ![c.open, c.high, c.low, c.close].some(Number.isNaN))
        .sort((a, b) => a.time - b.time);

        const days = Array.from(new Set(parsed.map(c => dayKey(c.time)))).sort();
        setCandles(parsed);
        setDayFrom(days[0] || "");
        setDayTo(days.at(-1) || "");
        setTrades([]);
        setAutoSets([]);
      }
    });
  }

  function scenarios() {
    return [
      { side: scenario1Side, open: scenario1Open, close: scenario1Close },
      { side: scenario2Side, open: scenario2Open, close: scenario2Close },
      { side: scenario3Side, open: scenario3Open, close: scenario3Close }
    ].map(s => ({
      side: s.side,
      open: String(s.open).trim() === "" ? null : Number(String(s.open).replace(",", ".")),
      close: String(s.close).trim() === "" ? null : Number(String(s.close).replace(",", "."))
    }));
  }

  function validTimePool(day) {
    const [sh, sm] = String(startHour || "00:00").split(":").map(Number);
    const [eh, em] = String(endHour || "23:59").split(":").map(Number);
    return candles.filter(c => {
      if (dayKey(c.time) !== day) return false;
      const p = partsIT(c.time);
      const m = Number(p.hour) * 60 + Number(p.minute);
      return m >= sh * 60 + sm && m <= eh * 60 + em;
    });
  }

  function buildTrade(wantPositive, pool, sc) {
    const openTarget = sc?.open !== null && !Number.isNaN(sc?.open) ? sc.open : null;
    const closeTarget = sc?.close !== null && !Number.isNaN(sc?.close) ? sc.close : null;

    for (let tries = 0; tries < 900; tries++) {
      let openPick;
      let closePick;

      // Regola fondamentale:
      // i prezzi generati sono SEMPRE valori reali presi dal CSV: open/high/low/close della candela.
      // Se compili uno scenario, quel valore viene usato solo come riferimento:
      // l'app prende il valore OHLC reale più vicino nel CSV.
      if (openTarget !== null) {
        openPick = pickCandleNear(pool, openTarget, 0, pool.length - 2);
      } else {
        const a = randInt(0, pool.length - 2);
        const c1 = pool[a];
        const v1 = choose(ohlcValues(c1));
        openPick = { index: a, candle: c1, value: v1.value, source: v1.label };
      }

      if (!openPick) continue;

      if (closeTarget !== null) {
        closePick = pickCandleNear(pool, closeTarget, openPick.index + 1, pool.length - 1);
      } else {
        const b = randInt(openPick.index + 1, pool.length - 1);
        const c2 = pool[b];
        const v2 = choose(ohlcValues(c2));
        closePick = { index: b, candle: c2, value: v2.value, source: v2.label };
      }

      if (!closePick) continue;

      const entry = Number(openPick.value);
      const exit = Number(closePick.value);

      let side = sc?.side && sc.side !== "auto" ? sc.side : null;
      if (!side) {
        side = wantPositive
          ? (exit >= entry ? "buy" : "sell")
          : (exit >= entry ? "sell" : "buy");
      }

      const lot = Number(rand(Number(lotMin), Number(lotMax)).toFixed(2));
      const profit = Number(pnl(side, entry, exit, lot, Number(pointValue)).toFixed(2));

      if (wantPositive && profit <= 0) continue;
      if (!wantPositive && profit >= 0) continue;

      return {
        side,
        lot,
        openCandleId: openPick.candle.id,
        closeCandleId: closePick.candle.id,
        openTime: withRandomSecond(openPick.candle.time),
        closeTime: withRandomSecond(closePick.candle.time),
        entry: Number(entry.toFixed(2)),
        exit: Number(exit.toFixed(2)),
        entrySource: openPick.source,
        exitSource: closePick.source,
        profit
      };
    }
    return null;
  }

  function generateAuto() {
    if (!candles.length) return alert("Carica prima il CSV.");
    const dayKeys = selectedDayKeys.length ? selectedDayKeys : dayOptions.map(d => d.key);
    if (!dayKeys.length) return alert("Nessun giorno selezionato.");

    const scs = scenarios();
    const created = [];

    for (let s = 0; s < Number(screenCount || 1); s++) {
      let best = null;

      for (let attempt = 0; attempt < 600; attempt++) {
        const arr = [];
        let scenarioCursor = 0;

        for (const day of dayKeys) {
          const pool = validTimePool(day);
          if (pool.length < 5) continue;

          for (let i = 0; i < Number(autoPositive || 0); i++) {
            const sc = scs[scenarioCursor++ % scs.length];
            const t = buildTrade(true, pool, sc);
            if (t) arr.push(t);
          }

          for (let i = 0; i < Number(autoNegative || 0); i++) {
            const sc = scs[scenarioCursor++ % scs.length];
            const t = buildTrade(false, pool, sc);
            if (t) arr.push(t);
          }
        }

        arr.sort((a, b) => a.openTime - b.openTime);
        const total = arr.reduce((a, t) => a + t.profit, 0);

        if (arr.length && total >= Number(profitMin) && total <= Number(profitMax)) {
          best = arr;
          break;
        }
      }

      if (best) created.push({ name: `screen_${String(s + 1).padStart(2, "0")}`, trades: best });
    }

    if (!created.length) {
      alert("Non riesco con questi vincoli. Allarga profitto min/max, lotti o orari.");
      return;
    }

    setAutoSets(created);
    setTrades(created[0].trades);
  }

  function updateTrade(index, field, value) {
    setTrades(prev => prev.map((t, i) => {
      if (i !== index) return t;
      const u = { ...t };

      if (field === "side") u.side = value;
      if (field === "lot") u.lot = toNum(value);
      if (field === "entry") u.entry = toNum(value);
      if (field === "exit") u.exit = toNum(value);
      if (field === "openDate") u.openTime = dateFromInputs(value, htmlTime(t.openTime));
      if (field === "openTime") u.openTime = dateFromInputs(htmlDate(t.openTime), value);
      if (field === "closeDate") u.closeTime = dateFromInputs(value, htmlTime(t.closeTime));
      if (field === "closeTime") u.closeTime = dateFromInputs(htmlDate(t.closeTime), value);

      u.profit = Number(pnl(u.side, u.entry, u.exit, u.lot, Number(pointValue)).toFixed(2));
      return u;
    }));
  }

  async function screenshot() {
    if (!trades.length) return alert("Prima genera o aggiungi almeno una operazione.");
    const blob = await renderReportBlob(trades, layout, tab, deposit, credit, withdrawal);
    downloadBlob(blob, "luca_trading_report.png");
  }

  async function downloadAutoZip() {
    if (!autoSets.length) return alert("Genera prima gli screen.");
    const zip = new JSZip();
    const rows = ["screen,side,lot,open_time,entry,close_time,exit,profit"];

    for (const set of autoSets) {
      const blob = await renderReportBlob(set.trades, layout, tab, deposit, credit, withdrawal);
      zip.file(`${set.name}.png`, blob);
      set.trades.forEach(t => {
        rows.push(`${set.name},${t.side},${Number(t.lot).toFixed(2)},${itDate(t.openTime)},${price(t.entry)},${itDate(t.closeTime)},${price(t.exit)},${Number(t.profit).toFixed(2)}`);
      });
    }

    zip.file("operazioni_generate.csv", rows.join("\n"));
    const content = await zip.generateAsync({ type: "blob" });
    downloadBlob(content, "luca_trading_reports.zip");
  }

  function addBlankTrade() {
    const base = selectedCandles[0] || candles[0];
    const next = selectedCandles[1] || candles[1] || base;
    if (!base) return alert("Carica prima il CSV.");

    const side = "buy";
    const lot = 0.05;
    const entry = base.open;
    const exit = next.close;

    setTrades(prev => [...prev, {
      side,
      lot,
      openCandleId: base.id,
      closeCandleId: next.id,
      openTime: withRandomSecond(base.time),
      closeTime: withRandomSecond(next.time),
      entry,
      exit,
      entrySource: "open",
      exitSource: "close",
      profit: Number(pnl(side, entry, exit, lot, Number(pointValue)).toFixed(2))
    }]);
  }

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>🥇 Luca Trading Definitivo</h1>
          <p>1) Settaggi sopra · 2) Operazioni sotto · 3) Screenshot finale.</p>
        </div>
        <button className="primary" onClick={screenshot}>Scarica screenshot</button>
      </header>

      <section className="panel">
        <h2>1. Settaggi</h2>
        <div className="grid">
          <label>CSV TradingView/OANDA<input type="file" accept=".csv" onChange={e => e.target.files?.[0] && loadCSV(e.target.files[0])}/></label>
          <label>Layout<select value={layout} onChange={e => setLayout(e.target.value)}><option value="white">Bianco classico</option><option value="compact">Bianco compatto</option><option value="dark">Nero</option></select></label>
          <label>Tab report<select value={tab} onChange={e => setTab(e.target.value)}><option>Day</option><option>Week</option><option>Month</option><option>Custom</option></select></label>
          <label>Valore punto 1 lotto<input type="number" value={pointValue} onChange={e => setPointValue(e.target.value)}/></label>
          <label>Deposit<input type="number" value={deposit} onChange={e => setDeposit(e.target.value)}/></label>
          <label>Credit<input type="number" value={credit} onChange={e => setCredit(e.target.value)}/></label>
          <label>Withdrawal<input type="number" value={withdrawal} onChange={e => setWithdrawal(e.target.value)}/></label>
        </div>

        <h3>Periodo</h3>
        <div className="grid">
          <label>Giorno da<select value={selectedFrom} onChange={e => setDayFrom(e.target.value)}>{dayOptions.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
          <label>Giorno a<select value={selectedTo} onChange={e => setDayTo(e.target.value)}>{dayOptions.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
          <label>Ora inizio<input value={startHour} onChange={e => setStartHour(e.target.value)} placeholder="09:30"/></label>
          <label>Ora fine<input value={endHour} onChange={e => setEndHour(e.target.value)} placeholder="18:45"/></label>
        </div>

        <h3>Generazione</h3>
        <div className="grid">
          <label>Numero screen<input type="number" value={screenCount} onChange={e => setScreenCount(e.target.value)}/></label>
          <label>Positive per giorno<input type="number" value={autoPositive} onChange={e => setAutoPositive(e.target.value)}/></label>
          <label>Negative per giorno<input type="number" value={autoNegative} onChange={e => setAutoNegative(e.target.value)}/></label>
          <label>Profitto totale min<input type="number" value={profitMin} onChange={e => setProfitMin(e.target.value)}/></label>
          <label>Profitto totale max<input type="number" value={profitMax} onChange={e => setProfitMax(e.target.value)}/></label>
          <label>Lotto min<input type="number" step="0.01" value={lotMin} onChange={e => setLotMin(e.target.value)}/></label>
          <label>Lotto max<input type="number" step="0.01" value={lotMax} onChange={e => setLotMax(e.target.value)}/></label>
        </div>

        <h3>3 scenari opzionali</h3>
        <p className="hint">Lascia vuoto ciò che vuoi automatico. Se scrivi un prezzo, l’app prende dal CSV il valore reale OHLC più vicino: open, high, low o close.</p>
        <div className="scenario-grid">
          <b>Scenario</b><b>Tipo</b><b>Apertura</b><b>Chiusura</b>
          <span>1</span><select value={scenario1Side} onChange={e => setScenario1Side(e.target.value)}><option value="auto">Automatico</option><option value="buy">BUY</option><option value="sell">SELL</option></select><input type="number" step="0.01" value={scenario1Open} onChange={e => setScenario1Open(e.target.value)} placeholder="automatico"/><input type="number" step="0.01" value={scenario1Close} onChange={e => setScenario1Close(e.target.value)} placeholder="automatico"/>
          <span>2</span><select value={scenario2Side} onChange={e => setScenario2Side(e.target.value)}><option value="auto">Automatico</option><option value="buy">BUY</option><option value="sell">SELL</option></select><input type="number" step="0.01" value={scenario2Open} onChange={e => setScenario2Open(e.target.value)} placeholder="automatico"/><input type="number" step="0.01" value={scenario2Close} onChange={e => setScenario2Close(e.target.value)} placeholder="automatico"/>
          <span>3</span><select value={scenario3Side} onChange={e => setScenario3Side(e.target.value)}><option value="auto">Automatico</option><option value="buy">BUY</option><option value="sell">SELL</option></select><input type="number" step="0.01" value={scenario3Open} onChange={e => setScenario3Open(e.target.value)} placeholder="automatico"/><input type="number" step="0.01" value={scenario3Close} onChange={e => setScenario3Close(e.target.value)} placeholder="automatico"/>
        </div>

        <div className="actions">
          <button className="primary" onClick={generateAuto}>Genera operazioni</button>
          <button onClick={addBlankTrade}>Aggiungi riga manuale</button>
          <button onClick={downloadAutoZip}>Scarica ZIP screen</button>
        </div>

        <div className="stats">
          <div><span>Candele totali</span><b>{candles.length}</b></div>
          <div><span>Candele selezionate</span><b>{selectedCandles.length}</b></div>
          <div><span>Giorni selezionati</span><b>{selectedDayKeys.length}</b></div>
          <div><span>Profitto tabella</span><b className={totalProfit >= 0 ? "pos" : "neg"}>{money(totalProfit)}</b></div>
        </div>
      </section>

      <section className="panel">
        <h2>2. Operazioni modificabili</h2>
        <p className="hint">Puoi cambiare tutto: tipo, lotto, date, orari, apertura e chiusura. Il P/L si aggiorna subito.</p>

        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Tipo</th>
              <th>Lotto</th>
              <th>Data apertura</th>
              <th>Ora apertura</th>
              <th>Prezzo apertura</th>
              <th>Data chiusura</th>
              <th>Ora chiusura</th>
              <th>Prezzo chiusura</th>
              <th>P/L</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) =>
              <tr key={i}>
                <td>{i + 1}</td>
                <td><select className="table-input" value={t.side} onChange={e => updateTrade(i, "side", e.target.value)}><option value="buy">BUY</option><option value="sell">SELL</option></select></td>
                <td><input className="table-input small" type="number" step="0.01" value={t.lot} onChange={e => updateTrade(i, "lot", e.target.value)}/></td>
                <td><input className="table-input date" type="date" value={htmlDate(t.openTime)} onChange={e => updateTrade(i, "openDate", e.target.value)}/></td>
                <td><input className="table-input time" value={htmlTime(t.openTime)} onChange={e => updateTrade(i, "openTime", e.target.value)}/></td>
                <td><input className="table-input price" type="number" step="0.01" value={t.entry} onChange={e => updateTrade(i, "entry", e.target.value)}/>{t.entrySource && <small className="source">CSV {t.entrySource}</small>}</td>
                <td><input className="table-input date" type="date" value={htmlDate(t.closeTime)} onChange={e => updateTrade(i, "closeDate", e.target.value)}/></td>
                <td><input className="table-input time" value={htmlTime(t.closeTime)} onChange={e => updateTrade(i, "closeTime", e.target.value)}/></td>
                <td><input className="table-input price" type="number" step="0.01" value={t.exit} onChange={e => updateTrade(i, "exit", e.target.value)}/>{t.exitSource && <small className="source">CSV {t.exitSource}</small>}</td>
                <td className={Number(t.profit) >= 0 ? "pos" : "neg"}>{money(t.profit)}</td>
                <td><button onClick={() => setTrades(trades.filter((_, x) => x !== i))}>×</button></td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel final">
        <h2>3. Screenshot</h2>
        <p>Quando le operazioni sono corrette, scarica lo screenshot finale.</p>
        <button className="primary big" onClick={screenshot}>Scarica screenshot finale</button>
      </section>
    </main>
  );
}
