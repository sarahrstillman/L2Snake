import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const addr = process.env.POOL_ADDRESS;
  if (!addr) throw new Error("Missing POOL_ADDRESS in .env");

  const entryFeeStr = process.env.ENTRY_FEE || "0.0005"; // ETH
  const epochStr = process.env.EPOCH_LEN || "300"; // seconds
  const graceStr = process.env.REVEAL_GRACE || "60"; // seconds
  const continueStr = process.env.CONTINUE_FEE || "0"; // ETH

  const pool = await ethers.getContractAt("DailyPrizePool", addr);
  const [signer] = await ethers.getSigners();
  console.log("Owner candidate:", await signer.getAddress());

  // Set schedule (won't change if already set to these values)
  const epochDesired = Number(epochStr);
  const graceDesired = Number(graceStr);
  const epochCurrent = Number(await pool.epochLength());
  const graceCurrent = Number(await pool.revealGrace());
  if (epochCurrent !== epochDesired || graceCurrent !== graceDesired) {
    console.log(`Setting schedule epoch=${epochDesired}s, grace=${graceDesired}s...`);
    const tx = await pool.setSchedule(epochDesired, graceDesired);
    await tx.wait();
  } else {
    console.log("Schedule already set.");
  }

  // Set default entry fee for rolling rounds
  const feeCurrent = await pool.defaultEntryFeeWei();
  const feeDesired = ethers.parseEther(entryFeeStr);
  if (feeCurrent !== feeDesired) {
    console.log(`Setting default entry fee to ${entryFeeStr} ETH...`);
    const tx = await pool.setDefaultEntryFeeWei(feeDesired);
    await tx.wait();
  } else {
    console.log("Default entry fee already set.");
  }

  // Set continue fee
  const contCurrent = await (pool as any).continueFeeWei?.();
  const contDesired = ethers.parseEther(continueStr);
  if (contCurrent !== undefined && contCurrent !== contDesired) {
    console.log(`Setting continue fee to ${continueStr} ETH...`);
    const tx = await (pool as any).setContinueFeeWei(contDesired);
    await tx.wait();
  } else if (contCurrent !== undefined) {
    console.log("Continue fee already set.");
  }


  console.log("---");
  console.log("epochLength:", (await pool.epochLength()).toString());
  console.log("revealGrace:", (await pool.revealGrace()).toString());
  console.log("defaultEntryFeeWei:", (await pool.defaultEntryFeeWei()).toString(), `(ETH ${ethers.formatEther(await pool.defaultEntryFeeWei())})`);
  if ((pool as any).continueFeeWei) {
    const cf = await (pool as any).continueFeeWei();
    console.log("continueFeeWei:", cf.toString(), `(ETH ${ethers.formatEther(cf)})`);
  }
  // No continue fee in this rollback state
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
