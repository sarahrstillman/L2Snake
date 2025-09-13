import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function envOrArg(name: string, fallback?: string) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()]!;
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=")[1];
  return fallback;
}

async function pickRoundId(pool: any): Promise<number> {
  const blk = await ethers.provider.getBlock("latest");
  const now = blk?.timestamp ?? Math.floor(Date.now() / 1000);
  const epoch = Number(await pool.epochLength());
  const grace = Number(await pool.revealGrace());
  const current = Math.floor(Number(now) / epoch);
  const enterClose = (current + 1) * epoch;
  const revealClose = enterClose + grace;
  // If still revealing the current round, finalize the PREVIOUS one
  if (Number(now) <= revealClose) return current - 1;
  return current;
}

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");

  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const roundArg = envOrArg("roundId");
  const roundId = roundArg ? Number(roundArg) : await pickRoundId(pool);
  if (roundId < 0) throw new Error("No previous round yet to finalize.");

  // Ensure the round is past reveal close
  const round = await pool.rounds(roundId);
  const revealClosesAt = Number(round[2]);
  const now = Number((await ethers.provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now()/1000));
  if (now <= revealClosesAt) {
    throw new Error(`Reveal still open. revealClosesAt=${revealClosesAt}, now=${now}`);
  }

  // Read all Revealed events and pick the highest score for this round
  const iface = new ethers.Interface([
    "event Revealed(uint256 indexed dayId, address indexed player, uint64 score, bytes32 runHash)"
  ]);
  const topic = iface.getEvent("Revealed").topicHash;
  const logs = await ethers.provider.getLogs({
    address: addr,
    topics: [topic, ethers.zeroPadValue(ethers.toBeHex(roundId), 32)],
    fromBlock: 0,
    toBlock: "latest"
  });
  let winner: string | null = null;
  let topScore = 0n;
  for (const log of logs) {
    const parsed = iface.decodeEventLog("Revealed", log.data, log.topics);
    const player = parsed.player as string;
    const score = parsed.score as bigint;
    if (score > topScore) {
      topScore = score;
      winner = player;
    }
  }

  const rakeBps: bigint = await pool.rakeBps();
  const potWei: bigint = round[5];
  const rakeWei = (potWei * rakeBps) / 10000n;
  const poolWei = potWei - rakeWei;

  let root = ethers.ZeroHash;
  if (winner && poolWei > 0n) {
    const leaf = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [winner, poolWei]));
    root = leaf; // single-winner tree => root = leaf, proof = []
  }

  console.log("Finalizing round:", roundId);
  console.log("Top score:", topScore.toString());
  console.log("Winner:", winner ?? "none");
  console.log("Pool (wei):", poolWei.toString(), `(ETH ${ethers.formatEther(poolWei)})`);

  const tx = await pool.finalizeDay(roundId, root);
  const rcpt = await tx.wait();
  console.log("finalize tx:", rcpt?.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

