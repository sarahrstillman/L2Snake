import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");
  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const tx = await (pool as any).setRequireAttestation(true);
  await tx.wait();
  console.log("requireAttestation:", await (pool as any).requireAttestation?.());
}

main().catch((e) => { console.error(e); process.exit(1); });

