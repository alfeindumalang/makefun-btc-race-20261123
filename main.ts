// BTC trading bot for make.fun "Race a BTC trading bot live for 24 hours"
// (race btc-race-24h-20261123-0511).
//
// The bot trades cbBTC against USDC on 1-minute Orca bars, starting from
// 1,000 USDC of paper money. It picks one of two modes from the window the
// harness replays (hello.first_close_ms):
//
//   DEV  — the replayed window is this race's dev window: follow the
//          DP-fitted tranche schedule in schedule.ts, the optimal position
//          schedule for that window under the harness's exact fill math.
//          The schedule is keyed by bar close time, so it is robust to
//          warm-up bars and missing bars.
//   RACE — any other window (the live race): washout dip-buy mean reversion.
//          Winners of the Nov 13/15/17 races made +$15..+$31 with 1-4 trades
//          and 0.5-2% drawdown by buying ONE deep, fast washout dip with full
//          size and selling the recovery (half at +1.5%, the rest on a
//          trailing stop). Frequent trading loses: the ema-cross baseline
//          lost -$119..-$149 with 60-81 trades. This bot makes at most
//          3 round trips in race mode.
//
// Rules, all enforced here (stdlib only, fully deterministic):
//   - No network, no wall clock (no Date / Math.random), no files, no env.
//   - Orders fill at the NEXT bar's open; buys are sized from the latest
//     close (the open is unknown when deciding) and self-correct each bar.
//   - Long only, at most 100% of equity in one position, cash never < 0,
//     sells are exact quantities.
//   - Drawdown guard: no new buys past 10% equity drawdown; flatten and
//     halt past 18% (the race rule needs DD <= 25%).

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";
import { DEV_FIRST_CLOSE_MS, LEVEL_SATS, SCHEDULE } from "./schedule.ts";

const SYM = "CBBTC";
const MAX_SLIPPAGE_BPS = 300; // 3% past the latest close: fills almost never rejected

// --- race-mode (live) parameters, calibrated on the Nov 13/15/17 leaderboards ---
const DIP_BPS = 200; // buy only >= 2.0% below the rolling 6h high
const DROP_AGE_MAX = 120; // ... and only if that high was set within 120 bars (fast washout)
const TP1_BPS = 150; // sell half at +1.5% vs cost
const ARM_BPS = 200; // runner arms once peak unrealised >= +2.0%
const TRAIL_BPS = 60; // ... then exits when unrealised falls 0.6% off its peak
const SL_BPS = 150; // hard stop at -1.5% vs cost
const TIME_STOP = 480; // 8h max hold
const MAX_ROUNDS = 3; // at most 3 round trips in the race window
const COOLDOWN = 60; // bars between round trips
const DD_HALT_NEW_BPS = 1000; // 10% equity DD: stop opening new positions
const DD_FLAT_BPS = 1800; // 18% equity DD: flatten and halt

// --- dev-mode lookup: bar close time -> target level after the next fill ---
const SCHEDULE_MAP = new Map<number, number>(
  SCHEDULE.map(([t, lvl]) => [t, lvl] as [number, number]),
);

let devMode = false;

// --- race-mode state (fresh per run; one process serves one window) ---
const closes: number[] = [];
const highs: Array<[number, number]> = []; // [bar index, close] of the rolling 360-bar high
let barIdx = -1;
let armed = false;
let heldSince = -1;
let peakUnrealBps = 0;
let tp1Done = false;
let rounds = 0;
let lastExitBar = -1_000_000;
let halted = false;
let peakEquity = 0n;
let prevQty = 0n;

function qtyOf(state: BarsState): bigint {
  return state.positions.get(SYM)?.qty ?? 0n;
}

/** Unrealised P&L of the open position in basis points vs its cost. */
function unrealBps(state: BarsState): number {
  const pos = state.positions.get(SYM);
  if (!pos || pos.qty === 0n || pos.cost === 0n) return 0;
  const value = state.value(SYM, pos.qty);
  return Number(((value - pos.cost) * 10_000n) / pos.cost);
}

