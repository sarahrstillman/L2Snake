# Token Snake — On-chain Daily Prize Pool (L2-ready)

This repo contains the smart contracts for a rolling 5-minute leaderboard with entry fees (no boosts). It targets an L2 like Base and supports a commit–reveal flow and Merkle-based payouts so winners can claim cheaply.

No ads included. We can add them to the client later.

## What’s Included

- `contracts/DailyPrizePool.sol`: Core contract for entries, reveals, finalization, and claims.
- (No boosts in this MVP.)
- `scripts/deploy.ts`: Example deployment + day seeding script.
- `test/dailyPrizePool.test.ts`: Minimal end-to-end test (enter → reveal → finalize → claim).

## Prereqs

- Node 18+
- You’ll need to install packages (network required):
  - `npm install`

## Configure

Copy `.env.example` to `.env` and fill:

- `PRIVATE_KEY`: Deployer key (use a test key for testnets).
- `BASE_SEPOLIA_RPC`: RPC URL for Base Sepolia (default works).
- `FEE_SINK`: Address to receive rake (defaults to deployer if unset).

## Build & Test (Local Hardhat)

- Compile: `npm run build`
- Test: `npm run test`

## Deploy (Base Sepolia)

1) Fund your deployer on Base Sepolia (faucet).  
2) Deploy:

```
npm run deploy
```

The script:
- Deploys `DailyPrizePool`.
- Configures 5-minute rounds and default entry fee.
- Optionally seeds a short test window.

## Contract Flow

- Rounds can be auto-seeded every 5 minutes (configurable) or manually seeded.
- Round id `dayId` can be computed as `Math.floor(now / epochLength)`; with defaults `epochLength=300` seconds (5 minutes).
- Default reveal grace is 60 seconds after round end.
- Owner can still seed/override a specific round: `seedDay(dayId, entryFeeWei, enterClosesAt, revealClosesAt)`.
- Player enters with fee: `enterDaily(dayId, commit)`.
- Player reveals after playing: `reveal(dayId, score, runHash, nonce)`.
- Owner finalizes with winners: `finalizeDay(dayId, merkleRoot)`.
- Winners claim: `claim(dayId, amount, proof)`.

### Commit Schemes Supported (MVP)

To keep client integration simple, `reveal()` accepts commits made either way:

- Full commit (stronger): `keccak256(score, runHash, nonce, player, dayId)`.
- Shell commit (simpler): `keccak256(nonce, player, dayId)`.

The off-chain scorer should still validate `runHash` and `score` deterministically from the input stream. Full commit is recommended for production.

### Rake & Pool

- `rakeBps` defaults to 1200 (12%).
- On `finalizeDay`, the contract computes rake and transfers it to `feeSink`.
- Winners claim from the remaining pool using Merkle proofs.

## Client Integration (Quick Notes)

- Compute `dayId = Math.floor(Date.now()/1000/epochLength)` (default 300s).
- Choose a 32-byte `nonce` per entry.
- Option A (recommended): Full commit with score/runHash; enter after playing.  
  `commit = keccak256(abi.encode(score, runHash, nonce, address, dayId))`
- Option B (simpler): Shell commit before playing.  
  `commit = keccak256(abi.encode(nonce, address, dayId))`
- After the day closes, fetch your `{amount, proof}` from your backend and call `claim`.

## Boosts

- Not included in this MVP. All players compete equally per round.

## Security Notes (MVP)

- Commit–reveal prevents last-minute score sniping.
- Off-chain verifier must validate physics via deterministic replay; invalid reveals should be excluded from the Merkle winners list.
- Claims are pull-based and protected with reentrancy guards.

## L2 Rollout

- Start on Base Sepolia, dry-run short days (e.g., 30 minutes) to test the full cycle.
- Switch RPC to Base mainnet, set real `entryFeeWei`, and go live.
## 5-Minute Prize Rounds

- Configure rolling schedule via admin:
  - `setSchedule(epochLength=300, revealGrace=60)`
  - `setDefaultEntryFeeWei(fee)` (enables auto rounds if > 0)
- If a round is not explicitly seeded, the contract derives windows:
  - `enterClosesAt = (roundId + 1) * epochLength`
  - `revealClosesAt = enterClosesAt + revealGrace`
- The first entry to a given `roundId` persists these values.
