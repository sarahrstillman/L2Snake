// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * DailyPrizePool
 * - Players pay entry fee (ETH on L2) to enter a given day.
 * - Commit-reveal: enter with a salted commit; reveal(score, runHash, nonce) later.
 * - After reveal window, owner finalizes with a Merkle root of winners and amounts.
 * - Winners claim their prizes using Merkle proofs. Owner takes rake on finalize.
 */
contract DailyPrizePool is Ownable, ReentrancyGuard {
    // -------- Errors --------
    error InvalidWindow();
    error AlreadySeeded();
    error NotSeeded();
    error TooLate();
    error WrongFee();
    error AlreadyEntered();
    error AlreadyRevealed();
    error BadCommit();
    error NotFinalized();
    error AlreadyClaimed();

    // -------- Events --------
    event DaySeeded(uint256 indexed dayId, uint256 entryFeeWei, uint64 enterClosesAt, uint64 revealClosesAt);
    event Entered(uint256 indexed dayId, address indexed player, bytes32 commit, uint256 fee);
    event Revealed(uint256 indexed dayId, address indexed player, uint64 score, bytes32 runHash);
    event Finalized(uint256 indexed dayId, bytes32 merkleRoot, uint256 poolWei, uint256 rakeWei);
    event Claimed(uint256 indexed dayId, address indexed player, uint256 amount);
    event RakeBpsUpdated(uint16 rakeBps);
    event FeeSinkUpdated(address feeSink);
    event ContinuePaid(uint256 indexed dayId, address indexed player, uint256 fee);

    // -------- Storage --------
    struct DayParams {
        uint256 entryFeeWei;
        uint64 enterClosesAt;
        uint64 revealClosesAt;
        bool finalized;
        bytes32 merkleRoot;
        uint256 potWei; // gross collected for the day
        uint256 poolWei; // net after rake
        uint256 rakeWei; // rake transferred on finalize
    }

    struct Entry {
        bytes32 commit;
        bool revealed;
        uint64 score;
        bytes32 runHash;
    }

    // dayId => params (avoid reserved word 'days')
    mapping(uint256 => DayParams) public rounds;
    // dayId => player => entry
    mapping(uint256 => mapping(address => Entry)) public entries;
    // dayId => player => claimed?
    mapping(uint256 => mapping(address => bool)) public claimed;
    // dayId => player => continues used (counter)
    mapping(uint256 => mapping(address => uint16)) public continues;

    // rake in basis points (1/100 of a percent). 1200 = 12%
    uint16 public rakeBps = 1200;
    address public feeSink;
    uint256 public continueFeeWei; // optional paid continue fee

    // Rolling schedule (auto-seeded rounds)
    // epochLength: round length in seconds (default 5 minutes)
    // revealGrace: extra seconds after entry close for reveals
    // defaultEntryFeeWei: fee used for unseeded rounds
    uint64 public epochLength = 300; // 5 minutes
    uint64 public revealGrace = 60;  // 1 minute to reveal after close
    uint256 public defaultEntryFeeWei = 0; // disabled until set

    constructor(address _feeSink) Ownable(msg.sender) {
        feeSink = _feeSink;
    }

    // -------- Admin --------
    function setRakeBps(uint16 _rakeBps) external onlyOwner {
        require(_rakeBps <= 2000, "rake too high");
        rakeBps = _rakeBps;
        emit RakeBpsUpdated(_rakeBps);
    }

    function setFeeSink(address _feeSink) external onlyOwner {
        feeSink = _feeSink;
        emit FeeSinkUpdated(_feeSink);
    }

    function setSchedule(uint64 _epochLength, uint64 _revealGrace) external onlyOwner {
        require(_epochLength >= 60 && _epochLength <= 86400, "bad epochLength");
        require(_revealGrace <= _epochLength, "reveal too long");
        epochLength = _epochLength;
        revealGrace = _revealGrace;
    }

    function setDefaultEntryFeeWei(uint256 fee) external onlyOwner {
        defaultEntryFeeWei = fee;
    }

    function setContinueFeeWei(uint256 fee) external onlyOwner {
        continueFeeWei = fee;
    }

    // Seed a day with fee and windows
    function seedDay(
        uint256 dayId,
        uint256 entryFeeWei,
        uint64 enterClosesAt,
        uint64 revealClosesAt
    ) external onlyOwner {
        DayParams storage d = rounds[dayId];
        if (d.enterClosesAt != 0) revert AlreadySeeded();
        if (!(enterClosesAt < revealClosesAt)) revert InvalidWindow();
        d.entryFeeWei = entryFeeWei;
        d.enterClosesAt = enterClosesAt;
        d.revealClosesAt = revealClosesAt;
        emit DaySeeded(dayId, entryFeeWei, enterClosesAt, revealClosesAt);
    }

    // Compute default windows for an unseeded round
    function expectedWindows(uint256 dayId) public view returns (uint64 enterClose, uint64 revealClose, uint256 feeWei) {
        DayParams storage d = rounds[dayId];
        if (d.enterClosesAt != 0) {
            return (d.enterClosesAt, d.revealClosesAt, d.entryFeeWei);
        }
        // Derive from schedule if enabled
        require(defaultEntryFeeWei > 0, "not seeded and no default fee");
        enterClose = uint64(((dayId + 1) * uint256(epochLength)));
        revealClose = enterClose + revealGrace;
        feeWei = defaultEntryFeeWei;
    }

    // -------- User actions --------
    function enterDaily(
        uint256 dayId,
        bytes32 commit
    ) external payable nonReentrant {
        DayParams storage d = rounds[dayId];
        (uint64 enterClose,, uint256 feeWei) = expectedWindows(dayId);
        if (block.timestamp >= enterClose) revert TooLate();
        if (msg.value != feeWei) revert WrongFee();

        Entry storage e = entries[dayId][msg.sender];
        if (e.commit != bytes32(0)) revert AlreadyEntered();

        e.commit = commit;
        d.potWei += msg.value;

        // Persist computed schedule on first touch if not seeded
        if (d.enterClosesAt == 0) {
            d.enterClosesAt = enterClose;
            d.revealClosesAt = enterClose + revealGrace;
            if (d.entryFeeWei == 0) d.entryFeeWei = feeWei;
        }

        emit Entered(dayId, msg.sender, commit, msg.value);
    }

    function reveal(
        uint256 dayId,
        uint64 score,
        bytes32 runHash,
        bytes32 nonce
    ) external {
        DayParams storage d = rounds[dayId];
        if (d.enterClosesAt == 0) {
            // Not seeded nor touched yet -> no entry previously
            revert NotSeeded();
        }
        if (block.timestamp > d.revealClosesAt) revert TooLate();

        Entry storage e = entries[dayId][msg.sender];
        if (e.commit == bytes32(0)) revert NotSeeded(); // not entered
        if (e.revealed) revert AlreadyRevealed();

        // Support two commit schemes for MVP flexibility:
        // A) Full commit: keccak256(score, runHash, nonce, player, dayId)
        // B) Shell commit: keccak256(nonce, player, dayId)
        bytes32 expectedA = keccak256(abi.encode(score, runHash, nonce, msg.sender, dayId));
        bytes32 expectedB = keccak256(abi.encode(nonce, msg.sender, dayId));
        if (e.commit != expectedA && e.commit != expectedB) revert BadCommit();

        e.revealed = true;
        e.score = score;
        e.runHash = runHash;

        emit Revealed(dayId, msg.sender, score, runHash);
    }

    // -------- Finalization & claims --------
    function finalizeDay(uint256 dayId, bytes32 merkleRoot) external onlyOwner {
        DayParams storage d = rounds[dayId];
        // If the round has never been touched, treat as not seeded
        if (d.enterClosesAt == 0) revert NotSeeded();
        if (block.timestamp <= d.revealClosesAt) revert TooLate();
        if (d.finalized) revert AlreadySeeded(); // reuse error for idempotence

        d.finalized = true;
        d.merkleRoot = merkleRoot;
        uint256 rake = (d.potWei * rakeBps) / 10000;
        d.rakeWei = rake;
        d.poolWei = d.potWei - rake;

        if (rake != 0 && feeSink != address(0)) {
            (bool ok, ) = payable(feeSink).call{value: rake}("");
            require(ok, "rake transfer failed");
        }

        emit Finalized(dayId, merkleRoot, d.poolWei, d.rakeWei);
    }

    function claim(uint256 dayId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        DayParams storage d = rounds[dayId];
        if (!d.finalized) revert NotFinalized();
        if (claimed[dayId][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        require(MerkleProof.verify(proof, d.merkleRoot, leaf), "bad proof");

        claimed[dayId][msg.sender] = true;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "claim transfer failed");

        emit Claimed(dayId, msg.sender, amount);
    }

    // Allow a single paid continue per player per round; fee contributes to prize pot
    function payContinue(uint256 dayId) external payable nonReentrant {
        DayParams storage d = rounds[dayId];
        if (d.enterClosesAt == 0) revert NotSeeded();
        if (block.timestamp > d.revealClosesAt) revert TooLate();
        require(continueFeeWei > 0, "continue disabled");
        require(msg.value == continueFeeWei, "wrong continue fee");
        Entry storage e = entries[dayId][msg.sender];
        if (e.commit == bytes32(0)) revert NotSeeded(); // must have entered
        // Increment continue count; no hard per-round limit enforced
        continues[dayId][msg.sender] += 1;
        d.potWei += msg.value;
        emit ContinuePaid(dayId, msg.sender, msg.value);
    }

    // safety: block unexpected ETH
    receive() external payable {
        revert("direct eth not allowed");
    }
}
