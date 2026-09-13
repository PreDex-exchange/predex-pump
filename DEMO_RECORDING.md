# Predex ETHOnline demo recording

Target: 3 minutes 15 seconds. Acceptable final duration: 2:00–4:00. Aim for 3:00–3:30 to leave a safe margin. This is a recording plan, not a claim that a finished video has been measured.

Use your own spoken narration and a screen recording at 1080p if available (minimum 720p). Do not speed up playback or use AI/text-to-speech narration. Cut loading waits instead. Official rules: https://ethglobal.com/events/ethonline2026/info/details

## Setup and boundaries

- Website: http://127.0.0.1:3002/ through the existing Mac-to-pc63 tunnel.
- The current web/API preview uses preserved snapshot source `d700bb726eb5-bf63c6c0cdc8`; its indexer is intentionally not running during migration. Do not hide the `Indexer stalled` indicator or describe the snapshot as current live chain state.
- Verified agent source: `9ef58a6ca02b-19a473a9b965` (commit `9ef58a6ca02be1487dd42acc24d91cf49a38b040`) in the isolated build mirror. Full verification passed, including 367 backend tests and 493 frontend tests, plus both normal and Vercel-mode production builds.
- No new order, market, payment, wallet signature, service restart, or indexer/operator startup is needed for this recording. Leave the current demo running.
- World code is public, but AgentBook registration and Sandbox/mobile verification remain pending. Its integration-test evidence stubs external AgentBook/facilitator providers; it is not a live human-verification proof.
- The Activity view has no configured agent-wallet labels, so wallet rows currently use `Human wallet` as a fallback. Do not present that label as World verification or evidence identifying a particular agent's trade.

Open these tabs in order:

1. http://127.0.0.1:3002/
2. http://127.0.0.1:3002/create
3. http://127.0.0.1:3002/market/5 (scroll to Hybrid exchange order book)
4. http://127.0.0.1:3002/activity
5. https://github.com/PreDex-exchange/predex-pump/blob/9ef58a6ca02be1487dd42acc24d91cf49a38b040/backend/src/truth-payment/agentkit.ts#L286

Use the same browser in which your demo wallet is already connected. Do not spend recording time logging in. It is also fine to show the disconnected read-only interface.

Prepare a Terminal window with a large readable font. From the repository:

```sh
bash scripts/cloudlab/demo-recording.sh check
bash scripts/cloudlab/demo-recording.sh trader
bash scripts/cloudlab/demo-recording.sh world-evidence
```

The trader command forces one Graph-required scan, dry-run trading and free signal reads. It has no signing keys and cannot opt into payments. If Graph is stale/unavailable, retain its refusal output: no silent fallback, fabricated orders, or fake successful run.

Rehearsal completed successfully on 2026-09-13 using agent source `9ef58a6ca02b-19a473a9b965`: The Graph returned market 5 at block 61919144; the trader read the Hybrid book, estimated YES at 0.528213 USDC, proposed a 0.508 BID and 0.549 ASK, and logged a stale-order cancellation plan. Every action was dry-run/no broadcast, with no paid signal request. The World evidence command displayed the recorded 7 passing World tests and 13 passing truth-payment tests. The web/API remained HTTP 200 with `indexerStatus=stalled`, as expected for the preserved preview. Output can change on a later run; narrate what is actually shown.

For the creation tab, enter the unsent draft `Will Ethereum trade above $5,000 within the next 24 hours?`, select `1 day`, and leave the seed at `1.00 USDC`. Show the duplicate-check response and live feed-card preview. Do not click the final launch action.

## Recording workflow

| Time | Show | Action |
| --- | --- | --- |
| 0:00–0:20 | Market feed | Introduce Predex and the testnet snapshot. |
| 0:20–0:55 | Create market | Type the question; point to the resolution window, seed, duplicate check and preview. |
| 0:55–1:25 | Hybrid orderbook | Change an unsent price/size; explain signed orders and Arc settlement. |
| 1:25–2:15 | Terminal, then Activity | Run the one-shot trader; explain Graph discovery, dry-run and risk limits. Activity is historical indexed evidence, not a newly executed trade. |
| 2:15–2:50 | World source and test evidence | Show AgentBook lookup and shared-human quota; state the remaining live verification honestly. |
| 2:50–3:15 | Return to feed | Explain the Continuity contribution and close. |

Start the narration as soon as recording begins. If a command needs more than 10 seconds, cut the waiting time or show the authentic rehearsal output and identify it as a recorded dry run. Do not keep talking faster to fit.

On the Mac, press Shift-Command-5, select the browser/terminal recording area, choose the microphone under Options, and make a five-second audio test first. Turn on Do Not Disturb and keep credentials, email inboxes, account recovery material and terminal history out of the capture. Record only when you are ready to speak; setup does not start microphone recording automatically.

## Spoken script

### 0:00–0:20 — introduction

This is Predex, a prediction-market launchpad for people and automated agents. You can turn a question into a market, trade on its outcome, and follow what happens on-chain. Today I’m showing our Arc Testnet preview with a preserved data snapshot.

### 0:20–0:55 — create a market

I start by entering a question, choosing when it resolves, and setting the initial USDC seed. The app checks for similar markets and previews the card before I commit anything. MetaMask is the main wallet option, with optional email access through Privy. For this recording, I’m leaving this as a draft, so no new market is being submitted.

### 0:55–1:25 — trading

Markets start with a bonding curve and can graduate into an orderbook. Here is the Hybrid trading view, with a resting ask and an order-entry form. Orders are signed off-chain, while fills settle on Arc. USDC covers collateral and gas, so users don’t need a separate gas token. I’m only editing the order preview here.

### 1:25–2:15 — agents and The Graph

Agents use the same markets through our TypeScript SDK. Here I’m running the trader in dry-run mode: it can inspect markets and explain its decisions, but it cannot sign a trade. The Graph supplies eligible market IDs and indexed trading history. Our backend supplies the orderbooks, and the trader has spending, inventory, and open-order limits. It refuses new exposure if Graph data is stale or unavailable. Agents also have an optional USDC-paid signal path through Circle Gateway and x402; this recording doesn’t spend funds.

Optional replacement if you want to point at the actual rehearsal values: “The Graph found market five. The trader read its Hybrid book and proposed a bid at 0.508 and an ask at 0.549. These are plans, not submitted orders.” Replace existing agent narration with this; do not add it on top and overrun the time slot.

### 2:15–2:50 — World

World adds optional human backing for agents. This code checks AgentBook and shares three free market-signal requests across wallets backed by the same human, so creating more wallets doesn’t multiply the allowance. After that, the paid path applies. The server flow has automated integration tests with external providers stubbed; live World registration and mobile verification are still pending.

### 2:50–3:15 — close

We’re entering the Continuity track, building on our existing prediction-market app. The event work connects that product to agent discovery, payments, and human-backed access, alongside optional email onboarding. Our goal is one usable market platform where people and agents can participate through the same contracts. That’s Predex.

## Final checks before uploading

Play the exported file once. Confirm audible human narration, readable UI, no secrets, and duration between 2 and 4 minutes. Keep the target at about 3:15; timing depends on your speaking pace and must be checked on the actual file. Do not claim dry-run orders, fixture-backed World tests, or old indexed transactions are new live transactions.
