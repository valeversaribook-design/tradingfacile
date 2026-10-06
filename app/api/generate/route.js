import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_SCREEN_ATTEMPTS = 180;
const MAX_TRADE_ATTEMPTS = 520;

// Evita operazioni troppo ravvicinate tra loro.
// Il controllo viene fatto sugli orari di apertura e chiusura delle operazioni generate.
const MIN_OPERATION_GAP_MINUTES = 3;
const MIN_OPERATION_GAP_MS = MIN_OPERATION_GAP_MINUTES * 60 * 1000;

function rand(min, max) {
  return Number(min) + Math.random() * (Number(max) - Number(min));
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function choose(items) {
  return items[randInt(0, items.length - 1)];
}

function signature(candle) {
  return [
    new Date(candle.time).getTime(),
    Number(candle.open).toFixed(5),
    Number(candle.high).toFixed(5),
    Number(candle.low).toFixed(5),
    Number(candle.close).toFixed(5)
  ].join("|");
}

function pnl(side, entry, exit, lot, pointValue) {
  return side === "buy"
    ? (exit - entry) * lot * pointValue
    : (entry - exit) * lot * pointValue;
}

function withRandomSecond(value) {
  const date = new Date(value);
  date.setSeconds(randInt(4, 55));
  return date.toISOString();
}

function scenarioBounds(scenario) {
  const a = Number(scenario?.open);
  const b = Number(scenario?.close);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;

  return {
    min: Math.min(a, b),
    max: Math.max(a, b)
  };
}

// Prende SEMPRE un valore interno al corpo della candela (tra open e close),
// mai open/close esatti e mai high/low. Se c'è uno scenario, il valore deve
// anche restare dentro l'intervallo indicato dallo scenario.
function interiorPrice(candle, bounds = null) {
  const open = Number(candle.open);
  const close = Number(candle.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || open === close) return null;

  let low = Math.min(open, close);
  let high = Math.max(open, close);

  if (bounds) {
    low = Math.max(low, bounds.min);
    high = Math.min(high, bounds.max);
  }

  if (!(high > low)) return null;

  // Margine per non finire mai sugli estremi visibili.
  const span = high - low;
  const margin = Math.max(span * 0.12, 0.01);
  const innerLow = low + margin;
  const innerHigh = high - margin;

  if (!(innerHigh > innerLow)) return null;

  return Number(rand(innerLow, innerHigh).toFixed(2));
}

function isTimeFarEnough(candidateMs, usedTimes) {
  for (const usedMs of usedTimes) {
    if (Math.abs(candidateMs - usedMs) < MIN_OPERATION_GAP_MS) return false;
  }
  return true;
}

function marketValueKey(value) {
  return Number(value).toFixed(2);
}


function signalRulesForTime(rules, timeMs, operationPreference = "auto") {
  return (Array.isArray(rules) ? rules : [])
    .filter(rule => {
      const start = new Date(rule?.start).getTime();
      const end = rule?.end ? new Date(rule.end).getTime() : Infinity;
      if (!Number.isFinite(start) || timeMs < start || timeMs > end) return false;
      const side = String(rule?.side || "").toLowerCase();
      if (operationPreference === "buy" && side !== "buy") return false;
      if (operationPreference === "sell" && side !== "sell") return false;
      return side === "buy" || side === "sell";
    })
    .sort(() => Math.random() - 0.5);
}
function signalExitBounds(r){
 if(!r)return null; const vals=[Number(r.entryMin),Number(r.entryMax),Number(r.sl),...(Array.isArray(r.tps)?r.tps.map(Number):[])].filter(Number.isFinite);
 return vals.length?{min:Math.min(...vals),max:Math.max(...vals)}:null;
}

function buildTrade({
  wantPositive,
  pool,
  scenario,
  signalRules,
  operationPreference = "auto",
  reserved,
  reservedTimes,
  reservedMarketValues,
  lotMin,
  lotMax,
  pointValue
}) {
  const available = pool.filter(candle => !reserved.has(signature(candle)));
  if (available.length < 2) return null;

  const bounds = scenarioBounds(scenario);

  for (let attempt = 0; attempt < MAX_TRADE_ATTEMPTS; attempt += 1) {
    // Scegliamo una candela di apertura casuale, non "la più vicina" al numero
    // dello scenario: lo scenario è solo il recinto entro cui devono stare i prezzi.
    const openIndex = randInt(0, available.length - 2);
    const openCandle = available[openIndex];
    const openMs = new Date(openCandle.time).getTime();

    if (!Number.isFinite(openMs) || !isTimeFarEnough(openMs, reservedTimes)) continue;

    const validSignals = signalRulesForTime(signalRules, openMs, operationPreference);
    const signalCandidates = validSignals.length
      ? validSignals.map(signal => {
          const entry = interiorPrice(openCandle, {
            min: Number(signal.entryMin),
            max: Number(signal.entryMax)
          });
          return entry === null ? null : { signal, entry };
        }).filter(Boolean)
      : [];

    if (validSignals.length && !signalCandidates.length) continue;

    const pickedSignal = signalCandidates.length ? choose(signalCandidates) : null;
    const activeSignal = pickedSignal?.signal || null;
    const entry = pickedSignal ? pickedSignal.entry : interiorPrice(openCandle, bounds);

    if (entry === null) continue;
    if (reservedMarketValues.has(marketValueKey(entry))) continue;

    // La chiusura deve essere successiva e non troppo vicina né alle altre operazioni
    // né all'apertura della stessa operazione.
    const laterCandidates = [];
    for (let i = openIndex + 1; i < available.length; i += 1) {
      const candle = available[i];
      const closeMs = new Date(candle.time).getTime();
      if (!Number.isFinite(closeMs)) continue;
      if (closeMs - openMs < MIN_OPERATION_GAP_MS) continue;
      if (!isTimeFarEnough(closeMs, reservedTimes)) continue;

      const exit = interiorPrice(candle, activeSignal ? signalExitBounds(activeSignal) : bounds);
      if (exit === null) continue;
      if (marketValueKey(exit) === marketValueKey(entry)) continue;
      if (reservedMarketValues.has(marketValueKey(exit))) continue;

      laterCandidates.push({ candle, closeMs, exit });
    }

    if (!laterCandidates.length) continue;

    const closePick = choose(laterCandidates);
    const exit = closePick.exit;

    let side = operationPreference === "buy" || operationPreference === "sell"
      ? operationPreference
      : (activeSignal?.side
          ? String(activeSignal.side).toLowerCase()
          : (scenario?.side && scenario.side !== "auto" ? scenario.side : null));

    if (!side) {
      side = wantPositive
        ? (exit >= entry ? "buy" : "sell")
        : (exit >= entry ? "sell" : "buy");
    }

    const lot = Number(rand(lotMin, lotMax).toFixed(2));
    const profit = Number(pnl(side, entry, exit, lot, pointValue).toFixed(2));

    if (wantPositive && profit <= 0) continue;
    if (!wantPositive && profit >= 0) continue;

    reserved.add(signature(openCandle));
    reserved.add(signature(closePick.candle));
    reservedTimes.add(openMs);
    reservedTimes.add(closePick.closeMs);
    reservedMarketValues.add(marketValueKey(entry));
    reservedMarketValues.add(marketValueKey(exit));

    return {
      side,
      lot,
      openCandleId: openCandle.id,
      closeCandleId: closePick.candle.id,
      openTime: withRandomSecond(openCandle.time),
      closeTime: withRandomSecond(closePick.candle.time),
      entry,
      exit,
      entrySource: "intermedio",
      exitSource: "intermedio",
      profit
    };
  }

  return null;
}


function buildPreviousDayTrade({
  previousGroup,
  latestGroup,
  signalRules,
  operationPreference,
  reserved,
  reservedTimes,
  confirmedMarketValues,
  lotMin,
  lotMax,
  pointValue
}) {
  if (!previousGroup?.day || !latestGroup?.day) return null;
  if (!Array.isArray(previousGroup.candles) || !Array.isArray(latestGroup.candles)) return null;

  const previousDay = String(previousGroup.day);
  const latestDay = String(latestGroup.day);

  const previousValues = new Set(
    Array.from(confirmedMarketValues)
      .filter(key => String(key).startsWith(`${previousDay}|`))
      .map(key => String(key).slice(previousDay.length + 1))
  );
  const latestValues = new Set(
    Array.from(confirmedMarketValues)
      .filter(key => String(key).startsWith(`${latestDay}|`))
      .map(key => String(key).slice(latestDay.length + 1))
  );

  const opens = previousGroup.candles
    .filter(c => c?.id && c?.time)
    .sort((a,b) => new Date(a.time) - new Date(b.time));

  const closes = latestGroup.candles
    .filter(c => c?.id && c?.time)
    .sort((a,b) => new Date(a.time) - new Date(b.time));

  if (!opens.length || !closes.length) return null;

  for (let attempt = 0; attempt < MAX_TRADE_ATTEMPTS; attempt += 1) {
    const openCandle = choose(opens);
    const openMs = new Date(openCandle.time).getTime();
    if (!Number.isFinite(openMs) || !isTimeFarEnough(openMs, reservedTimes)) continue;
    if (reserved.has(signature(openCandle))) continue;

    const rules = signalRulesForTime(signalRules, openMs, operationPreference);
    if (!rules.length) continue;

    const candidates = rules.map(signal => {
      const entry = interiorPrice(openCandle, {
        min: Number(signal.entryMin),
        max: Number(signal.entryMax)
      });
      return entry === null ? null : {signal, entry};
    }).filter(Boolean);

    if (!candidates.length) continue;

    const picked = choose(candidates);
    const activeSignal = picked.signal;
    const entry = picked.entry;
    if (previousValues.has(marketValueKey(entry))) continue;

    // FONDAMENTALE: la chiusura viene cercata ESCLUSIVAMENTE nell'ultimo giorno.
    const exitCandidates = [];
    for (const closeCandle of closes) {
      const closeMs = new Date(closeCandle.time).getTime();
      if (!Number.isFinite(closeMs) || closeMs <= openMs) continue;
      if (!isTimeFarEnough(closeMs, reservedTimes)) continue;
      if (reserved.has(signature(closeCandle))) continue;

      const exit = interiorPrice(closeCandle, signalExitBounds(activeSignal));
      if (exit === null) continue;
      if (marketValueKey(exit) === marketValueKey(entry)) continue;
      if (latestValues.has(marketValueKey(exit))) continue;

      exitCandidates.push({candle: closeCandle, closeMs, exit});
    }
    if (!exitCandidates.length) continue;

    const closePick = choose(exitCandidates);
    const exit = closePick.exit;
    const side = operationPreference === "buy" || operationPreference === "sell"
      ? operationPreference
      : String(activeSignal.side).toLowerCase();

    const lot = Number(rand(lotMin, lotMax).toFixed(2));
    const profit = Number(pnl(side, entry, exit, lot, pointValue).toFixed(2));
    if (profit === 0) continue;

    reserved.add(signature(openCandle));
    reserved.add(signature(closePick.candle));
    reservedTimes.add(openMs);
    reservedTimes.add(closePick.closeMs);
    confirmedMarketValues.add(`${previousDay}|${marketValueKey(entry)}`);
    confirmedMarketValues.add(`${latestDay}|${marketValueKey(exit)}`);

    return {
      side, lot,
      openCandleId: openCandle.id,
      closeCandleId: closePick.candle.id,
      openTime: withRandomSecond(openCandle.time),
      closeTime: withRandomSecond(closePick.candle.time),
      entry, exit,
      entrySource: "intermedio",
      exitSource: "intermedio",
      profit,
      carriedFromPreviousDay: true
    };
  }
  return null;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const pools = Array.isArray(body?.pools) ? body.pools : [];
    const scenarios = Array.isArray(body?.scenarios) && body.scenarios.length
      ? body.scenarios
      : [{ side: "auto", open: null, close: null }];

    const signalRules = Array.isArray(body?.signalRules) ? body.signalRules : [];
    const includePreviousDayTrade = Boolean(body?.includePreviousDayTrade);
    const operationPreference = ["buy", "sell"].includes(String(body?.operationPreference).toLowerCase())
      ? String(body.operationPreference).toLowerCase()
      : "auto";
    const previousDayPool = body?.previousDayPool && Array.isArray(body.previousDayPool.candles)
      ? body.previousDayPool
      : null;
    const settings = body?.settings || {};
    const screenCount = Math.max(1, Math.min(50, Number(settings.screenCount || 1)));
    const autoPositive = Math.max(0, Math.min(50, Number(settings.autoPositive || 0)));
    const autoNegative = Math.max(0, Math.min(50, Number(settings.autoNegative || 0)));
    const profitMin = Number(settings.profitMin);
    const profitMax = Number(settings.profitMax);
    const lotMin = Number(settings.lotMin);
    const lotMax = Number(settings.lotMax);
    const pointValue = Number(settings.pointValue);

    if (!pools.length) {
      return NextResponse.json(
        { error: "Nessuna candela valida ricevuta dal frontend." },
        { status: 400 }
      );
    }

    if (![profitMin, profitMax, lotMin, lotMax, pointValue].every(Number.isFinite)) {
      return NextResponse.json(
        { error: "Uno o più parametri numerici non sono validi." },
        { status: 400 }
      );
    }

    const confirmedUsed = new Set(
      Array.isArray(body?.usedCandleKeys) ? body.usedCandleKeys : []
    );

    // Formato chiave: YYYY-MM-DD|PREZZO_A_2_DECIMALI
    const confirmedMarketValues = new Set(
      Array.isArray(body?.usedMarketValueKeys) ? body.usedMarketValueKeys : []
    );

    const sets = [];

    for (let screenIndex = 0; screenIndex < screenCount; screenIndex += 1) {
      let best = null;

      for (let attempt = 0; attempt < MAX_SCREEN_ATTEMPTS; attempt += 1) {
        const trades = [];
        const attemptUsed = new Set(confirmedUsed);
        const attemptTimes = new Set();
        let scenarioCursor = 0;

        const requiredPerDay = autoPositive + autoNegative;
        const validGroups = pools.filter(group => Array.isArray(group?.candles) && group.candles.length);
        let attemptValid = validGroups.length > 0;

        for (const group of validGroups) {
          const pool = group.candles
            .filter(c => c?.id && c?.time)
            .sort((a, b) => new Date(a.time) - new Date(b.time));

          if (pool.length < requiredPerDay * 2) {
            attemptValid = false;
            break;
          }

          const dayTrades = [];
          const dayPrefix = `${group.day}|`;
          const dayMarketValues = new Set(
            Array.from(confirmedMarketValues)
              .filter(key => String(key).startsWith(dayPrefix))
              .map(key => String(key).slice(dayPrefix.length))
          );

          for (let index = 0; index < autoPositive; index += 1) {
            const scenario = scenarios[scenarioCursor++ % scenarios.length];
            const trade = buildTrade({
              wantPositive: true,
              pool,
              scenario,
              signalRules,
              operationPreference,
              reserved: attemptUsed,
              reservedTimes: attemptTimes,
              reservedMarketValues: dayMarketValues,
              lotMin,
              lotMax,
              pointValue
            });

            if (!trade) {
              attemptValid = false;
              break;
            }

            dayTrades.push(trade);
          }

          if (!attemptValid) break;

          for (let index = 0; index < autoNegative; index += 1) {
            const scenario = scenarios[scenarioCursor++ % scenarios.length];
            const trade = buildTrade({
              wantPositive: false,
              pool,
              scenario,
              signalRules,
              operationPreference,
              reserved: attemptUsed,
              reservedTimes: attemptTimes,
              reservedMarketValues: dayMarketValues,
              lotMin,
              lotMax,
              pointValue
            });

            if (!trade) {
              attemptValid = false;
              break;
            }

            dayTrades.push(trade);
          }

          if (!attemptValid) break;

          const dayPositive = dayTrades.filter(t => Number(t.profit) > 0).length;
          const dayNegative = dayTrades.filter(t => Number(t.profit) < 0).length;

          if (
            dayTrades.length !== requiredPerDay ||
            dayPositive !== autoPositive ||
            dayNegative !== autoNegative
          ) {
            attemptValid = false;
            break;
          }

          trades.push(...dayTrades);
        }

        if (!attemptValid) continue;

        const expectedTrades = validGroups.length * requiredPerDay;
        const positiveCount = trades.filter(t => Number(t.profit) > 0).length;
        const negativeCount = trades.filter(t => Number(t.profit) < 0).length;

        if (
          trades.length !== expectedTrades ||
          positiveCount !== validGroups.length * autoPositive ||
          negativeCount !== validGroups.length * autoNegative
        ) {
          continue;
        }

        // Opzionale: aggiunge UNA sola operazione del giorno precedente.
        // Non modifica il conteggio richiesto di positive/negative dell'ultimo giorno.
        if (includePreviousDayTrade) {
          if (!previousDayPool) continue;

          const previousTrade = buildPreviousDayTrade({
            previousGroup: previousDayPool,
            latestGroup: validGroups[0],
            signalRules,
            operationPreference,
            reserved: attemptUsed,
            reservedTimes: attemptTimes,
            confirmedMarketValues,
            lotMin,
            lotMax,
            pointValue
          });

          if (!previousTrade) continue;
          trades.push(previousTrade);
        }

        trades.sort(
          (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
        );

        const normalDayTrades = includePreviousDayTrade
          ? trades.filter(t => !t.carriedFromPreviousDay)
          : trades;
        const totalForGeneration = normalDayTrades.reduce((sum, trade) => sum + Number(trade.profit || 0), 0);

        if (totalForGeneration >= profitMin && totalForGeneration <= profitMax) {
          best = trades;
          for (const key of attemptUsed) confirmedUsed.add(key);

          // Salva complessivamente entrate + uscite per giorno.
          for (const trade of trades) {
            const group = validGroups.find(g =>
              Array.isArray(g?.candles) &&
              g.candles.some(c => c?.id === trade.openCandleId)
            );
            if (!group?.day) continue;
            confirmedMarketValues.add(`${group.day}|${marketValueKey(trade.entry)}`);
            confirmedMarketValues.add(`${group.day}|${marketValueKey(trade.exit)}`);
          }

          break;
        }
      }

      if (best) {
        sets.push({
          name: `screen_${String(screenIndex + 1).padStart(2, "0")}`,
          trades: best
        });
      }
    }

    return NextResponse.json({
      sets,
      usedCandleKeys: Array.from(confirmedUsed),
      usedMarketValueKeys: Array.from(confirmedMarketValues),
      partial: sets.length < screenCount,
      message: sets.length
        ? null
        : `Nessuna combinazione completa trovata. Il generatore accetta solo screen con ESATTAMENTE ${autoPositive} positive e ${autoNegative} negative per giorno, con almeno ${MIN_OPERATION_GAP_MINUTES} minuti di distanza. Se non riesce, non restituisce risultati parziali.`
    });
  } catch (error) {
    console.error("Backend generation error:", error);
    return NextResponse.json(
      { error: "Errore interno durante la generazione delle operazioni." },
      { status: 500 }
    );
  }
}
