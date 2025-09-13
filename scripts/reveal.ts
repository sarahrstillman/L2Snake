import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

function getParam(name: string, fallback?: string) {
  // Prefer env var to avoid Hardhat CLI arg parsing
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()]!;
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=")[1];
  return fallback;
}

async function main() {
  const poolAddr = process.env.POOL_ADDRESS;
  if (!poolAddr) throw new Error("Missing POOL_ADDRESS in .env");

  const pool = await ethers.getContractAt("DailyPrizePool", poolAddr);
  const [signer] = await ethers.getSigners();
  const scoreArg = getParam("score");
  if (!scoreArg) throw new Error("Pass --score=NUMBER (uint64)");
  const score = BigInt(scoreArg);

  // Determine roundId: prefer --roundId, otherwise from saved file list
  const roundArg = getParam("roundId");
  const addr = (await signer.getAddress()).toLowerCase();
  const dir = path.join(process.cwd(), ".runs");
  if (!fs.existsSync(dir)) throw new Error("No .runs directory found. Run npm run enter first.");

  let roundId: number;
  let nonceHex: string;
  if (roundArg) {
    roundId = Number(roundArg);
    const file = path.join(dir, `round-${roundId}-${addr}.json`);
    if (!fs.existsSync(file)) throw new Error(`Saved nonce not found for round ${roundId}.`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    nonceHex = data.nonce;
  } else {
    // pick the newest saved file for this address
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(`${addr}.json`) && f.startsWith("round-"))
      .sort();
    if (files.length === 0) throw new Error("No saved nonces. Run npm run enter first.");
    const latest = files[files.length - 1];
    const data = JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8"));
    roundId = Number(data.roundId);
    nonceHex = data.nonce;
  }

  const runHashArg = getParam("runHash");
  const runHash = runHashArg ?? ethers.hexlify(ethers.randomBytes(32));

  console.log("Revealing round:", roundId);
  console.log("Score:", score.toString());
  const tx = await pool.reveal(roundId, score, runHash as any, nonceHex as any);
  const rcpt = await tx.wait();
  console.log("reveal tx:", rcpt?.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
