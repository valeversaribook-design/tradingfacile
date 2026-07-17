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

function ohlcValues(candle) {
  return [
    { label: "open", value: Number(candle.open) },
    { label: "high", value: Number(candle.high) },
    { label: "low", value: Number(candle.low) },
    { label: "close", value: Number(candle.close) }
  ];
}

function nearestOHLC(candle, target) {
  const values = ohlcValues(candle);
  if (target === null || Number.isNaN(target)) return choose(values);

  return values.reduce((best, item) =>
    Math.abs(item.value - target) < Math.abs(best.value - target)
      ? item
      : best
  , values[0]);
}

function pickCandleNear(pool, target, startIndex, endIndex) {
  const from = Math.max(0, startIndex);
  const to = Math.min(pool.length - 1, endIndex);
  let best = null;

  for (let index = from; index <= to; index += 1) {
    const candle = pool[index];
    const nearest = nearestOHLC(candle, target);
    const distance = target === null || Number.isNaN(target)
      ? Math.random()
      : Math.abs(nearest.value - target);

    if (!best || distance < best.distance) {
      best = {
        index,
        candle,
        value: nearest.value,
        source: nearest.label,
        distance
      };
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

    if (openTarget !== null) {
      openPick = pickCandleNear(available, openTarget, 0, available.length - 2);
    } else {
      const index = randInt(0, available.length - 2);
      const candle = available[index];
      const selected = choose(ohlcValues(candle));
      openPick = {
        index,
        candle,
        value: selected.value,
        source: selected.label
      };
    }

    if (!openPick) continue;

    if (closeTarget !== null) {
      closePick = pickCandleNear(
        available,
        closeTarget,
        openPick.index + 1,
        available.length - 1
      );
    } else {
      const index = randInt(openPick.index + 1, available.length - 1);
      const candle = available[index];
      const selected = choose(ohlcValues(candle));
      closePick = {
        index,
        candle,
        value: selected.value,
        source: selected.label
      };
    }

    if (!closePick) continue;

    const entry = Number(openPick.value);
    const exit = Number(closePick.value);

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
