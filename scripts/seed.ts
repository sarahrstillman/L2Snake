import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function toNum(x: bigint | number): number {
  return Number(x);
}

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");

  const entryFeeStr = process.env.ENTRY_FEE || "0.0005"; // ETH
  const pool = await ethers.getContractAt("DailyPrizePool", addr);

  const blk = await ethers.provider.getBlock("latest");
  const now = blk?.timestamp ?? Math.floor(Date.now() / 1000);
  const epoch = toNum(await pool.epochLength());
  const grace = toNum(await pool.revealGrace());

  const roundId = Math.floor(Number(now) / epoch);
  const enterClosesAt = BigInt((roundId + 1) * epoch);
  const revealClosesAt = enterClosesAt + BigInt(grace);
  const entryFeeWei = ethers.parseEther(entryFeeStr);

  console.log(`Seeding round ${roundId} with fee ${entryFeeStr} ETH...`);
  const tx = await pool.seedDay(roundId, entryFeeWei, enterClosesAt, revealClosesAt);
  await tx.wait();
  console.log("Seeded round:", roundId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

