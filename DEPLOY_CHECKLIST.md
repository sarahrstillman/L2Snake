# Deployment Prep Checklist

This document summarizes the items to complete before promoting the latest build.

## 1. Environment Variables

### Client (`client/.env.production` or hosting dashboard)
- `VITE_POOL_ADDRESS` – Prize-pool contract address on Base Sepolia/Mainnet.
- `VITE_PUBLIC_RPC` – HTTPS RPC endpoint the dapp should read from.
- `VITE_SERVER_URL` – HTTPS URL of the attestation server (e.g. `https://api.example.com`).

### Server (`server/.env` or hosting secrets)
- `SERVER_PK` – Private key for the attestation signer (0x-prefixed).
- `POOL_ADDRESS` – Same pool address used by the client.
- `BASE_RPC` – HTTPS RPC endpoint with write access for the signer.
- `CLIENT_ORIGIN` – Allowed browser origin, e.g. `https://app.example.com`.
- `HB_MIN_BEATS` / `HB_MIN_MS` / `HB_MAX_MS` – Heartbeat cadence bounds.
- `HB_ALLOW_UNSIG` – Set to `0` in production to enforce heartbeat signatures.
- `REDIS_URL` – Optional; enables Redis-backed session storage.
- `PORT` – Optional port override (default `8787`).

Duplicate this file as `.env` in each environment and fill with real values.

## 2. Contract State
1. Confirm the deployed pool address matches `VITE_POOL_ADDRESS`.
2. Run helper scripts once per new deployment:
   - `npm run set:srv` to register the attestation signer address.
   - `npm run attest:on` to require attested reveals.
3. (Optional) Update continue fee, round parameters, etc., via existing scripts.

## 3. Client Build & Hosting
1. From `client/`: `npm install` (first time), then `npm run build`.
2. Upload the resulting `client/dist/` to your hosting provider, or point the provider at the repo with the same build command.

## 4. Server Deployment
1. From `server/`: `npm install`.
2. Verify locally with `npm run dev` (uses `.env`).
3. Deploy to your platform (Render/Fly/Cloud Run, etc.) using `npm run start` (see package.json) or equivalent command.
4. Verify `/health`, `/session`, `/heartbeat`, `/verify-run` endpoints respond and log a `timeDigest`.

## 5. End-to-End Test
1. Point the client to the deployed server via `VITE_SERVER_URL`.
2. Connect a wallet, press **Enter**, wait for the transaction, press **Start**, intentionally crash the snake, and confirm **Reveal** succeeds on-chain.

## 6. Git & CI
1. `git status` to review changes.
2. Add/commit new files or scripts.
3. Push to the branch watched by your deployment pipeline.

Keep this checklist updated if the process changes.
