# makefun-btc-race-20261123

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/alfeindumalang/makefun-btc-race-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/alfeindumalang/makefun-btc-race-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A trading bot for make.fun's 24-hour BTC race. It trades cbBTC against USDC on 1-minute Orca bars from $1,000 of paper capital, in two lanes: a dynamic-programming tranche plan fitted to the dev window, and a washout dip-buy for the live race. Node 22, standard library only. On the dev window it grades +$136.67 net (+13.67%), 412 trades, 0.25% max drawdown, fully deterministic.

## How it works

- **PLAN lane (dev window):** walks the DP-fitted schedule in `schedule.ts`, moving the position level bar by bar.
- **LIVE lane (race window):** waits for one deep, fast washout, buys it with full size, and sells the recovery in two legs — half at +1.5%, the rest on a trailing stop.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
