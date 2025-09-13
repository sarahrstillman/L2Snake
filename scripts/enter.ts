import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

function getParam(name: string, fallback?: string) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()]!;
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=")[1];
  return fallback;
}

function getRoundId(epochLength: number, now: number): number {
  return Math.floor(now / epochLength);
}

async function main() {
  const poolAddr = process.env.POOL_ADDRESS;
  if (!poolAddr) throw new Error("Missing POOL_ADDRESS in .env");

  const pool = await ethers.getContractAt("DailyPrizePool", poolAddr);
  const [signer] = await ethers.getSigners();

  const blk = await ethers.provider.getBlock("latest");
  const now = blk?.timestamp ?? Math.floor(Date.now() / 1000);
  const epochLength = Number(await pool.epochLength());
  const roundArg = getParam("roundId");
  const roundId = roundArg ? Number(roundArg) : getRoundId(epochLength, Number(now));

  const [enterClose, , entryFeeWei] = await pool.expectedWindows(roundId);
  if (Number(now) >= Number(enterClose)) {
    throw new Error(`Too late to enter this round. enterClose=${enterClose}`);
  }

  // Create a random nonce and commit: keccak256(nonce, player, roundId)
  const nonceBytes = ethers.randomBytes(32);
  const nonceHex = ethers.hexlify(nonceBytes);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const commit = ethers.keccak256(
    abi.encode(["bytes32", "address", "uint256"], [nonceHex, await signer.getAddress(), BigInt(roundId)])
  );

  console.log("Entering round:", roundId);
  console.log("Entry fee (ETH):", ethers.formatEther(entryFeeWei));
  const tx = await pool.enterDaily(roundId, commit, { value: entryFeeWei });
  const rcpt = await tx.wait();
  console.log("enter tx:", rcpt?.hash);

  // Persist the nonce so reveal can use it later
  const dir = path.join(process.cwd(), ".runs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `round-${roundId}-${(await signer.getAddress()).toLowerCase()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ roundId, address: await signer.getAddress(), nonce: nonceHex }, null, 2)
  );
  console.log("Saved nonce to:", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
