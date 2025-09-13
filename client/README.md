# Token Snake Client (MVP)

Minimal web client for 5-minute prize rounds on Base. Features:
- Wallet connect (MetaMask)
- Show current round, countdowns, entry fee
- Enter round (commit stored in localStorage)
- Canvas Snake game (simple, deterministic input stream)
- Reveal score on game over
- Claim winner (single-winner finalize)

## Setup

1) Install deps:
   - `cd client`
   - `npm install`

2) Configure env:
   - Copy `.env.example` to `.env.local`
   - Set:
     - `VITE_POOL_ADDRESS=0x...` (deployed pool)
     - `VITE_PUBLIC_RPC=https://sepolia.base.org`

3) Run dev:
   - `npm run dev`
   - Open http://localhost:5173

## Flow
- Connect wallet
- Click Enter Round (pays fee; saves nonce)
- Play; on death, score auto-reveals
- After round is finalized by your script/bot, click Claim (single-winner)

Notes
- Round id computed from epochLength and `Date.now()`. Minor clock drift is OK.
- For multi-winner payouts or anti-cheat, you’ll later add a backend.
- Links open Base Sepolia explorer for tx hashes.