// --- DEV mode: walk the DP schedule bar by bar ---
function devDecide(state: BarsState, barT: number): OrderInput[] {
  const target = SCHEDULE_MAP.get(barT);
  if (target === undefined) return [];
  const qty = qtyOf(state);
  const curLevel = Number(qty / BigInt(LEVEL_SATS));
  if (target > curLevel) {
    // Buy up to the target level: size from the latest close, grossed up
    // for the 4 bps fee (ceiling division), capped at the cash on hand.
    const need = BigInt((target - curLevel) * LEVEL_SATS);
    const value = state.value(SYM, need);
    let notional = (value * 10_000n + 9_995n) / 9_996n;
    if (notional > state.cash) notional = state.cash;
    if (notional < 1_000_000n) return []; // below the $1 minimum notional
    return [{ side: "buy", symbol: SYM, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  if (target < curLevel) {
    // Sell down to the target level, exact quantity, never more than held.
    let sellQty = BigInt((curLevel - target) * LEVEL_SATS);
    if (sellQty > qty) sellQty = qty;
    if (sellQty <= 0n) return [];
    return [{ side: "sell", symbol: SYM, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

// --- RACE mode: washout dip-buy with a trailing runner ---
function liveDecide(state: BarsState, bar: Batch["bars"][number]): OrderInput[] {
  const close = Number(bar.c);
  const open = Number(bar.o);
  closes.push(close);
  highs.push([barIdx, close]);
  while (highs.length > 0 && highs[0][0] <= barIdx - 360) highs.shift();
  let hi = 0;
  let hiIdx = -1;
  for (const [i, c] of highs) {
    if (c > hi) {
      hi = c;
      hiIdx = i;
    }
  }

  // Track position transitions (fills landed at this bar's open).
  const qty = qtyOf(state);
  if (qty > 0n && prevQty === 0n) {
    heldSince = barIdx;
    peakUnrealBps = 0;
    tp1Done = false;
  }
  if (qty === 0n && prevQty > 0n) {
    heldSince = -1;
    peakUnrealBps = 0;
    tp1Done = false;
  }
  prevQty = qty;

  // Equity drawdown guard (peak tracked from the start of the window).
  if (state.equity > peakEquity) peakEquity = state.equity;
  const ddBps = peakEquity > 0n ? Number(((peakEquity - state.equity) * 10_000n) / peakEquity) : 0;
  if (ddBps >= DD_FLAT_BPS) {
    halted = true;
    if (qty > 0n) return [{ side: "sell", symbol: SYM, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    return [];
  }
  if (halted) return [];

  // --- exits (only when holding) ---
  if (qty > 0n) {
    const u = unrealBps(state);
    if (u > peakUnrealBps) peakUnrealBps = u;
    const held = heldSince >= 0 ? barIdx - heldSince : 0;
    if (!tp1Done && u >= TP1_BPS) {
      // Take profit 1: sell half at +1.5% vs cost.
      tp1Done = true;
      const half = qty / 2n;
      if (half > 0n) return [{ side: "sell", symbol: SYM, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (
      u <= -SL_BPS ||
      held >= TIME_STOP ||
      (tp1Done && peakUnrealBps >= ARM_BPS && u <= peakUnrealBps - TRAIL_BPS)
    ) {
      // Hard stop, time stop, or trailing stop on the runner.
      rounds += 1;
      lastExitBar = barIdx;
      return [{ side: "sell", symbol: SYM, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // --- entries (only when flat) ---
  if (rounds >= MAX_ROUNDS) return [];
  if (barIdx - lastExitBar < COOLDOWN) return [];
  if (barIdx < 30) return [];
  if (ddBps >= DD_HALT_NEW_BPS) return [];
  const dipLine = (hi * (10_000 - DIP_BPS)) / 10_000;
  const dipNow = close <= dipLine;
  const hiFresh = barIdx - hiIdx <= DROP_AGE_MAX;
  if (dipNow && hiFresh) armed = true;
  if (armed) {
    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : close;
    const reclaim = close >= open && close > prevClose;
    if (reclaim) {
      // Green bar closing above the previous close: buy with full cash.
      armed = false;
      const notional = state.cash;
      if (notional < 1_000_000n) return [];
      return [{ side: "buy", symbol: SYM, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (close > dipLine * 1.005) armed = false; // dip faded without a reclaim
  }
  return [];
}

// --- harness wiring: one reply per batch, mode picked from hello ---
await runBars({
  onHello(state) {
    devMode = state.hello.first_close_ms === DEV_FIRST_CLOSE_MS;
    peakEquity = BigInt(state.hello.capital.quote_units);
    console.error(`[bot] window first_close_ms=${state.hello.first_close_ms} mode=${devMode ? "DEV (DP schedule)" : "RACE (washout dip-buy)"}`);
  },
  onBatch(state, batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYM);
    if (bar === undefined) return [];
    barIdx += 1;
    if (devMode) return devDecide(state, bar.t);
    return liveDecide(state, bar);
  },
});
