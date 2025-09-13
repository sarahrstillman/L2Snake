import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");

  const code = await ethers.provider.getCode(addr);
  const isContract = code && code !== "0x";
  console.log("Pool:", addr);
  console.log("Code present:", isContract ? `yes (length ${code.length})` : "no");

  if (!isContract) return;

  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const [owner, entryFee, contFee, epoch, grace] = await Promise.all([
    (pool as any).owner?.() ?? Promise.resolve("(no owner function)"),
    pool.defaultEntryFeeWei(),
    (pool as any).continueFeeWei?.() ?? Promise.resolve(0n),
    pool.epochLength(),
    pool.revealGrace(),
  ]);
  console.log("Owner:", owner);
  console.log("defaultEntryFee (ETH):", ethers.formatEther(entryFee));
  console.log("continueFee (ETH):", typeof contFee === "bigint" ? ethers.formatEther(contFee) : "(n/a)");
  console.log("epochLength (s):", epoch.toString());
  console.log("revealGrace (s):", grace.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

