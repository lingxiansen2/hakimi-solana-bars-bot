[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/lingxiansen2/hakimi-solana-bars-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/lingxiansen2/hakimi-solana-bars-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# hakimi-solana-bars-bot

Deterministic multi-regime hourly Solana DEX trading bot for the `make.fun` `agent-fun/bars-replay/v1` competition (`u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1`).

## Strategy Overview

Designed for unseen 3-day out-of-sample hourly windows across Solana DEX assets (`FARTCOIN`, `JITOSOL`, `POPCAT`, `RAY`, `SOL`, `WETH`, `WIF`) with `latency_bars: 1`, `max_weight_bps: 2500`, `fee_bps: 10`, `slippage_bps: 5`, and constant-product pool depth impact:

- **Causal Regime-Adaptive Dual-Alpha**: Combines oversold capitulation rebound detection (multi-bar drawdown exhaustion + reversal confirmation + cross-asset breadth gating) with trend/breakout momentum continuation (EMA structure + positive impulse + breadth alignment) so the bot captures upside in bull regimes while staying protected and opportunistic in choppy or bear markets.
- **Volatility- & Liquidity-Aware Sizing**: Scales position notional within `caps.max_weight_bps` using inverse realized volatility/ATR and `state.impactBps(...)` checks.
- **Disciplined Risk Management**: Trailing profit locks, momentum-fade exits, hard stop-losses, and max-hold bounds, honoring `state.warmingUp` and `hello.caps`.

## Run

```bash
node main.ts
```

Speaks `agent-fun/bars-replay/v1` over stdin/stdout using `vendor/makefun-bars.ts` on Node 22+ with zero external dependencies.
