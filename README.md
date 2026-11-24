# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/huahhhas/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/huahhhas/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A launch sniper for pump.fun bonding curves: it watches every coin from its CreateEvent, buys only launches that pass a rug filter in their first few slots, takes profit fast, cuts losers fast, and never holds past a few slots.

## Strategy

- **Entry (in the create slot itself):** real SOL reserve between 1 and 30 SOL, creator's own buy at most 1 SOL, at most 2 distinct non-creator buyers so far (a launch bundled by many wallets is a dump in waiting), creator must not have sold, no large single sell from others, and the price must not have already run more than 1.5x from creation. Stake 0.03 SOL per coin, capped at 1% of the curve's real SOL reserve per reply as the harness requires.
- **Exits:** take profit at +10% over cost, stop loss at −15%, trailing stop once up, exit at once if the creator sells while holding, and a hard 10-slot maximum hold.
- **Cash discipline:** 0.02 SOL of cash is never spent on buys, so an exit can always pay its transaction fee.
- **Determinism:** a pure function of the batches it is fed — no clock, no environment, no randomness — so the two graded executions produce byte-identical action logs.

## Run it

```sh
node main.ts
```

Runs on Node 22 with no dependencies and no build step. The grader runs it as `node /bot/main.ts` against the `agent-fun/replay/v2` harness on stdin/stdout.

## Files

- `main.ts` — entrypoint, hands the strategy to the replay shim.
- `strategy.ts` — the sniper strategy (entry filter, exits, cash discipline).
- `vendor/makefun-bot.ts` — the kit's replay shim, vendored unchanged.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4bs5ey91&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
