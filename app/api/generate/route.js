import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_SCREEN_ATTEMPTS = 140;
const MAX_TRADE_ATTEMPTS = 240;

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

function bodyInteriorRange(candle) {
  // Regola: il prezzo deve stare SEMPRE dentro il corpo della candela,
  // quindi strettamente tra OPEN e CLOSE. Mai OPEN, CLOSE, HIGH o LOW.
  const a = Number(candle.open);
  const b = Number(candle.close);

  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const low = Math.min(a, b);
  const high = Math.max(a, b);

  // Gli screen mostrano 2 decimali: lavoriamo direttamente a centesimi.
  // +1 / -1 escludono rigorosamente i due estremi open/close.
  const minCent = Math.floor(low * 100) + 1;
  const maxCent = Math.ceil(high * 100) - 1;

  if (minCent > maxCent) return null;

  return {
    minCent,
    maxCent,
    min: minCent / 100,
    max: maxCent / 100
  };
}

function randomInteriorPrice(candle) {
  const range = bodyInteriorRange(candle);
  if (!range) return null;

  const cent = randInt(range.minCent, range.maxCent);
  return {
    value: cent / 100,
    source: "intermedio"
  };
}

function nearestInteriorPrice(candle, target) {
  const range = bodyInteriorRange(candle);
  if (!range) return null;

  const targetCent = Math.round(Number(target) * 100);
  const cent = Math.max(range.minCent, Math.min(range.maxCent, targetCent));

  return {
    value: cent / 100,
    source: "intermedio",
    distance: Math.abs(cent - targetCent)
  };
}

function pickCandleNear(pool, target, startIndex, endIndex) {
  const from = Math.max(0, startIndex);
  const to = Math.min(pool.length - 1, endIndex);
  if (from > to) return null;

  // Se non c'è un target, scegli una candela casuale che abbia
  // almeno un prezzo a 2 decimali strettamente tra open e close.
  if (target === null || Number.isNaN(target)) {
    const candidates = [];

    for (let index = from; index <= to; index += 1) {
      const selected = randomInteriorPrice(pool[index]);
      if (!selected) continue;

      candidates.push({
        index,
        candle: pool[index],
        value: selected.value,
        source: selected.source,
        distance: 0
      });
    }

    if (!candidates.length) return null;
    return choose(candidates);
  }

  // Se l'utente inserisce un prezzo scenario, cerca la candela il cui
  // corpo contiene quel prezzo. Se non esiste, usa il valore INTERNO
  // più vicino possibile, senza mai toccare open/close/high/low.
  let best = null;

  for (let index = from; index <= to; index += 1) {
    const selected = nearestInteriorPrice(pool[index], target);
    if (!selected) continue;

    if (!best || selected.distance < best.distance) {
      best = {
        index,
        candle: pool[index],
        value: selected.value,
        source: selected.source,
        distance: selected.distance
      };

      if (selected.distance === 0) break;
    }
  }

  return best;
}

function pnl(side, entry, exit, lot, pointValue) {
  return side === "buy"
    ? (exit - entry) * lot * pointValue
    : (entry - exit) * lot * pointValue;
}

function withRandomSecond(value) {
  const date = new Date(value);
  date.setSeconds(randInt(0, 59));
  return date.toISOString();
}

function buildTrade({
  wantPositive,
  pool,
  scenario,
  reserved,
  lotMin,
  lotMax,
  pointValue
}) {
  const available = pool.filter(candle => !reserved.has(signature(candle)));
  if (available.length < 2) return null;

  const openTarget = scenario?.open !== null && Number.isFinite(Number(scenario?.open))
    ? Number(scenario.open)
    : null;

  const closeTarget = scenario?.close !== null && Number.isFinite(Number(scenario?.close))
    ? Number(scenario.close)
    : null;

  for (let attempt = 0; attempt < MAX_TRADE_ATTEMPTS; attempt += 1) {
    let openPick;
    let closePick;

    openPick = pickCandleNear(
      available,
      openTarget,
      0,
      available.length - 2
    );

    if (!openPick) continue;

    closePick = pickCandleNear(
      available,
      closeTarget,
      openPick.index + 1,
      available.length - 1
    );

    if (!closePick) continue;

    const entry = Number(Number(openPick.value).toFixed(2));
    const exit = Number(Number(closePick.value).toFixed(2));

    const openRange = bodyInteriorRange(openPick.candle);
    const closeRange = bodyInteriorRange(closePick.candle);

    if (!openRange || !closeRange) continue;
    if (entry < openRange.min || entry > openRange.max) continue;
    if (exit < closeRange.min || exit > closeRange.max) continue;

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

    reserved.add(signature(openPick.candle));
    reserved.add(signature(closePick.candle));

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
        : "Nessuna combinazione trovata. Allarga profitto min/max, lotti o fascia oraria."
    });
  } catch (error) {
    console.error("Backend generation error:", error);
    return NextResponse.json(
      { error: "Errore interno durante la generazione delle operazioni." },
      { status: 500 }
    );
  }
}
