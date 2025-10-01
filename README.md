# Token Snake — Endless Leaderboard (L2-ready)

This repo now implements an endless, pay-to-play Snake experience on L2:

- Every run costs an entry fee (default 0.0005 ETH).
- There are no continues—each paid run stands on its own.
- Scores are attested by an off-chain verifier and submitted on-chain.
- The contract records every verified run and keeps the global top 25 single-run scores on-chain for bragging rights.

## What’s Included

- `contracts/SnakeLeaderboard.sol` – Core contract for pay-to-play runs, attested score submission, and an on-chain top-25 leaderboard.
- `server/server.js` – Minimal attestation server (session + heartbeat + run verification) updated to the new run-based flow.
- `client/` – Vite + React front-end with the Snake game, run management, and leaderboard UI.
- Hardhat scripts: `deploy.ts`, `setServerSigner.ts`, `setFees.ts`, `status.ts`, `checkDeployed.ts` for day-to-day operations.
- Tests: `test/snakeLeaderboard.test.ts` covers run lifecycle and leaderboard eviction.

## Prerequisites

- Node 18+
- `npm install` in the repo root (Hardhat) and in `client/` / `server/` when running locally.

## Environment

See `DEPLOY_CHECKLIST.md` for all required env variables. In short:

- Root `.env`: deployer key, RPC, optional fee sink, server signer address, desired entry fee.
- `client/.env.production`: `VITE_POOL_ADDRESS`, `VITE_PUBLIC_RPC`, `VITE_SERVER_URL`.
- `server/.env`: signer private key, contract address, RPC, client origin, heartbeat bounds, optional Redis, etc.

## Build & Test

- Compile contracts: `npm run build`
- Run Hardhat tests: `npm run test`
- Build the client: `cd client && npm run build`
- Start the attestation server locally: `cd server && npm run dev`

## Deploying the Contract

1. Fund your deployer on Base Sepolia (or target network).
2. Ensure `.env` has `POOL_ADDRESS` unset (for fresh deploy) plus optional overrides:
   - `FEE_SINK`, `SERVER_SIGNER`, `ENTRY_FEE_ETH`
3. Deploy:
   ```
   npm run deploy
   ```
   The script deploys `SnakeLeaderboard` and reports the address.
4. Record the new address in `.env`, `client/.env*`, `server/.env`.
5. Register the attestation signer:
   ```
   npm run set:srv
   ```
6. Adjust the entry fee any time with:
   ```
   ENTRY_FEE_ETH=0.0005 npm run set:entry
   ```
7. Check status or leaderboard snapshot:
   ```
   npm run status
   npm run check
   ```

## Gameplay Flow

1. Client requests a session from the server (`/session`) to obtain a deterministic seed + sessionId.
2. User clicks **Start**, pays the entry fee on-chain (`startRun(sessionId)`).
3. Snake gameplay streams inputs/heartbeats while the run is active.
4. When the run ends, the client posts the run data to `/verify-run`; the server re-simulates and signs the canonical score payload.
5. The client submits the signed payload via `submitScore`, recording that run on-chain and bubbling it into the top-25 leaderboard if it’s high enough.
6. Leaderboard fetches the latest standings directly from the contract.

## Attestation Server

- Endpoints: `/session`, `/heartbeat`, `/verify-run`.
- Uses deterministic replay + heartbeat cadence checks (tunable via env) to approve scores.
- Returns `timeDigest` and `attestSig` matching the contract’s `ScorePayload`.
- Keep `HB_ALLOW_UNSIG=0` in production to enforce signed heartbeats.

## Front-end Notes

- The UI shows entry pricing, run status, and the top 25 global scores.
- The connected wallet’s cumulative total + leaderboard rank are highlighted separately.
- Session seeds are stored per run to keep local replays deterministic; they are cleared after submission.

## Next Steps / TODOs

- Decide tie-breaking / eviction rules for the leaderboard (currently higher totals displace lower ones; ties keep earlier entries in-place).
- Add pagination or historical leaderboards if desired.
- Integrate analytics or rewards for top scorers in future iterations.

For deployment steps and smoke tests, follow `DEPLOY_CHECKLIST.md`.
