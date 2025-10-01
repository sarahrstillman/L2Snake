import { expect } from "chai";
import { ethers } from "hardhat";

describe("SnakeLeaderboard", () => {
  const entryFee = ethers.parseEther("0.0005");

  async function deploy() {
    const [owner, feeSink, serverSigner, player] = await ethers.getSigners();
    const SnakeLeaderboard = await ethers.getContractFactory("SnakeLeaderboard");
    const contract = await SnakeLeaderboard.deploy(
      feeSink.address,
      serverSigner.address,
      entryFee
    );
    await contract.waitForDeployment();
    return { contract, owner, feeSink, serverSigner, player };
  }

  it("allows start and score submission", async () => {
    const { contract, serverSigner, player } = await deploy();

    const sessionId = ethers.keccak256(ethers.randomBytes(32));

    await expect(
      contract.connect(player).startRun(sessionId, { value: entryFee })
    ).to.emit(contract, "RunStarted");

    const score = 1234n;
    const payload = {
      player: player.address,
      sessionId,
      score,
      runHash: ethers.keccak256(ethers.randomBytes(32)),
      timeDigest: ethers.keccak256(ethers.randomBytes(32)),
    };

    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint64", "bytes32", "bytes32"],
        [payload.player, payload.sessionId, payload.score, payload.runHash, payload.timeDigest]
      )
    );
    const sig = await serverSigner.signMessage(ethers.getBytes(digest));

    await expect(
      contract.connect(player).submitScore(payload, sig)
    ).to.emit(contract, "ScoreSubmitted").withArgs(payload.sessionId, player.address, score, 1);

    const stats = await contract.getPlayer(player.address);
    expect(stats.bestScore).to.equal(score);
    expect(stats.runs).to.equal(1);
    expect(stats.bestRank).to.equal(1);

    const board = await contract.getLeaderboard();
    expect(board.length).to.equal(1);
    expect(board[0].player).to.equal(player.address);
    expect(board[0].score).to.equal(score);
    expect(board[0].sessionId).to.equal(sessionId);
    expect(Number(board[0].updatedAt)).to.be.greaterThan(0);
  });

  it("keeps only the top 25 scores", async () => {
    const { contract, serverSigner } = await deploy();
    const [funder] = await ethers.getSigners();

    const wallets: any[] = [];
    for (let i = 0; i < 30; i++) {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      wallets.push(wallet);
      await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther("0.01") });
    }

    for (let i = 0; i < wallets.length; i++) {
      const p = wallets[i];
      const sessionId = ethers.keccak256(ethers.randomBytes(32));
      await contract.connect(p).startRun(sessionId, { value: entryFee });

      const score = BigInt(1000 + i);
      const payload = {
        player: p.address,
        sessionId,
        score,
        runHash: ethers.keccak256(ethers.randomBytes(32)),
        timeDigest: ethers.keccak256(ethers.randomBytes(32)),
      };
      const digest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "bytes32", "uint64", "bytes32", "bytes32"],
          [payload.player, payload.sessionId, payload.score, payload.runHash, payload.timeDigest]
        )
      );
      const sig = await serverSigner.signMessage(ethers.getBytes(digest));
      await contract.connect(p).submitScore(payload, sig);
    }

    const board = await contract.getLeaderboard();
    expect(board.length).to.equal(25);
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1].score >= board[i].score).to.equal(true);
      if (board[i - 1].score === board[i].score) {
        expect(Number(board[i - 1].updatedAt)).to.be.at.least(Number(board[i].updatedAt));
      }
    }
  });

  it("orders ties by most recent submission", async () => {
    const { contract, serverSigner } = await deploy();
    const signers = await ethers.getSigners();
    const playerA = signers[3];
    const playerB = signers[4];

    const score = 500n;

    const sessionA = ethers.keccak256(ethers.randomBytes(32));
    await contract.connect(playerA).startRun(sessionA, { value: entryFee });
    const payloadA = {
      player: playerA.address,
      sessionId: sessionA,
      score,
      runHash: ethers.keccak256(ethers.randomBytes(32)),
      timeDigest: ethers.keccak256(ethers.randomBytes(32))
    };
    const digestA = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode([
        "address",
        "bytes32",
        "uint64",
        "bytes32",
        "bytes32"
      ], [payloadA.player, payloadA.sessionId, payloadA.score, payloadA.runHash, payloadA.timeDigest])
    );
    const sigA = await serverSigner.signMessage(ethers.getBytes(digestA));
    await contract.connect(playerA).submitScore(payloadA, sigA);

    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);

    const sessionB = ethers.keccak256(ethers.randomBytes(32));
    await contract.connect(playerB).startRun(sessionB, { value: entryFee });
    const payloadB = {
      player: playerB.address,
      sessionId: sessionB,
      score,
      runHash: ethers.keccak256(ethers.randomBytes(32)),
      timeDigest: ethers.keccak256(ethers.randomBytes(32))
    };
    const digestB = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode([
        "address",
        "bytes32",
        "uint64",
        "bytes32",
        "bytes32"
      ], [payloadB.player, payloadB.sessionId, payloadB.score, payloadB.runHash, payloadB.timeDigest])
    );
    const sigB = await serverSigner.signMessage(ethers.getBytes(digestB));
    await contract.connect(playerB).submitScore(payloadB, sigB);

    const board = await contract.getLeaderboard();
    expect(board.length).to.equal(2);
    expect(board[0].score).to.equal(score);
    expect(board[1].score).to.equal(score);
    expect(board[0].player).to.equal(playerB.address);
    expect(Number(board[0].updatedAt)).to.be.greaterThanOrEqual(Number(board[1].updatedAt));
    const statsA = await contract.getPlayer(playerA.address);
    const statsB = await contract.getPlayer(playerB.address);
    expect(statsA.bestRank).to.equal(2);
    expect(statsB.bestRank).to.equal(1);
  });
});
