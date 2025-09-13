import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function dayIdFromTimestamp(ts: number): bigint {
  return BigInt(Math.floor(ts / 86400));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const now = Math.floor(Date.now() / 1000);
  const dayId = dayIdFromTimestamp(now);

  const feeSink = process.env.FEE_SINK && process.env.FEE_SINK !== "0x0000000000000000000000000000000000000000"
    ? process.env.FEE_SINK
    : deployer.address;

  // Deploy DailyPrizePool
  const DailyPrizePool = await ethers.getContractFactory("DailyPrizePool");
  const pool = await DailyPrizePool.deploy(feeSink!);
  await pool.waitForDeployment();
  console.log("DailyPrizePool:", await pool.getAddress());

  // Configure rolling schedule: 5 min rounds, 60s reveal grace
  await (await pool.setSchedule(300, 60)).wait();
  // Set default entry fee for auto rounds
  await (await pool.setDefaultEntryFeeWei(ethers.parseEther("0.0005"))).wait();

  // Example manual seed (optional): entry closes in 20 minutes, reveal closes in 30 minutes
  const entryFeeWei = ethers.parseEther("0.0005"); // ~ cheap L2 fee example
  const enterClosesAt = BigInt(now + 20 * 60);
  const revealClosesAt = BigInt(now + 30 * 60);
  const tx3 = await pool.seedDay(dayId, entryFeeWei, enterClosesAt, revealClosesAt);
  await tx3.wait();
  console.log("Seeded day:", dayId.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
