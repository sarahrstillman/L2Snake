import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function toNum(x: bigint | number | string): number {
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string") return Number(x);
  return x;
}

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) {
    console.error("Missing POOL_ADDRESS in .env");
    process.exit(1);
  }

  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const [epochLength, revealGrace, defaultEntryFeeWei, rakeBps, feeSink] = await Promise.all([
    pool.epochLength(),
    pool.revealGrace(),
    pool.defaultEntryFeeWei(),
    pool.rakeBps(),
    pool.feeSink(),
  ]);
  const continueFeeWei = (pool as any).continueFeeWei ? await (pool as any).continueFeeWei() : 0n;
  const owner = await (pool as any).owner?.();
  const signers = await ethers.getSigners();
  const runner = signers.length ? await signers[0].getAddress() : 'N/A';

  const blk = await ethers.provider.getBlock("latest");
  const now = blk?.timestamp ?? Math.floor(Date.now() / 1000);
  const epoch = toNum(epochLength);
  const roundId = Math.floor(Number(now) / epoch);

  const enterClosesAt = BigInt((roundId + 1) * epoch);
  const revealClosesAt = enterClosesAt + revealGrace;

  const round = await pool.rounds(roundId);
  // round = [entryFeeWei, enterClosesAt, revealClosesAt, finalized, merkleRoot, potWei, poolWei, rakeWei]

  console.log("Pool:", addr);
  console.log("Network:", await ethers.provider.getNetwork());
  console.log("Owner:", owner);
  console.log("Runner (env PRIVATE_KEY):", runner);
  console.log("epochLength (s):", epochLength.toString());
  console.log("revealGrace (s):", revealGrace.toString());
  console.log("defaultEntryFee (ETH):", ethers.formatEther(defaultEntryFeeWei));
  if ((pool as any).continueFeeWei) {
    console.log("continueFee (ETH):", ethers.formatEther(continueFeeWei));
  }
  console.log("rakeBps:", rakeBps.toString());
  console.log("feeSink:", feeSink);
  console.log("---");
  console.log("Now (unix):", now);
  console.log("Current roundId:", roundId);
  console.log("Computed enterClosesAt:", enterClosesAt.toString());
  console.log("Computed revealClosesAt:", revealClosesAt.toString());
  console.log("---");
  console.log("On-chain round state:");
  console.log("  entryFeeWei:", round[0].toString(), `(ETH ${ethers.formatEther(round[0])})`);
  console.log("  enterClosesAt:", round[1].toString());
  console.log("  revealClosesAt:", round[2].toString());
  console.log("  finalized:", round[3]);
  console.log("  merkleRoot:", round[4]);
  console.log("  potWei:", round[5].toString(), `(ETH ${ethers.formatEther(round[5])})`);
  console.log("  poolWei:", round[6].toString(), `(ETH ${ethers.formatEther(round[6])})`);
  console.log("  rakeWei:", round[7].toString(), `(ETH ${ethers.formatEther(round[7])})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
