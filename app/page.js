"use client";

import { useEffect, useMemo, useState } from "react";
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

  // TradingView CSV: timestamp UNIX UTC, secondi o millisecondi.
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw));

  // Formato Numbers/TradingView esportato:
  // 2026-07-02T19:57:00+02:00
  // 2026-07-02 19:57:00+02:00
  // 2026-07-02T19:57:00
  const iso = raw.replace(" ", "T");
  const d1 = new Date(iso);
  if (!Number.isNaN(d1.getTime())) return d1;

  // Formato italiano: 02/07/2026 19:57:00
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

function candleSignature(c) {
  if (!c?.time) return "";
  return [
    new Date(c.time).getTime(),
    Number(c.open).toFixed(5),
    Number(c.high).toFixed(5),
    Number(c.low).toFixed(5),
    Number(c.close).toFixed(5)
  ].join("|");
}

function todayRomeKey() {
  return dayKey(new Date());
}

function usedCandlesStorageKey() {
  return `luca-trading-used-candles:${todayRomeKey()}`;
}

function readUsedCandlesToday() {
  if (typeof window === "undefined") return new Set();

  try {
    const raw = window.localStorage.getItem(usedCandlesStorageKey());
    const values = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values : []);
  } catch {
    return new Set();
  }
}

function saveUsedCandlesToday(usedSet) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      usedCandlesStorageKey(),
      JSON.stringify(Array.from(usedSet))
    );
  } catch {
    // Se localStorage non è disponibile, l'app continua a funzionare nella sessione.
  }
}



