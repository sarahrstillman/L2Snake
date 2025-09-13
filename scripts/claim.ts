import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function envOrArg(name: string, fallback?: string) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()]!;
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=")[1];
  return fallback;
}

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");

  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const roundArg = envOrArg("roundId");
  if (!roundArg) throw new Error("Set ROUND_ID env or --roundId");
  const roundId = Number(roundArg);

  const round = await pool.rounds(roundId);
  const poolWei: bigint = round[6]; // poolWei after finalize
  if (poolWei === 0n) throw new Error("Round pool is zero or not finalized");

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  // Single-winner simple proof: if you are the winner, root=leaf and proof=[]
  console.log("Claiming for:", me);
  const tx = await pool.claim(roundId, poolWei, []);
  const rcpt = await tx.wait();
  console.log("claim tx:", rcpt?.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

