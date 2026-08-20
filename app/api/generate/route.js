import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_SCREEN_ATTEMPTS = 180;
const MAX_TRADE_ATTEMPTS = 320;

// Evita operazioni troppo ravvicinate tra loro.
// Il controllo viene fatto sugli orari di apertura e chiusura delle operazioni generate.
const MIN_OPERATION_GAP_MINUTES = 25;
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

function buildTrade({
  wantPositive,
  pool,
  scenario,
  reserved,
  reservedTimes,
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

    const entry = interiorPrice(openCandle, bounds);
    if (entry === null) continue;

    // La chiusura deve essere successiva e non troppo vicina né alle altre operazioni
    // né all'apertura della stessa operazione.
    const laterCandidates = [];
    for (let i = openIndex + 1; i < available.length; i += 1) {
      const candle = available[i];
      const closeMs = new Date(candle.time).getTime();
      if (!Number.isFinite(closeMs)) continue;
      if (closeMs - openMs < MIN_OPERATION_GAP_MS) continue;
      if (!isTimeFarEnough(closeMs, reservedTimes)) continue;

      const exit = interiorPrice(candle, bounds);
      if (exit === null) continue;

      laterCandidates.push({ candle, closeMs, exit });
    }

    if (!laterCandidates.length) continue;

    const closePick = choose(laterCandidates);
    const exit = closePick.exit;

    let side = scenario?.side && scenario.side !== "auto"
      ? scenario.side
      : null;

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

export async function POST(request) {
  try {
    const body = await request.json();
    const pools = Array.isArray(body?.pools) ? body.pools : [];
    const scenarios = Array.isArray(body?.scenarios) && body.scenarios.length
      ? body.scenarios
      : [{ side: "auto", open: null, close: null }];

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

    const sets = [];

    for (let screenIndex = 0; screenIndex < screenCount; screenIndex += 1) {
      let best = null;

      for (let attempt = 0; attempt < MAX_SCREEN_ATTEMPTS; attempt += 1) {
        const trades = [];
        const attemptUsed = new Set(confirmedUsed);
        const attemptTimes = new Set();
        let scenarioCursor = 0;

        for (const group of pools) {
          const pool = Array.isArray(group.candles)
            ? group.candles
                .filter(c => c?.id && c?.time)
                .sort((a, b) => new Date(a.time) - new Date(b.time))
            : [];

          if (pool.length < 5) continue;

          for (let index = 0; index < autoPositive; index += 1) {
            const scenario = scenarios[scenarioCursor++ % scenarios.length];
            const trade = buildTrade({
              wantPositive: true,
              pool,
              scenario,
              reserved: attemptUsed,
              reservedTimes: attemptTimes,
              lotMin,
              lotMax,
              pointValue
            });
            if (trade) trades.push(trade);
          }

          for (let index = 0; index < autoNegative; index += 1) {
            const scenario = scenarios[scenarioCursor++ % scenarios.length];
            const trade = buildTrade({
              wantPositive: false,
              pool,
              scenario,
              reserved: attemptUsed,
              reservedTimes: attemptTimes,
              lotMin,
              lotMax,
              pointValue
            });
            if (trade) trades.push(trade);
          }
        }

        trades.sort(
          (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
        );

        const total = trades.reduce((sum, trade) => sum + Number(trade.profit || 0), 0);

        if (trades.length && total >= profitMin && total <= profitMax) {
          best = trades;
          for (const key of attemptUsed) confirmedUsed.add(key);
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
      partial: sets.length < screenCount,
      message: sets.length
        ? null
        : `Nessuna combinazione trovata. Gli scenari ora sono intervalli di riferimento e le operazioni devono essere distanti almeno ${MIN_OPERATION_GAP_MINUTES} minuti. Allarga i vincoli se necessario.`
    });
  } catch (error) {
    console.error("Backend generation error:", error);
    return NextResponse.json(
      { error: "Errore interno durante la generazione delle operazioni." },
      { status: 500 }
    );
  }
}
