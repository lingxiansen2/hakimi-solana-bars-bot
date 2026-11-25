import {
  BPS,
  runBars,
  type Bar,
  type BarsState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

interface BarPoint {
  o: number;
  h: number;
  l: number;
  c: number;
}

interface PositionMeta {
  entry: number;
  peak: number;
  entrySeq: number;
  mode: 'mr' | 'bull';
}

interface SymbolFeatures {
  c: number;
  r1: number;
  r3: number;
  r6: number;
  r12: number;
  r24: number;
  atr: number;
  rsi14: number;
  ema8: number;
  ema24: number;
  bars: number;
}

const RSI_LEN = 14;
const MR_RSI_ENTRY = 26;
const MR_MAX_R6 = -0.008;
const MR_EXIT_RSI = 60;
const MR_TP_MIN = 0.045;
const MR_TP_ATR = 4.5;
const MR_TRAIL_ARM_MIN = 0.018;
const MR_TRAIL_ARM_ATR = 2.2;
const MR_TRAIL_DROP_MIN = 0.007;
const MR_TRAIL_DROP_ATR = 0.85;
const MR_STOP_LOSS = 0.05;
const MR_SOFT_HOLD = 18;
const MR_HARD_HOLD = 26;

const BULL_MIN_R24 = 0.02;
const BULL_MAX_RSI = 86;
const BULL_TP = 0.08;
const BULL_STOP_LOSS = 0.025;
const BULL_MAX_HOLD = 36;

const BUY_SLIPPAGE_BPS = 280;
const SELL_SLIPPAGE_BPS = 500;
const ATR_COST_MULT = 1.2;

const history = new Map<string, BarPoint[]>();
const posMeta = new Map<string, PositionMeta>();
const cooldownUntil = new Map<string, number>();
const zeroVolSymbols = new Set<string>();

function computeEma(values: readonly number[], span: number): number {
  const k = 2 / (span + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) {
    e += k * (values[i]! - e);
  }
  return e;
}

function computeRsi(closes: readonly number[], span: number): number {
  const n = closes.length;
  const len = Math.min(span, n - 1);
  if (len <= 0) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = n - len; i < n; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gain += diff;
    else loss -= diff;
  }
  const total = gain + loss;
  return total === 0 ? 50 : (100 * gain) / total;
}

function computeFeatures(arr: readonly BarPoint[]): SymbolFeatures | null {
  const n = arr.length;
  if (n < 8) return null;
  const closes = arr.map((b) => b.c);
  const c = closes[n - 1]!;
  const r1 = c / closes[n - 2]! - 1;
  const r3 = n >= 4 ? c / closes[n - 4]! - 1 : r1;
  const r6 = n >= 7 ? c / closes[n - 7]! - 1 : c / closes[0]! - 1;
  const r12 = n >= 13 ? c / closes[n - 13]! - 1 : r6;
  const r24 = n >= 25 ? c / closes[n - 25]! - 1 : r12;

  const atrN = Math.min(14, n - 1);
  let atrSum = 0;
  for (let i = n - atrN; i < n; i++) {
    const cur = arr[i]!;
    const prevC = arr[i - 1]!.c;
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prevC), Math.abs(cur.l - prevC));
    atrSum += tr / prevC;
  }
  const atr = atrSum / atrN;

  const rsi14 = computeRsi(closes, RSI_LEN);
  const ema8 = computeEma(closes.slice(-Math.min(n, 24)), 8);
  const ema24 = computeEma(closes.slice(-Math.min(n, 48)), 24);
  return { c, r1, r3, r6, r12, r24, atr, rsi14, ema8, ema24, bars: n };
}

function shouldExit(
  seq: number,
  f: SymbolFeatures,
  meta: PositionMeta,
  bullRegime: boolean,
): boolean {
  if (f.c > meta.peak) meta.peak = f.c;
  const pnl = f.c / meta.entry - 1;
  const peakGain = meta.peak / meta.entry - 1;
  const drawFromPeak = f.c / meta.peak - 1;
  const age = seq - meta.entrySeq;

  if (meta.mode === 'mr') {
    const effExitRsi = bullRegime ? 70 : MR_EXIT_RSI;
    const trailArm = Math.max(MR_TRAIL_ARM_MIN, MR_TRAIL_ARM_ATR * f.atr);
    const trailDrop = Math.max(MR_TRAIL_DROP_MIN, MR_TRAIL_DROP_ATR * f.atr);
    const tp = bullRegime ? 0.07 : Math.max(MR_TP_MIN, MR_TP_ATR * f.atr);
    const recovering = f.r3 > 0.004 && f.r1 > 0 && age < MR_HARD_HOLD;
    return (
      pnl >= tp ||
      (peakGain >= trailArm && drawFromPeak <= -trailDrop) ||
      (f.rsi14 >= effExitRsi && pnl > 0.006) ||
      pnl <= -MR_STOP_LOSS ||
      (age >= MR_SOFT_HOLD && !recovering)
    );
  }

  const trailArm = Math.max(0.025, 3.0 * f.atr);
  const trailDrop = Math.max(0.012, 1.5 * f.atr);
  return (
    pnl >= BULL_TP ||
    (peakGain >= trailArm && drawFromPeak <= -trailDrop) ||
    (f.c < f.ema24 && f.r1 < 0) ||
    pnl <= -BULL_STOP_LOSS ||
    age >= BULL_MAX_HOLD
  );
}