function renderLucaLayoutBlob(trades, layout, deposit, credit, withdrawal) {
  const isAndroid = layout.startsWith("luca_android");
  const isIOS = layout.startsWith("luca_ios");
  const isDark = layout.endsWith("dark");
  if (!isAndroid && !isIOS) return null;

  const ordered = [...trades].sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
  const totalProfit = ordered.reduce((sum, t) => sum + Number(t.profit || 0), 0);
  const depositValue = Number(deposit || 0);
  const creditValue = Number(credit || 0);
  const withdrawalValue = Number(withdrawal || 0);
  const balance = depositValue + creditValue - withdrawalValue + totalProfit;

  const canvas = document.createElement("canvas");
  canvas.width = 828;
  canvas.height = 1792;
  const ctx = canvas.getContext("2d");

  const bg = isDark ? "#000000" : "#ffffff";
  const text = isDark ? "#f4f4f4" : "#111111";
  const muted = isDark ? "#b9b9bd" : "#5e5e63";
  const line = isDark ? "#28282a" : "#e4e4e6";
  const blue = "#0a84ff";
  const red = "#ff3b30";
  const green = "#34c759";
  const navBg = isDark ? "#090909" : "#ffffff";
  const pill = isDark ? "#2a2a2d" : "#ececef";

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  function font(size, weight = "400") {
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif`;
  }

  function txt(value, x, y, size = 24, weight = "400", color = text, align = "left") {
    font(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(String(value), x, y);
    ctx.textAlign = "left";
  }

  function hline(y, x1 = 0, x2 = 828, width = 1) {
    ctx.strokeStyle = line;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
  }

  function rr(x, y, w, h, r, fill, stroke = null, strokeWidth = 1) {
    roundRect(ctx, x, y, w, h, r, false, false);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  function dot(x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawSignal(x, y, color) {
    ctx.fillStyle = color;
    const heights = [8, 13, 18, 24];
    heights.forEach((h, i) => ctx.fillRect(x + i * 9, y - h, 6, h));
  }

  function drawWifi(x, y, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    [24, 16, 8].forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(x, y, r, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
    });
    dot(x, y + 2, 3, color);
  }

  function drawBattery(x, y, pct = "75") {
    const w = 55, h = 26;
    rr(x, y, w, h, 7, isIOS ? green : null, isIOS ? null : muted, 2);
    if (!isIOS) {
      rr(x + 4, y + 4, w * 0.72, h - 8, 3, muted);
    }
    ctx.fillStyle = muted;
    ctx.fillRect(x + w + 3, y + 8, 4, 10);
    if (isIOS) txt(pct, x + w / 2, y + 20, 19, "700", "#ffffff", "center");
  }

  function drawGear(cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 15, cy + Math.sin(a) * 15);
      ctx.lineTo(cx + Math.cos(a) * 21, cy + Math.sin(a) * 21);
      ctx.stroke();
    }
  }

  function drawCandles(cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    [[-13, -18, 8, 25], [0, -8, 8, 22], [13, -20, 8, 28]].forEach(([dx, dy, w, h]) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx + w / 2, cy + dy - 7);
      ctx.lineTo(cx + dx + w / 2, cy + dy + h + 7);
      ctx.stroke();
      ctx.strokeRect(cx + dx, cy + dy, w, h);
    });
  }

  function drawTradeIcon(cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 19, cy + 12);
    ctx.lineTo(cx - 6, cy - 2);
    ctx.lineTo(cx + 3, cy + 5);
    ctx.lineTo(cx + 20, cy - 17);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 10, cy - 17);
    ctx.lineTo(cx + 20, cy - 17);
    ctx.lineTo(cx + 20, cy - 7);
    ctx.stroke();
  }

  function drawHistoryIcon(cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, 18, -Math.PI * 0.15, Math.PI * 1.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy - 9);
    ctx.lineTo(cx - 25, cy - 10);
    ctx.lineTo(cx - 21, cy - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 11);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 9, cy + 5);
    ctx.stroke();
  }

  function drawQuotesIcon(cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy + 14);
    ctx.lineTo(cx - 9, cy - 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 15, cy - 7);
    ctx.lineTo(cx - 9, cy - 14);
    ctx.lineTo(cx - 3, cy - 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 9, cy - 14);
    ctx.lineTo(cx + 9, cy + 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 3, cy + 7);
    ctx.lineTo(cx + 9, cy + 14);
    ctx.lineTo(cx + 15, cy + 7);
    ctx.stroke();
  }

  function drawAndroidSystemBar() {
    const y = 1727;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, y, 828, 65);
    ctx.strokeStyle = "#bcbcbc";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(165, 1759); ctx.lineTo(187, 1746); ctx.lineTo(187, 1772); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(414, 1759, 12, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeRect(648, 1748, 23, 23);
  }

  function fmtPrice(v) {
    return Number(v).toFixed(2);
  }

  // =========================
  // LUCA ANDROID
  // =========================
  if (isAndroid) {
    // Status bar, proporzioni del riferimento Android allegato.
    txt("11:11", 18, 34, 22, "700", text);
    drawSignal(704, 31, text);
    txt("4G", 751, 34, 18, "700", text);
    drawBattery(783, 12, "75");

    // Header "Storico / Tutti i simboli"
    txt("☰", 20, 83, 27, "600", muted);
    txt("Storico", 59, 65, 27, "700", text);
    txt("Tutti i simboli", 59, 96, 20, "400", muted);
    txt("$", 704, 77, 20, "700", muted);
    txt("↕", 756, 78, 25, "500", muted);
    txt("▦", 807, 78, 23, "500", muted, "right");
    hline(115);

    // Profitto/Bilancio in alto, con puntinatura.
    const sumRows = [
      ["Profitto:", totalProfit, true],
      ["Bilancio:", balance, false]
    ];
    sumRows.forEach((row, i) => {
      const y = 146 + i * 35;
      txt(row[0], 23, y, 26, "700", text);
      ctx.strokeStyle = isDark ? "#444448" : "#c8c8ca";
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 7]);
      ctx.beginPath();
      ctx.moveTo(150, y - 8);
      ctx.lineTo(690, y - 8);
      ctx.stroke();
      ctx.setLineDash([]);
      txt(money(row[1]), 805, y, 27, "700", row[2] ? blue : text, "right");
    });
    hline(204);

    const startY = 205;
    const rowH = 93;
    const navTop = 1572;
    const maxRows = Math.min(ordered.length, Math.floor((navTop - startY) / rowH));

    ordered.slice(0, maxRows).forEach((t, i) => {
      const y = startY + i * rowH;
      const sideColor = t.side === "buy" ? blue : red;
      const profitColor = Number(t.profit) >= 0 ? blue : red;

      // sottile barra laterale colorata come nei riferimenti Android.
      ctx.fillStyle = Number(t.profit) >= 0 ? "#8bc34a" : red;
      ctx.fillRect(0, y + 1, 5, rowH - 2);

      txt("XAUUSD,", 20, y + 39, 25, "700", text);
      font(25, "700");
      const symbolW = ctx.measureText("XAUUSD,").width;
      txt(`${t.side} ${Number(t.lot).toFixed(2)}`, 20 + symbolW + 7, y + 39, 25, "700", sideColor);
      txt(reportDate(t.closeTime), 807, y + 37, 20, "700", muted, "right");
      txt(`${fmtPrice(t.entry)} → ${fmtPrice(t.exit)}`, 20, y + 70, 24, "400", muted);
      txt(money(t.profit), 807, y + 70, 24, "700", profitColor, "right");
      hline(y + rowH);
    });

    // Barra app Android: 5 voci, Storico selezionato.
    ctx.fillStyle = navBg;
    ctx.fillRect(0, navTop, 828, 155);
    hline(navTop);
    const navItems = [
      ["quotes", "Quotazioni"],
      ["candles", "Grafico"],
      ["trade", "Operazioni"],
      ["history", "Storico"],
      ["gear", "Impostazioni"]
    ];
    navItems.forEach((item, i) => {
      const x = 76 + i * 169;
      const selected = i === 3;
      const c = selected ? blue : muted;
      if (selected) rr(x - 53, navTop + 16, 106, 72, 18, isDark ? "#20242b" : "#dce8ff");
      if (item[0] === "quotes") drawQuotesIcon(x, navTop + 48, c);
      if (item[0] === "candles") drawCandles(x, navTop + 48, c);
      if (item[0] === "trade") drawTradeIcon(x, navTop + 48, c);
      if (item[0] === "history") drawHistoryIcon(x, navTop + 48, c);
      if (item[0] === "gear") drawGear(x, navTop + 48, c);
      txt(item[1], x, navTop + 120, 17, "700", c, "center");
    });
    drawAndroidSystemBar();
  }

  // =========================
  // LUCA iOS
  // =========================
  if (isIOS) {
    // Status bar identica geometria al riferimento iOS bianco.
    txt("17:48", 84, 72, 34, "700", text);
    // icona silenzioso semplificata ma nella stessa posizione.
    txt("◕", 196, 71, 27, "700", text);
    drawSignal(598, 69, text);
    drawWifi(671, 65, text);
    drawBattery(707, 48, "75");

    // Pulsante sinistro circolare.
    rr(34, 124, 94, 94, 47, isDark ? "#171719" : "#ffffff", isDark ? "#202023" : "#f6f6f7", 1);
    txt("↕", 81, 187, 38, "700", text, "center");
    txt("≡", 99, 187, 30, "700", text, "center");

    // Segmented control centrale.
    rr(165, 123, 503, 97, 49, isDark ? "#171719" : "#ffffff", isDark ? "#202023" : "#f5f5f6", 1);
    rr(176, 132, 149, 79, 39, pill);
    txt("Posizioni", 250, 183, 29, "500", text, "center");
    txt("Ordini", 414, 183, 29, "400", text, "center");
    txt("Affari", 578, 183, 29, "400", text, "center");

    // Pulsante orologio destro.
    rr(704, 124, 94, 94, 47, isDark ? "#171719" : "#ffffff", isDark ? "#202023" : "#f6f6f7", 1);
    ctx.strokeStyle = text;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(751, 171, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(751, 171); ctx.lineTo(751, 155); ctx.moveTo(751, 171); ctx.lineTo(762, 179); ctx.stroke();

    // Balance + timestamp superiore, presente nel riferimento.
    txt("Balance", 13, 289, 31, "500", text);
    const headerBalance = depositValue || balance;
    txt(money(headerBalance), 817, 289, 34, "700", blue, "right");
    const headerTime = ordered.length ? reportDate(ordered[0].openTime || ordered[0].closeTime) : reportDate(new Date());
    txt(headerTime, 817, 337, 27, "400", muted, "right");

    // Operazioni: nessuna linea orizzontale; aria e proporzioni come screenshot.
    const startY = 369;
    const rowH = 121;
    const summaryReserve = 280;
    const navTop = 1627;
    const summaryBottom = navTop - 38;
    const maxRows = Math.min(ordered.length, Math.floor((summaryBottom - summaryReserve - startY) / rowH));
    const visible = ordered.slice(0, Math.max(1, maxRows));

    visible.forEach((t, i) => {
      const y = startY + i * rowH;
      const sideColor = t.side === "buy" ? blue : red;
      const profitColor = Number(t.profit) >= 0 ? blue : red;

      if (Number(t.profit) < 0) {
        ctx.fillStyle = "#ef6359";
        ctx.fillRect(0, y + 4, 6, rowH - 8);
      }

      txt("XAUUSD", 13, y + 40, 28, "700", text);
      font(28, "700");
      const symbolW = ctx.measureText("XAUUSD").width;
      txt(`${t.side} ${Number(t.lot).toFixed(2)}`, 13 + symbolW + 8, y + 40, 28, "700", sideColor);
      txt(money(t.profit), 817, y + 40, 30, "700", profitColor, "right");
      txt(`${fmtPrice(t.entry)} → ${fmtPrice(t.exit)}`, 13, y + 87, 27, "400", muted);
      txt(reportDate(t.closeTime), 817, y + 87, 26, "400", muted, "right");
    });

    // Riepilogo immediatamente sotto l'ultima operazione, ma mai troppo in basso.
    let summaryY = startY + visible.length * rowH + 22;
    summaryY = Math.min(summaryY, summaryBottom - 215);
    const summaryRows = [
      ["Deposito", depositValue],
      ["Profitto", totalProfit],
      ["Swap", 0],
      ["Commissione", 0],
      ["Bilancio", balance]
    ];
    summaryRows.forEach((row, i) => {
      const y = summaryY + i * 49;
      txt(row[0], 13, y, 29, i === 4 ? "500" : "400", text);
      txt(money(row[1]), 817, y, 29, i === 4 ? "500" : "400", text, "right");
    });

    // Bottom iOS flottante, arrotondata come il riferimento.
    ctx.fillStyle = bg;
    ctx.fillRect(0, navTop - 22, 828, 187);
    rr(44, navTop, 744, 132, 66, isDark ? "#0c0c0d" : "#ffffff", isDark ? "#111113" : "#f4f4f5", 1);
    const items = [
      ["quotes", "Quotazioni"],
      ["candles", "Chart"],
      ["trade", "Trade"],
      ["history", "Storico"],
      ["gear", "Impostazioni"]
    ];
    items.forEach((item, i) => {
      const x = 132 + i * 137;
      const selected = i === 3;
      const c = selected ? blue : text;
      if (selected) rr(x - 62, navTop + 9, 124, 112, 56, pill);
      if (item[0] === "quotes") drawQuotesIcon(x, navTop + 48, c);
      if (item[0] === "candles") drawCandles(x, navTop + 48, c);
      if (item[0] === "trade") drawTradeIcon(x, navTop + 48, c);
      if (item[0] === "history") drawHistoryIcon(x, navTop + 48, c);
      if (item[0] === "gear") drawGear(x, navTop + 48, c);
      txt(item[1], x, navTop + 103, 20, selected ? "500" : "400", c, "center");
    });

    // Home indicator.
    rr(281, 1766, 266, 7, 4, isDark ? "#ffffff" : "#000000");
  }

  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

function renderReportBlob(trades, layout, tab, deposit, credit, withdrawal) {
  if (layout.startsWith("luca_android") || layout.startsWith("luca_ios")) {
    return renderLucaLayoutBlob(trades, layout, deposit, credit, withdrawal);
  }

  const totalProfit = trades.reduce((a, t) => a + Number(t.profit || 0), 0);
  const balance = Number(deposit || 0) + Number(credit || 0) - Number(withdrawal || 0) + totalProfit;

  const isDark = layout.includes("dark");
  const isAndroid = layout.includes("android");
  const isMT5 = layout.includes("mt5");
  const isMT4 = layout.includes("mt4");

  const canvas = document.createElement("canvas");
  canvas.width = 828;
  canvas.height = 1792;
  const ctx = canvas.getContext("2d");

  const bg = isDark ? "#000000" : "#ffffff";
  const text = isDark ? "#f8f8f8" : "#0b0b0b";
  const muted = isDark ? "#c9c9c9" : "#5c5c5c";
  const line = isDark ? "#252525" : "#e7e7e7";
  const blue = "#2997ff";
  const red = "#e22b36";
  const soft = isDark ? "#171717" : "#eeeeee";
  const soft2 = isDark ? "#3b3b3b" : "#ffffff";

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 828, 1792);

  function drawText(str, x, y, size = 24, weight = "400", color = text, align = "left") {
    ctx.font = `${weight} ${size}px Arial`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(str, x, y);
    ctx.textAlign = "left";
  }

  function lineY(y) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(828, y);
    ctx.stroke();
  }

  function drawStatusBar() {
    if (isAndroid) {
      drawText("12:30", 14, 36, 26, "700", isDark ? "#f2f2f2" : "#000");
      drawText("4G+", 610, 36, 20, "700", isDark ? "#f2f2f2" : "#000");
      drawText("41%", 760, 36, 22, "700", isDark ? "#f2f2f2" : "#000");
      return;
    }
    drawText(isMT4 ? "15:43" : "12:31", 102, 70, 32, "700", isDark ? "#fff" : "#111");
    drawText("▮▮▮", 585, 68, 26, "700", isDark ? "#fff" : "#111");
    drawText(isDark ? "⌁" : "5G", 640, 68, 30, "700", isDark ? "#fff" : "#111");
    drawText(isDark ? "▰" : "65", 704, 68, 22, "700", isDark ? "#fff" : "#111");
  }

  function drawTopTabs(y = 120) {
    if (isAndroid && isDark) return;
    const x = isDark ? 34 : (isMT4 ? 130 : 34);
    const w = isDark ? 760 : (isMT4 ? 568 : 760);
    const h = isDark ? 100 : (isMT4 ? 64 : 52);
    const r = isDark ? 50 : (isMT4 ? 11 : 9);

    ctx.fillStyle = soft;
    ctx.strokeStyle = isDark ? "#3c3c3c" : "#d9d9d9";
    roundRect(ctx, x, y, w, h, r, true, true);

    ["Giorno", "Settimana", "Mese", "Personalizzato"].forEach((name, i) => {
      const segX = x + i * w / 4;
      const selectedItalianTab = {
        Day: "Giorno",
        Week: "Settimana",
        Month: "Mese",
        Custom: "Personalizzato"
      }[tab] || tab;
      if (name === selectedItalianTab) {
        ctx.fillStyle = soft2;
        roundRect(ctx, segX + (isDark ? 10 : 6), y + (isDark ? 10 : 5), w / 4 - (isDark ? 20 : 12), h - (isDark ? 20 : 10), isDark ? 42 : 8, true, false);
      }
      if (isMT4 && !isDark && i > 0) {
        ctx.strokeStyle = "#d0d0d0";
        ctx.beginPath();
        ctx.moveTo(segX, y + 9);
        ctx.lineTo(segX, y + h - 9);
        ctx.stroke();
      }
      drawText(name, segX + w / 8, y + h / 2 + 11, isMT5 ? 26 : 25, "700", isDark ? "#fff" : "#111", "center");
    });
  }

  function drawAndroidHeader() {
    if (!(isAndroid && isDark)) return;
    drawText("☰", 28, 76, 30, "400", "#d8d8d8");
    drawText("Storico", 60, 63, 28, "400", "#e5e5e5");
    drawText("Tutti i simboli", 60, 100, 20, "400", "#b8b8b8");
    drawText("$", 730, 83, 22, "700", "#d8d8d8");
    drawText("↕", 770, 83, 22, "700", "#d8d8d8");
    drawText("▦", 805, 83, 22, "700", "#d8d8d8", "right");
    lineY(118);
  }

  function drawAndroidSummary() {
    if (!(isAndroid && isDark)) return 260;
    const y0 = 150;
    [["Profitto:", totalProfit], ["Deposito:", Number(deposit || 0)], ["Saldo:", balance]].forEach((r, i) => {
      const y = y0 + i * 36;
      drawText(r[0], 28, y, 30, "700", "#d0d0d0");
      ctx.strokeStyle = "#3b3b3b";
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(160, y - 8);
      ctx.lineTo(700, y - 8);
      ctx.stroke();
      ctx.setLineDash([]);
      drawText(money(r[1]), 805, y, 30, "700", i === 0 ? blue : "#d0d0d0", "right");
    });
    lineY(258);
    return 300;
  }

  function drawRows(startY) {
    const availableBottom = isAndroid && isDark ? 1460 : 1620;
    const totalRows = trades.length;
    const baseRowH = isAndroid && isDark ? 116 : (isMT4 ? 132 : 88);
    const minRowH = isAndroid && isDark ? 82 : (isMT4 ? 92 : 70);
    const fitRowH = totalRows > 0
      ? Math.floor((availableBottom - startY) / totalRows)
      : baseRowH;

    const rowH = Math.max(minRowH, Math.min(baseRowH, fitRowH));
    const maxRows = Math.max(1, Math.floor((availableBottom - startY) / rowH));
    const rows = trades.slice(0, maxRows);

    rows.forEach((t, i) => {
      const y = startY + i * rowH;
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, 828, rowH);
      lineY(y + rowH);

      const sym = "XAUUSD";
      const sideColor = t.side === "buy" ? blue : red;
      const profitColor = Number(t.profit) >= 0 ? blue : red;
      const scale = Math.min(1, rowH / baseRowH);

      if (isAndroid && isDark) {
        const titleY = y + Math.max(29, 38 * scale);
        const priceY = y + Math.max(62, 86 * scale);
        drawText(`${sym}, `, 14, titleY, Math.max(22, 28 * scale), "700", "#d7d7d7");
        const sw = ctx.measureText(`${sym}, `).width;
        drawText(`${t.side} ${Number(t.lot).toFixed(2)}`, 14 + sw, titleY, Math.max(22, 28 * scale), "700", sideColor);
        drawText(`${price(t.entry)} → ${price(t.exit)}`, 14, priceY, Math.max(23, 30 * scale), "400", "#d7d7d7");
        drawText(reportDate(t.closeTime), 810, titleY, Math.max(20, 27 * scale), "700", "#d0d0d0", "right");
        drawText(money(t.profit), 810, priceY, Math.max(23, 30 * scale), "700", profitColor, "right");
        return;
      }

      const titleY = y + Math.max(28, (isMT4 ? 48 : 34) * scale);
      const priceY = y + Math.max(58, (isMT4 ? 100 : 67) * scale);
      const titleSize = Math.max(23, (isMT4 ? 31 : 30) * scale);
      const priceSize = Math.max(24, (isMT4 ? 33 : 30) * scale);
      const dateSize = Math.max(19, (isMT4 ? 26 : 22) * scale);
      const profitSize = Math.max(24, (isMT4 ? 32 : 28) * scale);

      drawText(`${sym}, `, 20, titleY, titleSize, "900", text);
      const sw = ctx.measureText(`${sym}, `).width;
      drawText(`${t.side} ${Number(t.lot).toFixed(2)}`, 20 + sw, titleY, titleSize, "900", sideColor);
      drawText(`${price(t.entry)} → ${price(t.exit)}`, 20, priceY, priceSize, "400", muted);
      drawText(reportDate(t.closeTime), 810, titleY, dateSize, "700", muted, "right");
      drawText(money(t.profit), 810, priceY, profitSize, "900", profitColor, "right");
    });

    return {
      endY: startY + rows.length * rowH,
      shownRows: rows.length,
      totalRows
    };
  }

  function drawSummary(rowsInfo) {
    if (isAndroid && isDark) return false;

    const { endY, shownRows, totalRows } = rowsInfo;
    const summaryHeight = 250;
    const summaryBottomLimit = 1620;

    if (shownRows < totalRows || endY + summaryHeight > summaryBottomLimit) {
      return false;
    }

    const minY = isMT5 ? 1390 : 1030;
    const sy = Math.max(endY + 16, minY);
    lineY(sy - 20);

    [["Profitto:", totalProfit], ["Credito:", Number(credit || 0)], ["Deposito:", Number(deposit || 0)], ["Prelievo:", Number(withdrawal || 0)], ["Saldo:", balance]].forEach((r, i) => {
      const yy = sy + 38 + i * 42;
      drawText(r[0], 20, yy, 32, "900", muted);
      drawText(money(r[1]), 810, yy, 32, "900", muted, "right");
    });

    return true;
  }

  function drawBottomNav() {
    if (isAndroid && isDark) {
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 1585, 828, 207);
      ctx.fillStyle = "#0b0b0b";
      ctx.fillRect(0, 1470, 828, 115);
      ["↙", "▥", "▣", "▰", "▤", "●"].forEach((it, i) => {
        const x = 80 + i * 135;
        if (i === 3) {
          ctx.fillStyle = "#1b1b1b";
          roundRect(ctx, x - 46, 1500, 92, 60, 30, true, false);
        }
        drawText(it, x, 1540, 34, "700", i === 3 ? blue : "#a5a5a5", "center");
      });
      drawText("Ⅲ", 190, 1728, 36, "400", "#e5e5e5", "center");
      drawText("○", 414, 1728, 42, "400", "#e5e5e5", "center");
      drawText("‹", 650, 1728, 48, "400", "#e5e5e5", "center");
      return;
    }

    const y = 1650;
    lineY(y - 20);

    if (isDark) {
      ctx.fillStyle = "#151515";
      roundRect(ctx, 45, y - 5, 738, 110, 55, true, false);
    } else {
      ctx.fillStyle = "#fbfbfb";
      ctx.fillRect(0, y - 10, 828, 140);
    }

    const items = ["Quotazioni", "Grafico", "Operazioni", "Storico", "Impostazioni"];
    const icons = ["↗", "▥", "↗", "▰", "⚙"];
    items.forEach((item, i) => {
      const x = 70 + i * 172;
      if (item === "Storico") {
        ctx.fillStyle = isDark ? "#3a3a3a" : "#dce6ff";
        roundRect(ctx, x - 58, y + 6, 116, 76, isDark ? 38 : 10, true, false);
      }
      drawText(icons[i], x, y + 42, 34, "900", item === "Storico" ? "#0767e8" : "#9a9a9a", "center");
      drawText(item, x, y + 78, 18, "700", item === "Storico" ? "#0767e8" : "#777", "center");
    });

    if (!isDark) {
      ctx.fillStyle = "#000";
      roundRect(ctx, 275, 1768, 280, 8, 4, true, false);
    }
  }

  drawStatusBar();
  drawAndroidHeader();

  let startY;
  if (isAndroid && isDark) {
    startY = drawAndroidSummary();
  } else {
    drawTopTabs(isDark ? 120 : (isMT4 ? 128 : 120));
    startY = isDark ? 240 : (isMT4 ? 208 : 195);
  }

  const rowsInfo = drawRows(startY);
  drawSummary(rowsInfo);
  drawBottomNav();

  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

export default function LucaTradingAuto() {
  const [candles, setCandles] = useState([]);
  const [trades, setTrades] = useState([]);
  const [autoSets, setAutoSets] = useState([]);
  const [usedCandleKeys, setUsedCandleKeys] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const [layout, setLayout] = useState("ios_mt5_white");
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

  useEffect(() => {
    const refreshUsedCandles = () => {
      setUsedCandleKeys(Array.from(readUsedCandlesToday()));
    };

    refreshUsedCandles();

    // Se la pagina resta aperta oltre la mezzanotte, passa automaticamente
    // al nuovo archivio giornaliero senza richiedere il refresh.
    const timer = window.setInterval(refreshUsedCandles, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const usedCandleSet = useMemo(
    () => new Set(usedCandleKeys),
    [usedCandleKeys]
  );

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
    if (file.name.toLowerCase().endsWith(".numbers")) {
      alert("Il file .numbers non può essere letto direttamente dal browser/Vercel. Aprilo con Numbers e fai: File > Esporta in > CSV. Poi carica qui il CSV esportato. Il formato con time tipo 2026-07-02T19:57:00+02:00 è già supportato.");
      return;
    }
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: res => {
        const rows = res.data.filter(Boolean);
        if (!rows.length) return alert("CSV vuoto.");

        const h = {
          time: findHeader(rows[0], ["time", "datetime", "date", "data", "timestamp", "time utc", "time (utc)", "ora", "data ora"]),
          open: findHeader(rows[0], ["open", "apertura", "o", "otwarcie"]),
          high: findHeader(rows[0], ["high", "massimo", "max", "h", "najwyzszy", "najwyższy"]),
          low: findHeader(rows[0], ["low", "minimo", "min", "l", "najnizszy", "najniższy"]),
          close: findHeader(rows[0], ["close", "chiusura", "c", "zamkniecie", "zamknięcie"]),
          volume: findHeader(rows[0], ["volume", "vol", "tick volume", "volume ", "vol."])
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

  async function generateAuto() {
    if (!candles.length) return alert("Carica prima il CSV.");

    const dayKeys = selectedDayKeys.length
      ? selectedDayKeys
      : dayOptions.map(d => d.key);

    if (!dayKeys.length) return alert("Nessun giorno selezionato.");
    if (isGenerating) return;

    const pools = dayKeys.map(day => ({
      day,
      candles: validTimePool(day).map(c => ({
        id: c.id,
        time: c.time.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
    })).filter(group => group.candles.length >= 5);

    if (!pools.length) {
      return alert("Non ci sono abbastanza candele nel periodo e negli orari selezionati.");
    }

    setIsGenerating(true);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pools,
          usedCandleKeys: Array.from(usedCandleSet),
          scenarios: scenarios(),
          settings: {
            screenCount: Number(screenCount || 1),
            autoPositive: Number(autoPositive || 0),
            autoNegative: Number(autoNegative || 0),
            profitMin: Number(profitMin),
            profitMax: Number(profitMax),
            lotMin: Number(lotMin),
            lotMax: Number(lotMax),
            pointValue: Number(pointValue)
          }
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Errore durante la generazione.");
      }

      const created = (result.sets || []).map(set => ({
        ...set,
        trades: set.trades.map(t => ({
          ...t,
          openTime: new Date(t.openTime),
          closeTime: new Date(t.closeTime)
        }))
      }));

      if (!created.length) {
        alert(result?.message || "Non riesco a generare operazioni con questi vincoli.");
        return;
      }

      const updatedUsed = new Set(result.usedCandleKeys || []);
      saveUsedCandlesToday(updatedUsed);
      setUsedCandleKeys(Array.from(updatedUsed));

      setAutoSets(created);
      setTrades(
        [...created[0].trades].sort(
          (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
        )
      );

      if (result.partial) {
        alert(`Generate ${created.length} schermate su ${Number(screenCount || 1)}. Prova ad allargare i vincoli per ottenere le altre.`);
      }
    } catch (error) {
      console.error(error);
      alert(error?.message || "Il backend non ha completato la generazione.");
    } finally {
      setIsGenerating(false);
    }
  }

  function sortByCloseTime() {
    setTrades(prev => [...prev].sort(
      (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
    ));
  }

  function moveTrade(index, direction) {
    setTrades(prev => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;

      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
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
    }).sort((a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()));
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
      const orderedSet = [...set.trades].sort(
        (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
      );
      const blob = await renderReportBlob(orderedSet, layout, tab, deposit, credit, withdrawal);
      zip.file(`${set.name}.png`, blob);
      orderedSet.forEach(t => {
        rows.push(`${set.name},${t.side},${Number(t.lot).toFixed(2)},${itDate(t.openTime)},${price(t.entry)},${itDate(t.closeTime)},${price(t.exit)},${Number(t.profit).toFixed(2)}`);
      });
    }

    zip.file("operazioni_generate.csv", rows.join("\n"));
    const content = await zip.generateAsync({ type: "blob" });
    downloadBlob(content, "luca_trading_reports.zip");
  }

  function addBlankTrade() {
    const available = selectedCandles.filter(
      c => !usedCandleSet.has(candleSignature(c))
    );

    const base = available[0];
    const next = available[1];

    if (!base || !next) {
      return alert("Non ci sono almeno due candele nuove disponibili per oggi.");
    }

    const side = "buy";
    const lot = 0.050;
    const entry = base.open;
    const exit = next.close;

    const updatedUsed = new Set(usedCandleSet);
    updatedUsed.add(candleSignature(base));
    updatedUsed.add(candleSignature(next));
    saveUsedCandlesToday(updatedUsed);
    setUsedCandleKeys(Array.from(updatedUsed));

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
    }].sort((a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()));
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
          <label>CSV TradingView/OANDA/Numbers<input type="file" accept=".csv,.txt,.tsv,.numbers" onChange={e => e.target.files?.[0] && loadCSV(e.target.files[0])}/></label>
          <label>Layout<select value={layout} onChange={e => setLayout(e.target.value)}><option value="ios_mt5_white">iOS MT5 bianco</option><option value="ios_mt5_dark">iOS MT5 nero</option><option value="ios_mt4_white">iOS MT4 bianco</option><option value="ios_mt4_dark">iOS MT4 nero</option><option value="android_mt4_white">Android MT4 bianco</option><option value="android_mt4_dark">Android MT4 nero</option><option value="luca_android_white">LUCA android bianco</option><option value="luca_android_dark">LUCA android nero</option><option value="luca_ios_white">LUCA IOS bianco</option><option value="luca_ios_dark">LUCA IOS nero</option></select></label>
          <label>Periodo nello screen<select value={tab} onChange={e => setTab(e.target.value)}><option value="Day">Giorno</option><option value="Week">Settimana</option><option value="Month">Mese</option><option value="Custom">Personalizzato</option></select></label>
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
          <button className="primary" disabled={isGenerating} onClick={generateAuto}>{isGenerating ? "Generazione in corso..." : "Genera operazioni"}</button>
          <button onClick={addBlankTrade}>Aggiungi riga manuale</button>
          <button onClick={downloadAutoZip}>Scarica ZIP screen</button>
        </div>

        <div className="stats">
          <div><span>Candele totali</span><b>{candles.length}</b></div>
          <div><span>Candele disponibili oggi</span><b>{selectedCandles.filter(c => !usedCandleSet.has(candleSignature(c))).length}</b></div>
          <div><span>Candele già usate oggi</span><b>{usedCandleKeys.length}</b></div>
          <div><span>Profitto tabella</span><b className={totalProfit >= 0 ? "pos" : "neg"}>{money(totalProfit)}</b></div>
        </div>
      </section>

      <section className="panel">
        <h2>2. Operazioni modificabili</h2>
        <p className="hint">Puoi cambiare tutto: tipo, lotto, date, orari, apertura e chiusura. Il P/L si aggiorna subito.</p>
        <div className="actions">
          <button onClick={sortByCloseTime}>Ordina per data e ora di chiusura</button>
        </div>

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
              <th>Sposta</th>
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
                <td>
                  <div style={{display:"flex", gap:"6px"}}>
                    <button
                      type="button"
                      title="Sposta sopra"
                      disabled={i === 0}
                      onClick={() => moveTrade(i, -1)}
                    >↑</button>
                    <button
                      type="button"
                      title="Sposta sotto"
                      disabled={i === trades.length - 1}
                      onClick={() => moveTrade(i, 1)}
                    >↓</button>
                  </div>
                </td>
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
