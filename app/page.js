"use client";

import { useState, useMemo, useRef } from "react";
import Papa from "papaparse";
import JSZip from "jszip";
import "./style.css";

const TZ = "Europe/Rome";

function toNum(v) {
  const s = String(v ?? "").trim().replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) return Number(s.replace(/\./g, "").replace(",", "."));
  if (s.includes(",")) return Number(s.replace(",", "."));
  return Number(s);
}

function findHeader(row, names) {
  const map = {};
  Object.keys(row).forEach(k => map[k.toLowerCase().trim().replace("\ufeff", "")] = k);
  for (const name of names) if (map[name]) return map[name];
  return null;
}

function parseDate(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;

  // TradingView CSV: UNIX timestamp UTC, seconds or milliseconds
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw));

  let d = new Date(raw.replace(" ", "T"));
  if (!Number.isNaN(d.getTime())) return d;

  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || "00"}`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

function timeKeyIT(d) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

function itDate(d, seconds = true) {
  if (!d) return "-";
  const p = new Intl.DateTimeFormat("it-IT", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: false
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}${seconds ? ":" + p.second : ""}`;
}

function reportDate(d) {
  const s = itDate(d, true);
  const [date, tm] = s.split(" ");
  const [dd, mm, yy] = date.split("/");
  return `${yy}.${mm}.${dd} ${tm}`;
}

function money(v) {
  return Number(v || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\./g, " ");
}

function price(v) {
  return Number(v).toFixed(3);
}

function pnl(side, entry, exit, lot, pointValue) {
  return side === "buy" ? (exit - entry) * lot * pointValue : (entry - exit) * lot * pointValue;
}

