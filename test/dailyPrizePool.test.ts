import { expect } from "chai";
import { ethers } from "hardhat";

function dayIdFromTimestamp(ts: number): bigint {
  return BigInt(Math.floor(ts / 86400));
}

describe("DailyPrizePool", () => {
  it("end-to-end: enter, reveal, finalize, claim (single winner)", async () => {
    const [owner, player] = await ethers.getSigners();

    // Deploy Pool
    const DailyPrizePool = await ethers.getContractFactory("DailyPrizePool");
    const pool = await DailyPrizePool.deploy(owner.address);
    await pool.waitForDeployment();

    // Seed today
    const latest = await ethers.provider.getBlock("latest");
    const now = Number(latest!.timestamp);
    const dayId = dayIdFromTimestamp(now);
    const entryFee = ethers.parseEther("1");
    const enterClosesAt = BigInt(now + 100);
    const revealClosesAt = BigInt(now + 200);
    await (await pool.seedDay(dayId, entryFee, enterClosesAt, revealClosesAt)).wait();

    // Player enter with shell commit (nonce only)
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const commit = ethers.keccak256(
      abi.encode(["bytes32", "address", "uint256"], [nonce, player.address, dayId])
    );
    await expect(pool.connect(player).enterDaily(dayId, commit, { value: entryFee }))
      .to.emit(pool, "Entered");

    // Reveal with arbitrary score/runHash that matches shell commit path
    const score = 123n;
    const runHash = ethers.hexlify(ethers.randomBytes(32));
    await expect(pool.connect(player).reveal(dayId, score, runHash as any, nonce as any))
      .to.emit(pool, "Revealed");

    // Finalize with player as only winner, amount = pool - rake
    const rakeBps = await pool.rakeBps();
    const pot = entryFee;
    const rake = (pot * BigInt(rakeBps)) / 10000n;
    const poolNet = pot - rake;

    // Merkle: single leaf = keccak(player, amount); proof = [] ; root = leaf
    const leaf = ethers.keccak256(
      ethers.solidityPacked(["address", "uint256"], [player.address, poolNet])
    );

    // Move time forward past revealClosesAt
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(revealClosesAt) + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(pool.finalizeDay(dayId, leaf)).to.emit(pool, "Finalized");

    const balBefore = await ethers.provider.getBalance(player);
    await expect(pool.connect(player).claim(dayId, poolNet, []))
      .to.emit(pool, "Claimed");
    const balAfter = await ethers.provider.getBalance(player);
    expect(balAfter > balBefore).to.equal(true);
  });

  it("limits continues to three per player per round", async () => {
    const [owner, player] = await ethers.getSigners();

    const DailyPrizePool = await ethers.getContractFactory("DailyPrizePool");
    const pool = await DailyPrizePool.deploy(owner.address);
    await pool.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    const now = Number(latest!.timestamp);
    const dayId = dayIdFromTimestamp(now);
    const entryFee = ethers.parseEther("1");
    const continueFee = ethers.parseEther("0.1");
    const enterClosesAt = BigInt(now + 100);
    const revealClosesAt = BigInt(now + 200);

    await (await pool.seedDay(dayId, entryFee, enterClosesAt, revealClosesAt)).wait();
    await (await pool.setContinueFeeWei(continueFee)).wait();

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const commit = ethers.keccak256(
      abi.encode(["bytes32", "address", "uint256"], [nonce, player.address, dayId])
    );
    await pool.connect(player).enterDaily(dayId, commit, { value: entryFee });

    for (let i = 0; i < 3; i++) {
      await expect(
        pool.connect(player).payContinue(dayId, { value: continueFee })
      ).to.emit(pool, "ContinuePaid");
    }

    await expect(
      pool.connect(player).payContinue(dayId, { value: continueFee })
    ).to.be.revertedWithCustomError(pool, "ContinueLimitReached");

    const used = await pool.continues(dayId, player.address);
    expect(used).to.equal(3);
  });
});
