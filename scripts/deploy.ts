import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const feeSink = process.env.FEE_SINK && process.env.FEE_SINK !== "" ? process.env.FEE_SINK : deployer.address;
  const serverSigner = process.env.SERVER_SIGNER && process.env.SERVER_SIGNER !== "" ? process.env.SERVER_SIGNER : deployer.address;
  const entryFee = process.env.ENTRY_FEE_ETH ? ethers.parseEther(process.env.ENTRY_FEE_ETH) : ethers.parseEther("0.0005");

  const SnakeLeaderboard = await ethers.getContractFactory("SnakeLeaderboard");
  const contract = await SnakeLeaderboard.deploy(feeSink, serverSigner, entryFee);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("SnakeLeaderboard deployed to:", address);
  console.log("entryFeeWei:", entryFee.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