function candleMenu(c) {
  return `${itDate(c.time, false)} | O ${price(c.open)} H ${price(c.high)} L ${price(c.low)} C ${price(c.close)}`;
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

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function setSecond(d, s) {
  const x = new Date(d);
  x.setSeconds(s);
  return x;
}

function Chart({ candles, trades, selected, preview, onPick, onPreview }) {
  const ref = useRef(null);
  const visible = candles.slice(-360);
  if (!visible.length) return <div className="empty-chart">Carica un CSV TradingView/OANDA per vedere il grafico con anteprima.</div>;

  const W = 1200, H = 520, L = 54, R = 20, T = 24, B = 38;
  const min = Math.min(...visible.map(c => c.low));
  const max = Math.max(...visible.map(c => c.high));
  const range = max - min || 1;
  const step = (W - L - R) / visible.length;
  const y = v => T + (max - v) / range * (H - T - B);

  function candleFromEvent(e) {
    const rect = ref.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const idx = Math.max(0, Math.min(visible.length - 1, Math.floor((x - L) / step)));
    return visible[idx];
  }

  return (
    <svg className="chart" ref={ref} viewBox={`0 0 ${W} ${H}`} onClick={e => onPick(candleFromEvent(e))} onMouseMove={e => onPreview(candleFromEvent(e))} onMouseLeave={() => onPreview(null)}>
      <rect x="0" y="0" width={W} height={H} rx="16" fill="#08111d" />
      {[0,1,2,3,4].map(i => {
        const yy = T + i * (H - T - B) / 4;
        const val = max - i * range / 4;
        return <g key={i}><line x1={L} x2={W-R} y1={yy} y2={yy} stroke="#1f2f43" /><text x={W-R-2} y={yy-5} fill="#8ea6bf" fontSize="12" textAnchor="end">{price(val)}</text></g>;
      })}
      {visible.map((c, i) => {
        const x = L + i * step + step / 2;
        const color = c.close >= c.open ? "#089981" : "#f23645";
        const bodyY = Math.min(y(c.open), y(c.close));
        const bodyH = Math.max(2, Math.abs(y(c.close) - y(c.open)));
        const isSelected = selected && selected.id === c.id;
        const isPreview = preview && preview.id === c.id;
        return <g key={c.id}>
          {isPreview && <rect x={x - step/2} y={T} width={step} height={H-T-B} fill="rgba(59,130,246,0.12)" />}
          <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1.2" />
          <rect x={x - Math.max(2, step * .32)} y={bodyY} width={Math.max(3, step * .64)} height={bodyH} fill={color} />
          {isSelected && <circle cx={x} cy={y(c.close)} r="7" fill="#2563eb" stroke="#fff" strokeWidth="2" />}
        </g>;
      })}
      {trades.map((t, i) => {
        const oi = visible.findIndex(c => c.id === t.openCandleId);
        const ci = visible.findIndex(c => c.id === t.closeCandleId);
        if (oi < 0 || ci < 0) return null;
        const x1 = L + oi * step + step / 2, x2 = L + ci * step + step / 2;
        const y1 = y(t.entry), y2 = y(t.exit);
        const color = t.side === "buy" ? "#3b82f6" : "#ef4444";
        return <g key={i}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="2" /><circle cx={x1} cy={y1} r="6" fill={color} stroke="#fff" /><circle cx={x2} cy={y2} r="6" fill={color} stroke="#fff" /></g>;
      })}
      {(preview || selected) && (() => {
        const mark = preview || selected;
        const idx = visible.findIndex(c => c.id === mark.id);
        if (idx < 0) return null;
        const x = L + idx * step + step / 2;
        return <g>
          <line x1={x} x2={x} y1={T} y2={H-B} stroke="#60a5fa" strokeDasharray="5 5" />
          <rect x={Math.min(x + 12, W - 304)} y={42} width="292" height="138" rx="10" fill="#0f1c2e" stroke="#315d88" />
          <text x={Math.min(x + 28, W - 288)} y="68" fill="#ffffff" fontSize="14" fontWeight="700">{itDate(mark.time)}</text>
          <text x={Math.min(x + 28, W - 288)} y="94" fill="#cbd5e1" fontSize="13">Open: {price(mark.open)}</text>
          <text x={Math.min(x + 28, W - 288)} y="116" fill="#cbd5e1" fontSize="13">High: {price(mark.high)}</text>
          <text x={Math.min(x + 28, W - 288)} y="138" fill="#cbd5e1" fontSize="13">Low: {price(mark.low)}</text>
          <text x={Math.min(x + 28, W - 288)} y="160" fill="#cbd5e1" fontSize="13">Close: {price(mark.close)}</text>
        </g>;
      })()}
      <text x={L} y={H-12} fill="#8ea6bf" fontSize="13">Passa sopra una candela per anteprima · clicca per selezionarla</text>
    </svg>
  );
}

function renderReportBlob(trades, layout, tab, deposit, credit, withdrawal) {
  const totalProfit = trades.reduce((a, t) => a + t.profit, 0);
  const balance = Number(deposit) + Number(credit) - Number(withdrawal) + totalProfit;
  const canvas = document.createElement("canvas");
  canvas.width = 828; canvas.height = 1792;
  const ctx = canvas.getContext("2d");
  const dark = layout === "dark", compact = layout === "compact";
  ctx.fillStyle = dark ? "#080808" : "#ffffff"; ctx.fillRect(0,0,828,1792);
  const blue="#2391f0", red="#e1323c", main=dark?"#fff":"#151515", muted=dark?"#d0d0d0":"#555", grey=dark?"#b0b0b0":"#707070", line=dark?"#2d2d2d":"#e6e6e6";
  if (dark) {
    ctx.fillStyle="#161616"; ctx.strokeStyle="#464646"; roundRect(ctx,35,35,758,82,42,true,true);
    ["Day","Week","Month","Custom"].forEach((t,i)=>{ const x=35+i*758/4; if(t===tab){ctx.fillStyle="#414141";roundRect(ctx,x+8,43,758/4-16,66,36,true,false)} ctx.fillStyle="#fff"; ctx.font="700 32px Arial"; ctx.fillText(t,x+758/8-ctx.measureText(t).width/2,89);});
  } else {
    ctx.fillStyle="#eee"; ctx.strokeStyle="#ddd"; roundRect(ctx,95,24,618,66,8,true,true);
    ["Day","Week","Month","Custom"].forEach((t,i)=>{ const x=95+i*618/4; if(t===tab){ctx.fillStyle="#fff";roundRect(ctx,x+4,28,618/4-8,58,6,true,false)} ctx.fillStyle="#151515"; ctx.font="700 30px Arial"; ctx.fillText(t,x+618/8-ctx.measureText(t).width/2,67);});
  }
  const top=dark?150:118, rowH=compact?96:(dark?106:116), maxRows=compact?11:(dark?10:9);
  trades.slice(0,maxRows).forEach((t,i)=>{ const y=top+i*rowH; ctx.strokeStyle=line; ctx.beginPath(); ctx.moveTo(0,y+rowH-2); ctx.lineTo(828,y+rowH-2); ctx.stroke(); ctx.font="700 32px Arial"; ctx.fillStyle=main; ctx.fillText("XAUUSD, ",20,y+(dark?34:40)); const bw=ctx.measureText("XAUUSD, ").width; ctx.fillStyle=t.side==="buy"?blue:red; ctx.fillText(`${t.side} ${t.lot.toFixed(2)}`,20+bw,y+(dark?34:40)); ctx.font="28px Arial"; ctx.fillStyle=muted; ctx.fillText(`${price(t.entry)} → ${price(t.exit)}`,20,y+(dark?78:86)); ctx.font="700 26px Arial"; const dt=reportDate(t.closeTime); ctx.fillText(dt,808-ctx.measureText(dt).width,y+(dark?42:46)); ctx.font="700 32px Arial"; const pp=money(t.profit); ctx.fillStyle=t.profit>=0?blue:red; ctx.fillText(pp,808-ctx.measureText(pp).width,y+(dark?84:92));});
  const sy=1792-315; ctx.strokeStyle=line; ctx.beginPath(); ctx.moveTo(0,sy); ctx.lineTo(828,sy); ctx.stroke();
  [["Profit:",totalProfit],["Credit:",Number(credit)],["Deposit:",Number(deposit)],["Withdrawal:",Number(withdrawal)],["Balance:",balance]].forEach((r,i)=>{ const y=sy+50+i*40; ctx.font="700 32px Arial"; ctx.fillStyle=grey; ctx.fillText(r[0],20,y); const val=money(r[1]); ctx.fillText(val,798-ctx.measureText(val).width,y);});
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

export default function LucaTradingAuto() {
  const [candles, setCandles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [trades, setTrades] = useState([]);
  const [autoSets, setAutoSets] = useState([]);

  const [layout, setLayout] = useState("white");
  const [tab, setTab] = useState("Day");
  const [pointValue, setPointValue] = useState(100);
  const [deposit, setDeposit] = useState(0);
  const [credit, setCredit] = useState(0);
  const [withdrawal, setWithdrawal] = useState(0);

  const [side, setSide] = useState("buy");
  const [lot, setLot] = useState(0.08);
  const [entryIndex, setEntryIndex] = useState(0);
  const [exitIndex, setExitIndex] = useState(0);
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [entrySecond, setEntrySecond] = useState(17);
  const [exitSecond, setExitSecond] = useState(43);

  const [screenCount, setScreenCount] = useState(5);
  const [autoPositive, setAutoPositive] = useState(5);
  const [autoNegative, setAutoNegative] = useState(1);
  const [profitMin, setProfitMin] = useState(150);
  const [profitMax, setProfitMax] = useState(400);
  const [lotMin, setLotMin] = useState(0.05);
  const [lotMax, setLotMax] = useState(0.20);
  const [startHour, setStartHour] = useState("08:00");
  const [endHour, setEndHour] = useState("22:00");

  const totalProfit = useMemo(() => trades.reduce((a, t) => a + t.profit, 0), [trades]);
  const activeCandle = preview || selected;
  const entry = candles[entryIndex];
  const exit = candles[exitIndex];

  function loadCSV(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: res => {
        const rows = res.data.filter(Boolean);
        if (!rows.length) return alert("CSV vuoto");
        const h = {
          time: findHeader(rows[0], ["time","datetime","date","data","timestamp","time utc","time (utc)"]),
          open: findHeader(rows[0], ["open","apertura","otwarcie"]),
          high: findHeader(rows[0], ["high","massimo","max","najwyzszy","najwyższy"]),
          low: findHeader(rows[0], ["low","minimo","min","najnizszy","najniższy"]),
          close: findHeader(rows[0], ["close","chiusura","zamkniecie","zamknięcie"]),
          volume: findHeader(rows[0], ["volume","vol","tick volume"])
        };
        if (!h.time || !h.open || !h.high || !h.low || !h.close) return alert("CSV non valido. Servono time/open/high/low/close o equivalenti TradingView.");

        const parsed = rows.map((r, index) => {
          const t = parseDate(r[h.time]);
          return {
            id: `row_${index}`,
            rowIndex: index,
            rawTime: String(r[h.time]),
            time: t,
            timeKey: t ? timeKeyIT(t) : "",
            open: toNum(r[h.open]),
            high: toNum(r[h.high]),
            low: toNum(r[h.low]),
            close: toNum(r[h.close]),
            volume: h.volume ? toNum(r[h.volume]) : 0
          };
        })
        .filter(c => c.time && ![c.open,c.high,c.low,c.close].some(Number.isNaN))
        .sort((a,b) => a.time - b.time);

        setCandles(parsed);
        setTrades([]);
        setSelected(null);
        setPreview(null);
        setAutoSets([]);
        setEntryIndex(0);
        setExitIndex(Math.min(1, parsed.length - 1));
        setEntryPrice(parsed[0]?.open.toFixed(3) || "");
        setExitPrice(parsed[1]?.close.toFixed(3) || parsed[0]?.close.toFixed(3) || "");
      }
    });
  }

  function setCandleAsEntry(c) {
    if (!c) return;
    const idx = candles.findIndex(x => x.id === c.id);
    if (idx >= 0) { setEntryIndex(idx); setEntryPrice(candles[idx].open.toFixed(3)); }
  }

  function setCandleAsExit(c) {
    if (!c) return;
    const idx = candles.findIndex(x => x.id === c.id);
    if (idx >= 0) { setExitIndex(idx); setExitPrice(candles[idx].close.toFixed(3)); }
  }

  function addTrade() {
    if (!entry || !exit) return alert("Carica prima un CSV.");
    const ep = Number(entryPrice), xp = Number(exitPrice), l = Number(lot);
    if (Number.isNaN(ep) || ep < entry.low || ep > entry.high) return alert(`Prezzo apertura fuori dalla candela: ${price(entry.low)} - ${price(entry.high)}`);
    if (Number.isNaN(xp) || xp < exit.low || xp > exit.high) return alert(`Prezzo chiusura fuori dalla candela: ${price(exit.low)} - ${price(exit.high)}`);
    const ot = setSecond(entry.time, Number(entrySecond || 0));
    const ct = setSecond(exit.time, Number(exitSecond || 0));
    setTrades([...trades, {
      side,
      lot: l,
      openCandleId: entry.id,
      closeCandleId: exit.id,
      openTime: ot,
      closeTime: ct,
      entry: ep,
      exit: xp,
      profit: pnl(side, ep, xp, l, Number(pointValue))
    }]);
  }

  function filteredCandles() {
    const [sh, sm] = startHour.split(":").map(Number);
    const [eh, em] = endHour.split(":").map(Number);
    return candles.filter(c => {
      const p = new Intl.DateTimeFormat("it-IT", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(c.time).reduce((a,x)=>{a[x.type]=x.value;return a;},{});
      const m = Number(p.hour) * 60 + Number(p.minute);
      return m >= sh * 60 + sm && m <= eh * 60 + em;
    });
  }

  function makeTrade(wantPositive, pool) {
    for (let tries = 0; tries < 800; tries++) {
      const a = randInt(0, pool.length - 2);
      const b = randInt(a + 1, pool.length - 1);
      const c1 = pool[a];
      const c2 = pool[b];
      const l = Number(rand(Number(lotMin), Number(lotMax)).toFixed(2));
      const direction = Math.random() > 0.5 ? "buy" : "sell";

      let entryP, exitP;
      if (wantPositive) {
        if (direction === "buy") {
          entryP = rand(c1.low, c1.high);
          exitP = rand(Math.max(c2.low, entryP + 0.001), c2.high);
        } else {
          entryP = rand(c1.low, c1.high);
          exitP = rand(c2.low, Math.min(c2.high, entryP - 0.001));
        }
      } else {
        if (direction === "buy") {
          entryP = rand(c1.low, c1.high);
          exitP = rand(c2.low, Math.min(c2.high, entryP - 0.001));
        } else {
          entryP = rand(c1.low, c1.high);
          exitP = rand(Math.max(c2.low, entryP + 0.001), c2.high);
        }
      }

      if (Number.isNaN(entryP) || Number.isNaN(exitP)) continue;
      entryP = clamp(entryP, c1.low, c1.high);
      exitP = clamp(exitP, c2.low, c2.high);
      const p = pnl(direction, entryP, exitP, l, Number(pointValue));
      if (wantPositive && p <= 0) continue;
      if (!wantPositive && p >= 0) continue;

      return {
        side: direction,
        lot: l,
        openCandleId: c1.id,
        closeCandleId: c2.id,
        openTime: setSecond(c1.time, randInt(0, 59)),
        closeTime: setSecond(c2.time, randInt(0, 59)),
        entry: Number(entryP.toFixed(3)),
        exit: Number(exitP.toFixed(3)),
        profit: Number(p.toFixed(2))
      };
    }
    return null;
  }

  function generateAuto() {
    const pool = filteredCandles();
    if (pool.length < 5) return alert("Servono più candele nel range selezionato.");
    const created = [];

    for (let s = 0; s < Number(screenCount); s++) {
      let best = null;
      for (let attempt = 0; attempt < 500; attempt++) {
        const arr = [];
        for (let i = 0; i < Number(autoPositive); i++) {
          const t = makeTrade(true, pool);
          if (t) arr.push(t);
        }
        for (let i = 0; i < Number(autoNegative); i++) {
          const t = makeTrade(false, pool);
          if (t) arr.push(t);
        }
        arr.sort((a,b) => a.closeTime - b.closeTime);
        const total = arr.reduce((a,t)=>a+t.profit,0);
        if (total >= Number(profitMin) && total <= Number(profitMax)) {
          best = arr;
          break;
        }
      }
      if (best) created.push({ name: `screen_${String(s+1).padStart(2,"0")}`, trades: best });
    }

    if (!created.length) {
      alert("Non sono riuscito a creare screen con quei vincoli. Allarga profitto min/max o aumenta range/lotti.");
      return;
    }
    setAutoSets(created);
    setTrades(created[0].trades);
  }

  async function downloadAutoZip() {
    if (!autoSets.length) return alert("Genera prima gli screen automatici.");
    const zip = new JSZip();
    let allRows = ["screen,side,lot,open_time,entry,close_time,exit,profit"];
    for (const set of autoSets) {
      const blob = await renderReportBlob(set.trades, layout, tab, deposit, credit, withdrawal);
      zip.file(`${set.name}.png`, blob);
      set.trades.forEach(t => {
        allRows.push(`${set.name},${t.side},${t.lot.toFixed(2)},${itDate(t.openTime)},${price(t.entry)},${itDate(t.closeTime)},${price(t.exit)},${t.profit.toFixed(2)}`);
      });
    }
    zip.file("operazioni_generate.csv", allRows.join("\n"));
    const content = await zip.generateAsync({ type: "blob" });
    downloadBlob(content, "luca_trading_auto_reports.zip");
  }

  async function screenshot() {
    const blob = await renderReportBlob(trades, layout, tab, deposit, credit, withdrawal);
    downloadBlob(blob, "luca_trading_xauusd_report.png");
  }

  return (
    <main className="page">
      <header className="top">
        <div><h1>🥇 Luca Trading Auto</h1><p>CSV TradingView/OANDA corretto su timestamp UNIX UTC, 3 decimali, anteprima candela e generazione automatica.</p></div>
        <button className="primary" onClick={screenshot}>Scarica screen attuale</button>
      </header>
      <div className="layout">
        <aside className="side">
          <h2>1. Carica CSV</h2>
          <input type="file" accept=".csv" onChange={e => e.target.files?.[0] && loadCSV(e.target.files[0])}/>
          <p className="hint">TradingView: OANDA:XAUUSD, timeframe 1m, formato ora Timestamp UNIX.</p>
          <h2>Layout report</h2>
          <select value={layout} onChange={e=>setLayout(e.target.value)}><option value="white">Mobile bianco classico</option><option value="compact">Mobile bianco compatto</option><option value="dark">Mobile nero</option></select>
          <select value={tab} onChange={e=>setTab(e.target.value)}><option>Day</option><option>Week</option><option>Month</option><option>Custom</option></select>
          <h2>Valori account</h2>
          <label>Valore punto 1 lotto</label><input type="number" value={pointValue} onChange={e=>setPointValue(e.target.value)}/>
          <label>Deposit</label><input type="number" value={deposit} onChange={e=>setDeposit(e.target.value)}/>
          <label>Credit</label><input type="number" value={credit} onChange={e=>setCredit(e.target.value)}/>
          <label>Withdrawal</label><input type="number" value={withdrawal} onChange={e=>setWithdrawal(e.target.value)}/>
          <h2>Generazione automatica</h2>
          <label>Numero screen</label><input type="number" value={screenCount} onChange={e=>setScreenCount(e.target.value)}/>
          <label>Operazioni positive per screen</label><input type="number" value={autoPositive} onChange={e=>setAutoPositive(e.target.value)}/>
          <label>Operazioni negative per screen</label><input type="number" value={autoNegative} onChange={e=>setAutoNegative(e.target.value)}/>
          <label>Profitto minimo screen</label><input type="number" value={profitMin} onChange={e=>setProfitMin(e.target.value)}/>
          <label>Profitto massimo screen</label><input type="number" value={profitMax} onChange={e=>setProfitMax(e.target.value)}/>
          <label>Lotto minimo</label><input type="number" step="0.01" value={lotMin} onChange={e=>setLotMin(e.target.value)}/>
          <label>Lotto massimo</label><input type="number" step="0.01" value={lotMax} onChange={e=>setLotMax(e.target.value)}/>
          <label>Ora inizio</label><input value={startHour} onChange={e=>setStartHour(e.target.value)}/>
          <label>Ora fine</label><input value={endHour} onChange={e=>setEndHour(e.target.value)}/>
          <button className="primary full" onClick={generateAuto}>Genera automatico</button>
          <button className="full" onClick={downloadAutoZip}>Scarica ZIP screen</button>
        </aside>
        <section className="content">
          <div className="cards"><div><span>Candele</span><b>{candles.length}</b></div><div><span>Prima</span><b>{candles[0]?itDate(candles[0].time):"-"}</b></div><div><span>Ultima</span><b>{candles.at(-1)?itDate(candles.at(-1).time):"-"}</b></div><div><span>Profitto attuale</span><b className={totalProfit>=0?"pos":"neg"}>{money(totalProfit)}</b></div></div>
          <Chart candles={candles} trades={trades} selected={selected} preview={preview} onPick={setSelected} onPreview={setPreview}/>
          <div className="preview-panel"><div><h3>Anteprima candela</h3>{activeCandle ? <p><b>{itDate(activeCandle.time)}</b> — O {price(activeCandle.open)} · H {price(activeCandle.high)} · L {price(activeCandle.low)} · C {price(activeCandle.close)} · Riga CSV {activeCandle.rowIndex + 1}</p> : <p>Passa sopra una candela nel grafico.</p>}</div><div className="mini-actions"><button onClick={()=>setCandleAsEntry(activeCandle)}>Usa come apertura</button><button onClick={()=>setCandleAsExit(activeCandle)}>Usa come chiusura</button></div></div>
          {autoSets.length > 0 && <div className="auto-list"><h3>Screen automatici generati</h3>{autoSets.map((s,i)=><button key={i} onClick={()=>setTrades(s.trades)}>{s.name} · profit {money(s.trades.reduce((a,t)=>a+t.profit,0))}</button>)}</div>}
          <div className="tradegrid"><div className="box"><h2>Apertura</h2><select value={entryIndex} onChange={e=>{const idx=Number(e.target.value);setEntryIndex(idx);setEntryPrice(candles[idx]?.open.toFixed(3)||"")}}>{candles.map((c,i)=><option key={c.id} value={i}>{candleMenu(c)}</option>)}</select>{entry&&<p className="hint">Range reale: {price(entry.low)} - {price(entry.high)}</p>}<label>Prezzo apertura</label><input type="number" step="0.001" value={entryPrice} onChange={e=>setEntryPrice(e.target.value)}/><label>Secondo apertura</label><input type="number" min="0" max="59" value={entrySecond} onChange={e=>setEntrySecond(e.target.value)}/></div><div className="box"><h2>Chiusura</h2><select value={exitIndex} onChange={e=>{const idx=Number(e.target.value);setExitIndex(idx);setExitPrice(candles[idx]?.close.toFixed(3)||"")}}>{candles.map((c,i)=><option key={c.id} value={i}>{candleMenu(c)}</option>)}</select>{exit&&<p className="hint">Range reale: {price(exit.low)} - {price(exit.high)}</p>}<label>Prezzo chiusura</label><input type="number" step="0.001" value={exitPrice} onChange={e=>setExitPrice(e.target.value)}/><label>Secondo chiusura</label><input type="number" min="0" max="59" value={exitSecond} onChange={e=>setExitSecond(e.target.value)}/></div></div>
          <div className="bar"><select value={side} onChange={e=>setSide(e.target.value)}><option value="buy">BUY</option><option value="sell">SELL</option></select><input type="number" step="0.01" value={lot} onChange={e=>setLot(e.target.value)}/><button className="primary" onClick={addTrade}>Aggiungi operazione</button></div>
          <table><thead><tr><th>#</th><th>Dir</th><th>Lotto</th><th>Apertura</th><th>Prezzo</th><th>Chiusura</th><th>Prezzo</th><th>P/L</th><th></th></tr></thead><tbody>{trades.map((t,i)=><tr key={i}><td>{i+1}</td><td className={t.side==="buy"?"buy":"sell"}>{t.side.toUpperCase()}</td><td>{t.lot.toFixed(2)}</td><td>{itDate(t.openTime)}</td><td>{price(t.entry)}</td><td>{itDate(t.closeTime)}</td><td>{price(t.exit)}</td><td className={t.profit>=0?"pos":"neg"}>{money(t.profit)}</td><td><button onClick={()=>setTrades(trades.filter((_,x)=>x!==i))}>×</button></td></tr>)}</tbody></table>
        </section>
      </div>
    </main>
  );
}
