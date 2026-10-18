// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title FRAYWICK ToolAnchor
/// @notice One merkle root per UTC hour over the hashed tool definitions of public MCP servers, Agent Skills
///         and packages. Roots are built with the OpenZeppelin merkle-tree JS library (StandardMerkleTree), leaf encoding
///         ["string","string","bytes32","bytes32","bytes32"]. Anyone can check a leaf with `verify`.
///         The contract only stores roots and emits events: no funds, no token, no upgradeability.
contract ToolAnchor is Ownable2Step {
    struct Anchor {
        bytes32 root;
        uint32 leafCount;
        uint64 postedAt;
    }

    /// @notice Only address allowed to `post` and `flag`.
    address public poster;
    /// @notice Highest anchored epoch (UTC hour number = unix / 3600). 0 before the first post.
    uint64 public latestEpoch;
    /// @notice Number of anchored epochs.
    uint32 public anchorCount;

    /// @notice Anchor for an epoch; root is zero when the epoch was never anchored.
    mapping(uint64 epoch => Anchor) public anchors;

    event Anchored(uint64 indexed epoch, bytes32 root, uint32 leafCount, string snapshotURI);
    event Flagged(
        uint64 indexed epoch,
        bytes32 indexed subject,
        bytes32 oldHash,
        bytes32 newHash,
        uint8 severity,
        string note
    );
    event PosterChanged(address indexed previousPoster, address indexed newPoster);

    error NotPoster(address caller);
    error ZeroAddress();
    error ZeroRoot();
    error EpochNotIncreasing(uint64 epoch, uint64 latestEpoch);
    error EpochInFuture(uint64 epoch, uint256 timestamp);
    error EpochNotAnchored(uint64 epoch);
    error RenounceDisabled();

    modifier onlyPoster() {
        if (msg.sender != poster) revert NotPoster(msg.sender);
        _;
    }

    constructor(address owner_, address poster_) Ownable(owner_) {
        if (poster_ == address(0)) revert ZeroAddress();
        poster = poster_;
        emit PosterChanged(address(0), poster_);
    }

    /// @notice Anchor the merkle root of `epoch`. Epochs strictly increase (gaps allowed) and the hour must
    ///         have started: `epoch * 3600 <= block.timestamp`.
    function post(uint64 epoch, bytes32 root, uint32 leafCount, string calldata snapshotURI)
        external
        onlyPoster
    {
        if (root == bytes32(0)) revert ZeroRoot();
        uint64 latest = latestEpoch;
        if (epoch <= latest) revert EpochNotIncreasing(epoch, latest);
        if (uint256(epoch) * 3600 > block.timestamp) revert EpochInFuture(epoch, block.timestamp);

        anchors[epoch] = Anchor({root: root, leafCount: leafCount, postedAt: uint64(block.timestamp)});
        latestEpoch = epoch;
        unchecked {
            ++anchorCount;
        }
        emit Anchored(epoch, root, leafCount, snapshotURI);
    }

    /// @notice Put a `suspicious` change on chain. Event only; `epoch` must be anchored.
    function flag(
        uint64 epoch,
        bytes32 subject,
        bytes32 oldHash,
        bytes32 newHash,
        uint8 severity,
        string calldata note
    ) external onlyPoster {
        if (anchors[epoch].root == bytes32(0)) revert EpochNotAnchored(epoch);
        emit Flagged(epoch, subject, oldHash, newHash, severity, note);
    }

    /// @notice True when `leaf` (already double-hashed, StandardMerkleTree style) is in the root of `epoch`.
    ///         Returns false for an unanchored epoch.
    function verify(uint64 epoch, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = anchors[epoch].root;
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// @notice StandardMerkleTree leaf hash for the FRAYWICK leaf encoding.
    function leafHash(string calldata key, string calldata version, bytes32 h1, bytes32 h2, bytes32 h3)
        external
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(key, version, h1, h2, h3))));
    }

    function setPoster(address newPoster) external onlyOwner {
        if (newPoster == address(0)) revert ZeroAddress();
        emit PosterChanged(poster, newPoster);
        poster = newPoster;
    }

    /// @dev Disabled: the contract must always have an owner able to rotate the poster.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
