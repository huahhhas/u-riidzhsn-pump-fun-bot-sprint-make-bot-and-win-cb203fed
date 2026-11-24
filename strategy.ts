// Launch sniper with a rug filter, for the pump.fun bonding-curve replay.
//
// Every coin is watched from its CreateEvent. In its first few slots the
// bot reads the opening tape: how big the creator's own buy was, how many
// other wallets piled in with it (a launch bundled by many wallets in its
// first slot is usually the creator's cluster waiting to dump), whether the
// creator has already sold, and how much real SOL the curve holds. It buys
// only launches that pass, takes profit fast, cuts losers fast, never holds
// past a few slots, and leaves at once when the creator sells.
//
// Why this shape: on the dev window, chasing bursts on mature curves
// (buying after a rise) mostly catches the top before the dump — the
// momentum pilot loses ~9 SOL there. Buying the launch itself, tiny and
// fast, loses only ~0.5 SOL at the pilot's shipped settings, with a 5%
// drawdown instead of 95%. The edge, if any, is in the rug filter and in
// getting out before the dump, not in holding runners.
//
// A pure function of the batches it is fed: no clock, no environment, no
// randomness, no I/O, so the two graded executions produce byte-identical
// action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot (SOL): window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Minimum distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Lamports sold by others / lamports bought, at most (fraction, 1 = no limit). */
  maxSellRatio: number;
  /** Largest single non-creator sell seen, as a share of the real SOL reserve before it, at most (1 = no limit). */
  maxBigSellShare: number;
  /** Price now over the create price: window (fraction, 1 = no limit on the top). */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show (SOL, very negative = no limit). */
  flowWindowSlots: number;
  minFlowSol: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Take profit: sell all once the position is worth this much over its cost. */
  takeProfit: number;
  /** Stop loss: sell all once it is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trailDrop from the best value. */
  trailArm: number;
  trailDrop: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots (huge = off). */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many SOL (huge = off). */
  exitFlowSol: number;
  /** SOL of cash never spent on buys, so an exit can always pay its tx fee. */
  cashReserveSol: number;
}

// Tuned on the dev window with the kit's local sim, preferring flat
// regions of the grid over a single best cell, and scored as the mean over
// several failed-tx draws.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 0,
  stakeSol: 0.03,
  minBuySol: 0.01,
  minRealSol: 1,
  maxRealSol: 30,
  minDevBuySol: 0,
  maxDevBuySol: 1,
  maxBuyers: 2,
  minBuyers: 0,
  maxSellRatio: 1,
  maxBigSellShare: 1,
  minRunup: 0,
  maxRunup: 1.5,
  flowWindowSlots: 10,
  minFlowSol: -1000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10000,
  takeProfit: 0.1,
  stopLoss: 0.15,
  trailArm: 1000,
  trailDrop: 0.1,
  maxHoldSlots: 10,
  exitOnDevSell: true,
  staleSlots: 1000000,
  exitFlowSol: 1000000,
  cashReserveSol: 0.02,
};

const LAMPORTS = 1e9;
/** Protocol (95 bps) + creator (30 bps) curve fee, as a fraction. */
const CURVE_FEE = 0.0125;
const BPS = 10000;

interface RecentTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: Pubkey;
}

interface Launch {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuySol: number;
  trades: number;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldByOthersSol: number;
  bigSellShare: number;
  devSold: boolean;
  lastTradeSlot: number;
  recent: RecentTrade[];
  buysSent: number;
  spentSentSol: number;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface HeldPos {
  openedSlot: number;
  /** Tx fees paid on this position's fills so far (lamports). */
  txPaidLamports: bigint;
  bestValueLamports: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * 125n + 9999n) / 10000n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): import('./vendor/makefun-bot.ts').Bot {
  const coins = new Map<Pubkey, Launch>();
  const held = new Map<Pubkey, HeldPos>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let nowBlockTime = 0;

  /** Net SOL bought minus sold and the distinct buyers, over the last flowWindowSlots slots. */
  const flow = (c: Launch, slot: number): { netSol: number; buyers: number } => {
    const from = slot - p.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { netSol: net, buyers: buyers.size };
  };

  const hasPendingBuy = (state: BotState, mint: Pubkey): boolean => {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') return true;
    return false;
  };
  const hasPendingSell = (state: BotState, mint: Pubkey): boolean => {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') return true;
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            createSlot: e.slot,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuySol: 0,
            trades: 0,
            buyers: new Set(),
            boughtSol: 0,
            soldByOthersSol: 0,
            bigSellShare: 0,
            devSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            buysSent: 0,
            spentSentSol: 0,
            lastBuyVq: 0n,
            lastBuyVt: 1n,
            lastBuySlot: 0,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.boughtSol += sol;
            if (isDev && e.slot === c.createSlot) c.devBuySol += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthersSol += sol;
            const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const share = sol / rqBefore;
              if (share > c.bigSellShare) c.bigSellShare = share;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (e.block_time > nowBlockTime) nowBlockTime = e.block_time;
        }
      }

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txLamports = state.txFeeLamports();
      const txSol = Number(txLamports) / LAMPORTS;
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaidLamports += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaidLamports: BigInt(f.tx_fee_lamports),
            bestValueLamports: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // --- Exits first. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= orderCap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaidLamports: txLamports, bestValueLamports: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = sellValueLamports(pos.token_amount, mk.vq, mk.vt) - txLamports;
        const basis = pos.cost_lamports + h.txPaidLamports;
        if (value > h.bestValueLamports) h.bestValueLamports = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BigInt(BPS) >= basis * BigInt(Math.round((1 + p.takeProfit) * BPS))) exit = true;
          if (value * BigInt(BPS) <= basis * BigInt(Math.round((1 - p.stopLoss) * BPS))) exit = true;
          if (
            h.bestValueLamports * BigInt(BPS) >= basis * BigInt(Math.round((1 + p.trailArm) * BPS)) &&
            value * BigInt(BPS) <= h.bestValueLamports * BigInt(Math.round((1 - p.trailDrop) * BPS))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= p.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (flow(c, state.slot).netSol < -p.exitFlowSol) exit = true;
        }
        if (!exit) continue;
        // A sell needs cash for its tx fee; without it the fill is rejected.
        if (state.cash < txLamports) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Entries. ---
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS - txSol * orders.length;
      let openCount = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= orderCap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (openCount >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug filter.
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        if (c.devBuySol < p.minDevBuySol || c.devBuySol > p.maxDevBuySol) continue;
        if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.boughtSol > 0 && c.soldByOthersSol > c.boughtSol * p.maxSellRatio) continue;
        if (c.bigSellShare > p.maxBigSellShare) continue;
        const runup = Number(curve.virtual_quote_reserves) * Number(c.vt0) / (Number(curve.virtual_token_reserves) * Number(c.vq0));
        if (runup > p.maxRunup || runup < p.minRunup) continue;
        const fl = flow(c, state.slot);
        if (fl.netSol < p.minFlowSol || fl.buyers < p.minRecentBuyers) continue;
        const roomSol = p.stakeSol - c.spentSentSol;
        if (roomSol < p.minBuySol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(c.mint))) / LAMPORTS;
        const amountSol = Math.min(roomSol, capSol);
        if (amountSol < p.minBuySol) continue;
        if (freeSol - amountSol - txSol < p.cashReserveSol) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: BigInt(Math.floor(amountSol * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        freeSol -= amountSol + txSol;
        c.buysSent += 1;
        c.spentSentSol += amountSol;
        openCount += 1;
      }
      return orders;
    },
  };
}
