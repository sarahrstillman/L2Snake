import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const addr = process.env.POOL_ADDRESS;
  const signerAddr = process.env.SERVER_SIGNER;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");
  if (!signerAddr) throw new Error("Missing SERVER_SIGNER in .env");
  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const tx = await (pool as any).setServerSigner(signerAddr);
  await tx.wait();
  console.log("serverSigner:", await (pool as any).serverSigner?.());
}

main().catch((e) => { console.error(e); process.exit(1); });

