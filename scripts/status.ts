import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");
  const contract = await ethers.getContractAt("SnakeLeaderboard", addr);
  const entryFee = await contract.entryFeeWei();
  console.log("entryFeeWei:", entryFee.toString());

  const board = await contract.getLeaderboard();
  console.log(`Leaderboard (top ${board.length} runs):`);
  board.forEach((row: any, idx: number) => {
    const ts = Number(row.updatedAt || 0);
    const time = ts ? new Date(ts * 1000).toISOString() : '—';
    console.log(`${idx + 1}. ${row.player} — ${row.score.toString()} pts — session ${row.sessionId} @ ${time}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