await runBars({
  onHello(state: BarsState) {
    for (const s of state.hello.symbols) {
      history.set(s.symbol, []);
    }
  },
  onBatch(state: BarsState, batch) {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const px = Number(fill.price);
        const prior = posMeta.get(fill.symbol);
        posMeta.set(fill.symbol, {
          entry: px,
          peak: px,
          entrySeq: batch.seq,
          mode: prior?.mode ?? 'mr',
        });
      } else {
        posMeta.delete(fill.symbol);
        cooldownUntil.set(fill.symbol, batch.seq + 1);
      }
    }

    const fresh = new Set<string>();
    zeroVolSymbols.clear();
    for (const bar of batch.bars as Bar[]) {
      fresh.add(bar.symbol);
      if (bar.v === '0') zeroVolSymbols.add(bar.symbol);
      let arr = history.get(bar.symbol);
      if (arr === undefined) {
        arr = [];
        history.set(bar.symbol, arr);
      }
      arr.push({
        o: Number(bar.o),
        h: Number(bar.h),
        l: Number(bar.l),
        c: Number(bar.c),
      });
    }

    if (state.warmingUp) return [];

    const feats = new Map<string, SymbolFeatures>();
    let universeCount = 0;
    let up12 = 0;
    let up24 = 0;
    let bullCount = 0;

    for (const { symbol } of state.hello.symbols) {
      const arr = history.get(symbol);
      if (arr === undefined) continue;
      const f = computeFeatures(arr);
      if (f === null) continue;
      feats.set(symbol, f);
      universeCount++;
      if (f.r12 > 0.008) up12++;
      if (f.r24 > 0.02) up24++;
      if (f.c > f.ema8 && f.ema8 > f.ema24) bullCount++;
    }

    if (universeCount === 0) return [];

    const breadthReq = Math.ceil(universeCount * 0.7);
    const bullRegime = up24 >= breadthReq && up12 >= breadthReq && bullCount >= breadthReq;

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    for (const [symbol, pos] of state.positions) {
      if (!fresh.has(symbol)) continue;
      const f = feats.get(symbol);
      if (f === undefined) continue;
      let meta = posMeta.get(symbol);
      if (meta === undefined) {
        meta = { entry: f.c, peak: f.c, entrySeq: batch.seq, mode: 'mr' };
        posMeta.set(symbol, meta);
      }
      if (shouldExit(batch.seq, f, meta, bullRegime)) {
        sells.push({
          side: 'sell',
          symbol,
          qty: pos.qty,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    const byWeightCap = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const candidates: { symbol: string; score: number; mode: 'mr' | 'bull'; impactBps: number }[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol) || zeroVolSymbols.has(symbol) || state.positions.has(symbol)) continue;
      if ((cooldownUntil.get(symbol) ?? -1) > batch.seq) continue;
      const f = feats.get(symbol);
      if (f === undefined) continue;

      const rawImpact = state.impactBps(symbol, byWeightCap);
      const impactBps = rawImpact === null ? 20 : Number(rawImpact);
      const roundTripCost = (2 * (fees.fee_bps + fees.slippage_bps + impactBps)) / 10_000;
      const minAtr = ATR_COST_MULT * roundTripCost;

      let mrScore = 0;
      if (f.rsi14 <= MR_RSI_ENTRY && f.r6 <= MR_MAX_R6 && f.atr >= minAtr) {
        mrScore = MR_RSI_ENTRY - f.rsi14 + -f.r6 * 100;
      }

      let bullScore = 0;
      if (
        bullRegime &&
        f.bars >= 24 &&
        f.ema8 > f.ema24 &&
        f.r24 > BULL_MIN_R24 &&
        f.r6 < 4.5 * f.atr &&
        f.rsi14 < BULL_MAX_RSI &&
        f.r1 > -0.005
      ) {
        bullScore = f.r24 * 50 + (BULL_MAX_RSI - f.rsi14) * 0.1;
      }

      if (mrScore > 0 || bullScore > 0) {
        candidates.push({
          symbol,
          score: mrScore > 0 ? 100 + mrScore : bullScore,
          mode: mrScore > 0 ? 'mr' : 'bull',
          impactBps,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const orders: OrderInput[] = sells.slice(0, caps.max_orders_per_bar);
    let openSlots = caps.max_open_positions - state.positions.size;
    let cashLeft = state.cash;
    const minOrder = state.equity / 20n;
    const minFeeNotional = BigInt(fees.min_notional_quote_units);

    for (const cand of candidates) {
      if (openSlots <= 0 || orders.length >= caps.max_orders_per_bar) break;
      const room = state.weightRoom(cand.symbol);
      let notional = room < cashLeft ? room : cashLeft;
      if (notional > byWeightCap) notional = byWeightCap;
      if (notional < minOrder || notional < minFeeNotional) continue;

      posMeta.set(cand.symbol, {
        entry: 0,
        peak: 0,
        entrySeq: batch.seq,
        mode: cand.mode,
      });
      orders.push({
        side: 'buy',
        symbol: cand.symbol,
        notional_quote_units: notional,
        max_slippage_bps: Math.min(1000, BUY_SLIPPAGE_BPS + cand.impactBps),
      } satisfies BuyInput);
      cashLeft -= notional;
      openSlots--;
    }

    return orders;
  },
});
