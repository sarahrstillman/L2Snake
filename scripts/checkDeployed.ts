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

  const contract = await ethers.getContractAt("SnakeLeaderboard", addr);
  const [owner, entryFee, serverSigner, feeSink, board] = await Promise.all([
    (contract as any).owner?.() ?? Promise.resolve("(no owner function)"),
    contract.entryFeeWei(),
    contract.serverSigner(),
    contract.feeSink(),
    contract.getLeaderboard(),
  ]);
  console.log("Owner:", owner);
  console.log("Server signer:", serverSigner);
  console.log("Fee sink:", feeSink);
  console.log("Entry fee (ETH):", ethers.formatEther(entryFee));
  console.log("Leaderboard entries:", board.length);
  board.slice(0, 5).forEach((row: any, idx: number) => {
    console.log(`  ${idx + 1}. ${row.player} — ${row.score.toString()} (session ${row.sessionId})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
