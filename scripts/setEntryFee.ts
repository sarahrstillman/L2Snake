import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const addr = process.env.POOL_ADDRESS;
  const entry = process.env.ENTRY_FEE_ETH;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");
  if (!entry) throw new Error("Set ENTRY_FEE_ETH in .env");
  const entryWei = ethers.parseEther(entry);
  const contract = await ethers.getContractAt("SnakeLeaderboard", addr);
  const tx = await contract.setEntryFee(entryWei);
  await tx.wait();
  console.log("entryFeeWei:", (await contract.entryFeeWei()).toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
