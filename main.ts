// Pump.fun Bot Sprint entry: burst-momentum scalper.
//
// Trades paper SOL on the pump.fun bonding-curve replay. See strategy.ts
// for the full description of the entry signal, exits and guardrail probes.
//
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types;
// no build step, no dependencies, no network).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
