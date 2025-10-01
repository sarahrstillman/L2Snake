// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * SnakeLeaderboard – pay-to-play endless mode with a global leaderboard.
 * Players pay an entry fee to start a run and submit a verified score signed by
 * the off-chain attestation server. The contract tracks the top 25 individual
 * run scores on-chain for easy querying, allowing multiple entries per player
 * based on their best runs.
 */
contract SnakeLeaderboard is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    error AlreadyRunning();
    error InvalidSession();
    error InvalidFee();
    error RunFinalized();
    error BadAttestation();

    uint8 public constant LEADERBOARD_SIZE = 25;

    struct RunState {
        address player;
        bool finalized;
    }

    struct PlayerStats {
        uint64 bestScore;
        uint32 runs;
        uint8 bestRank; // 1-based index of the player’s highest ranked run (0 = not on board)
    }

    struct LeaderboardEntry {
        address player;
        uint64 score;
        bytes32 sessionId;
        uint64 updatedAt;
    }

    struct ScorePayload {
        address player;
        bytes32 sessionId;
        uint64 score;
        bytes32 runHash;
        bytes32 timeDigest;
    }

    address public feeSink;
    address public serverSigner;

    uint256 public entryFeeWei;
    mapping(bytes32 => RunState) public runs;
    mapping(address => PlayerStats) public players;
    LeaderboardEntry[] public leaderboard;

    event RunStarted(bytes32 indexed sessionId, address indexed player);
    event ScoreSubmitted(bytes32 indexed sessionId, address indexed player, uint64 score, uint8 rank);
    event LeaderboardChanged(address indexed player, uint64 runScore, uint8 newRank);
    event FeesUpdated(uint256 entryFeeWei);
    event ServerSignerUpdated(address indexed signer);
    event FeeSinkUpdated(address indexed sink);

    constructor(address _feeSink, address _serverSigner, uint256 _entryFeeWei) Ownable(msg.sender) {
        feeSink = _feeSink;
        serverSigner = _serverSigner;
        entryFeeWei = _entryFeeWei;
    }

    // -------- Admin --------
    function setEntryFee(uint256 _entryFeeWei) external onlyOwner {
        entryFeeWei = _entryFeeWei;
        emit FeesUpdated(_entryFeeWei);
    }

    function setServerSigner(address signer) external onlyOwner {
        serverSigner = signer;
        emit ServerSignerUpdated(signer);
    }

    function setFeeSink(address sink) external onlyOwner {
        feeSink = sink;
        emit FeeSinkUpdated(sink);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad to");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // -------- Gameplay --------
    function startRun(bytes32 sessionId) external payable nonReentrant {
        if (entryFeeWei == 0) revert InvalidFee();
        if (msg.value != entryFeeWei) revert InvalidFee();
        RunState storage rs = runs[sessionId];
        if (rs.player != address(0)) revert AlreadyRunning();

        rs.player = msg.sender;
        rs.finalized = false;

        PlayerStats storage stats = players[msg.sender];
        stats.runs += 1;

        emit RunStarted(sessionId, msg.sender);
    }

    function submitScore(ScorePayload calldata payload, bytes calldata serverSig) external nonReentrant {
        if (payload.player != msg.sender) revert InvalidSession();
        RunState storage rs = runs[payload.sessionId];
        if (rs.player != msg.sender) revert InvalidSession();
        if (rs.finalized) revert RunFinalized();
        if (serverSigner == address(0)) revert BadAttestation();

        bytes32 digest = keccak256(abi.encode(
            payload.player,
            payload.sessionId,
            payload.score,
            payload.runHash,
            payload.timeDigest
        ));
        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), serverSig);
        if (recovered != serverSigner) revert BadAttestation();

        rs.finalized = true;

        PlayerStats storage stats = players[msg.sender];
        if (payload.score > stats.bestScore) {
            stats.bestScore = payload.score;
        }

        (bool inserted, address dropped) = _considerLeaderboardEntry(LeaderboardEntry({
            player: msg.sender,
            score: payload.score,
            sessionId: payload.sessionId,
            updatedAt: uint64(block.timestamp)
        }));

        if (dropped != address(0)) {
            players[dropped].bestRank = 0;
        }

        uint8 newRank = players[msg.sender].bestRank;
        if (inserted) {
            _recalculateRanks();
            newRank = players[msg.sender].bestRank;
            emit LeaderboardChanged(msg.sender, payload.score, newRank);
        }

        emit ScoreSubmitted(payload.sessionId, msg.sender, payload.score, newRank);
    }

    // -------- Views --------
    function leaderboardLength() external view returns (uint256) {
        return leaderboard.length;
    }

    function getLeaderboard() external view returns (LeaderboardEntry[] memory rows) {
        rows = leaderboard;
    }

    function getPlayer(address player) external view returns (PlayerStats memory stats) {
        stats = players[player];
    }

    // -------- Internal helpers --------
    function _considerLeaderboardEntry(LeaderboardEntry memory entry) internal returns (bool inserted, address droppedPlayer) {
        if (leaderboard.length < LEADERBOARD_SIZE) {
            leaderboard.push(entry);
            _bubbleUp(leaderboard.length - 1);
            inserted = true;
            return (inserted, address(0));
        }

        uint256 lastIdx = leaderboard.length - 1;
        LeaderboardEntry memory tail = leaderboard[lastIdx];
        if (entry.score < tail.score) {
            return (false, address(0));
        }
        if (entry.score == tail.score && entry.updatedAt <= tail.updatedAt) {
            return (false, address(0));
        }

        droppedPlayer = tail.player;
        leaderboard[lastIdx] = entry;
        _bubbleUp(lastIdx);
        inserted = true;
    }

    function _bubbleUp(uint256 i) internal {
        while (i > 0) {
            uint256 prev = i - 1;
            LeaderboardEntry memory curr = leaderboard[i];
            LeaderboardEntry memory prevEntry = leaderboard[prev];
            bool shouldSwap;
            if (curr.score > prevEntry.score) {
                shouldSwap = true;
            } else if (curr.score == prevEntry.score) {
                shouldSwap = curr.updatedAt > prevEntry.updatedAt;
            }

            if (!shouldSwap) {
                break;
            }

            leaderboard[prev] = curr;
            leaderboard[i] = prevEntry;

            i = prev;
        }
    }

    function _recalculateRanks() internal {
        for (uint256 i = 0; i < leaderboard.length; i++) {
            players[leaderboard[i].player].bestRank = 0;
        }
        for (uint256 i = 0; i < leaderboard.length; i++) {
            PlayerStats storage stats = players[leaderboard[i].player];
            if (stats.bestRank == 0) {
                stats.bestRank = uint8(i + 1);
            }
        }
    }

    // safety: block unexpected ETH
    receive() external payable {
        revert("direct eth not allowed");
    }
}
