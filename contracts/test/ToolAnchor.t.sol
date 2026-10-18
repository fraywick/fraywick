// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ToolAnchor} from "../src/ToolAnchor.sol";
import {StandardTree} from "./utils/StandardTree.sol";

contract ToolAnchorTest is Test {
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

    address constant OWNER = 0x26c22014016BE6B55F00E6BBb8C5058801404092;
    address constant POSTER = 0x3D0d1B5dfe2f5004640A42595EbCff5fE3dE59eC;
    // 2026-10-18 23:30 UTC
    uint256 constant NOW = 1792366200;
    uint64 constant EPOCH = uint64(NOW / 3600);

    ToolAnchor anchor;

    function setUp() public {
        vm.warp(NOW);
        anchor = new ToolAnchor(OWNER, POSTER);
    }

    function _post(uint64 epoch, bytes32 root) internal {
        vm.prank(POSTER);
        anchor.post(epoch, root, 1, "");
    }

    // ---------- constructor ----------

    function test_constructor_setsRoles() public view {
        assertEq(anchor.owner(), OWNER);
        assertEq(anchor.poster(), POSTER);
        assertEq(anchor.pendingOwner(), address(0));
        assertEq(anchor.latestEpoch(), 0);
        assertEq(anchor.anchorCount(), 0);
    }

    function test_constructor_deployerHasNoRights() public {
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.NotPoster.selector, address(this)));
        anchor.post(EPOCH, bytes32(uint256(1)), 1, "");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        anchor.setPoster(address(this));
    }

    function test_constructor_emitsPosterChanged() public {
        vm.expectEmit(true, true, false, false);
        emit PosterChanged(address(0), POSTER);
        new ToolAnchor(OWNER, POSTER);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ToolAnchor(address(0), POSTER);
    }

    function test_constructor_rejectsZeroPoster() public {
        vm.expectRevert(ToolAnchor.ZeroAddress.selector);
        new ToolAnchor(OWNER, address(0));
    }

    // ---------- post ----------

    function test_post_storesAndEmits() public {
        string memory uri = "https://fraywick.dev/snapshots/497879.json";
        bytes32 root = keccak256("root");
        vm.expectEmit(true, false, false, true);
        emit Anchored(EPOCH, root, 1234, uri);
        vm.prank(POSTER);
        anchor.post(EPOCH, root, 1234, uri);

        (bytes32 r, uint32 n, uint64 at) = anchor.anchors(EPOCH);
        assertEq(r, root);
        assertEq(n, 1234);
        assertEq(at, NOW);
        assertEq(anchor.latestEpoch(), EPOCH);
        assertEq(anchor.anchorCount(), 1);
    }

    function test_post_onlyPoster_ownerCannotPost() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.NotPoster.selector, OWNER));
        anchor.post(EPOCH, bytes32(uint256(1)), 1, "");
    }

    function testFuzz_post_onlyPoster(address caller) public {
        vm.assume(caller != POSTER);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.NotPoster.selector, caller));
        anchor.post(EPOCH, bytes32(uint256(1)), 1, "");
    }

    function test_post_rejectsZeroRoot() public {
        vm.prank(POSTER);
        vm.expectRevert(ToolAnchor.ZeroRoot.selector);
        anchor.post(EPOCH, bytes32(0), 1, "");
    }

    function test_post_rejectsSameAndOlderEpoch() public {
        _post(EPOCH - 5, bytes32(uint256(1)));
        vm.startPrank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochNotIncreasing.selector, EPOCH - 5, EPOCH - 5));
        anchor.post(EPOCH - 5, bytes32(uint256(2)), 1, "");
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochNotIncreasing.selector, EPOCH - 6, EPOCH - 5));
        anchor.post(EPOCH - 6, bytes32(uint256(2)), 1, "");
        vm.stopPrank();
    }

    function test_post_rejectsEpochZero() public {
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochNotIncreasing.selector, 0, 0));
        anchor.post(0, bytes32(uint256(1)), 1, "");
    }

    function test_post_gapsAllowed() public {
        _post(EPOCH - 10, bytes32(uint256(1)));
        _post(EPOCH - 3, bytes32(uint256(2)));
        _post(EPOCH, bytes32(uint256(3)));
        assertEq(anchor.latestEpoch(), EPOCH);
        assertEq(anchor.anchorCount(), 3);
        (bytes32 gap,,) = anchor.anchors(EPOCH - 5);
        assertEq(gap, bytes32(0));
    }

    function test_post_futureEpochRejected() public {
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochInFuture.selector, EPOCH + 1, NOW));
        anchor.post(EPOCH + 1, bytes32(uint256(1)), 1, "");
    }

    function test_post_epochStartBoundary() public {
        uint64 next = EPOCH + 1;
        vm.warp(uint256(next) * 3600 - 1);
        vm.prank(POSTER);
        vm.expectRevert(
            abi.encodeWithSelector(ToolAnchor.EpochInFuture.selector, next, uint256(next) * 3600 - 1)
        );
        anchor.post(next, bytes32(uint256(1)), 1, "");
        vm.warp(uint256(next) * 3600);
        _post(next, bytes32(uint256(1)));
        assertEq(anchor.latestEpoch(), next);
    }

    function testFuzz_post_futureEpochRejected(uint64 epoch) public {
        epoch = uint64(bound(epoch, EPOCH + 1, type(uint64).max));
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochInFuture.selector, epoch, NOW));
        anchor.post(epoch, bytes32(uint256(1)), 1, "");
    }

    /// Model check: any sequence of attempts, only strictly increasing, non-future epochs are accepted.
    function testFuzz_post_monotonic(uint64[12] memory raw, uint32[12] memory dt) public {
        uint64 latest;
        uint32 count;
        uint256 t = NOW;
        for (uint256 i; i < raw.length; ++i) {
            t += bound(dt[i], 0, 3 hours);
            vm.warp(t);
            uint64 epoch = uint64(bound(raw[i], 0, t / 3600 + 3));
            bytes32 root = keccak256(abi.encode(i, epoch));
            vm.prank(POSTER);
            if (epoch <= latest) {
                vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochNotIncreasing.selector, epoch, latest));
                anchor.post(epoch, root, 1, "");
            } else if (uint256(epoch) * 3600 > t) {
                vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochInFuture.selector, epoch, t));
                anchor.post(epoch, root, 1, "");
            } else {
                anchor.post(epoch, root, uint32(i), "");
                latest = epoch;
                ++count;
                (bytes32 r,, uint64 at) = anchor.anchors(epoch);
                assertEq(r, root);
                assertEq(at, t);
            }
            assertEq(anchor.latestEpoch(), latest);
            assertEq(anchor.anchorCount(), count);
        }
    }

    // ---------- flag ----------

    function test_flag_unanchoredEpochReverts() public {
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochNotAnchored.selector, EPOCH));
        anchor.flag(EPOCH, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)), 80, "x");
    }

    function testFuzz_flag_unanchoredEpochReverts(uint64 anchored, uint64 other) public {
        anchored = uint64(bound(anchored, 1, EPOCH));
        vm.assume(other != anchored);
        _post(anchored, bytes32(uint256(1)));
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.EpochNotAnchored.selector, other));
        anchor.flag(other, bytes32(0), bytes32(0), bytes32(0), 0, "");
    }

    function test_flag_emits() public {
        _post(EPOCH, bytes32(uint256(1)));
        bytes32 subject = keccak256("mcp:io.example/weather");
        vm.expectEmit(true, true, false, true);
        emit Flagged(EPOCH, subject, bytes32(uint256(2)), bytes32(uint256(3)), 87, "new <IMPORTANT> block");
        vm.prank(POSTER);
        anchor.flag(EPOCH, subject, bytes32(uint256(2)), bytes32(uint256(3)), 87, "new <IMPORTANT> block");
        assertEq(anchor.anchorCount(), 1);
    }

    function testFuzz_flag_onlyPoster(address caller) public {
        vm.assume(caller != POSTER);
        _post(EPOCH, bytes32(uint256(1)));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.NotPoster.selector, caller));
        anchor.flag(EPOCH, bytes32(0), bytes32(0), bytes32(0), 0, "");
    }

    // ---------- verify ----------

    function _values(uint256 n, uint256 seed) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = StandardTree.leaf(
                string.concat("mcp:io.example/server-", _u(i)),
                "1.0.0",
                keccak256(abi.encode(seed, i, 1)),
                keccak256(abi.encode(seed, i, 2)),
                i % 3 == 0 ? bytes32(0) : keccak256(abi.encode(seed, i, 3))
            );
        }
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = bytes.concat(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }

    function _checkTree(uint256 n, uint256 seed) internal {
        bytes32[] memory leaves = _values(n, seed);
        (bytes32[] memory tree, uint256[] memory idx) = StandardTree.build(leaves);
        _post(EPOCH, tree[0]);
        for (uint256 i; i < n; ++i) {
            bytes32[] memory p = StandardTree.proof(tree, idx[i]);
            assertTrue(anchor.verify(EPOCH, leaves[i], p), "leaf must verify");
            assertFalse(anchor.verify(EPOCH, leaves[i] ^ bytes32(uint256(1)), p), "tampered leaf");
            assertFalse(anchor.verify(EPOCH - 1, leaves[i], p), "unanchored epoch");
            if (p.length > 0) {
                p[0] = p[0] ^ bytes32(uint256(1) << 255);
                assertFalse(anchor.verify(EPOCH, leaves[i], p), "tampered proof");
            }
        }
    }

    function test_verify_sevenLeafTree() public {
        _checkTree(7, 42);
    }

    function test_verify_singleLeafTree() public {
        _checkTree(1, 7);
    }

    function testFuzz_verify_tree(uint8 n, uint256 seed) public {
        _checkTree(bound(n, 1, 40), seed);
    }

    function test_verify_wrongLeafFromOtherTree() public {
        bytes32[] memory leaves = _values(5, 1);
        bytes32[] memory others = _values(5, 2);
        (bytes32[] memory tree, uint256[] memory idx) = StandardTree.build(leaves);
        _post(EPOCH, tree[0]);
        assertFalse(anchor.verify(EPOCH, others[0], StandardTree.proof(tree, idx[0])));
    }

    function test_verify_rawSingleHashedLeafFails() public {
        bytes32 inner = keccak256(abi.encode("mcp:a", "1", bytes32(uint256(1)), bytes32(0), bytes32(0)));
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = keccak256(bytes.concat(inner));
        leaves[1] = StandardTree.leaf("mcp:b", "1", bytes32(uint256(2)), bytes32(0), bytes32(0));
        (bytes32[] memory tree, uint256[] memory idx) = StandardTree.build(leaves);
        _post(EPOCH, tree[0]);
        assertTrue(anchor.verify(EPOCH, leaves[0], StandardTree.proof(tree, idx[0])));
        assertFalse(anchor.verify(EPOCH, inner, StandardTree.proof(tree, idx[0])));
    }

    function test_leafHash_matchesStandardEncoding() public view {
        bytes32 h1 = keccak256("tools");
        assertEq(
            anchor.leafHash("skill:anthropics/skills:pdf/SKILL.md", "abc123", h1, bytes32(0), bytes32(0)),
            StandardTree.leaf("skill:anthropics/skills:pdf/SKILL.md", "abc123", h1, bytes32(0), bytes32(0))
        );
    }

    /// Known answer from the OpenZeppelin merkle-tree README (address, uint256 leaves).
    function test_standardTree_knownAnswer() public pure {
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = keccak256(
            bytes.concat(keccak256(abi.encode(address(0x1111111111111111111111111111111111111111), 5e18)))
        );
        leaves[1] = keccak256(
            bytes.concat(keccak256(abi.encode(address(0x2222222222222222222222222222222222222222), 2.5e18)))
        );
        (bytes32[] memory tree,) = StandardTree.build(leaves);
        assertEq(tree[0], 0xd4dee0beab2d53f2cc83e567171bd2820e49898130a22622b10ead383e90bd77);
    }

    // ---------- server JS vectors ----------

    /// Reads a StandardMerkleTree `tree.dump()` written by the server (optionally with a top-level "root").
    function test_vectors_serverJsTree() public {
        string memory path = "test/vectors/merkle.json";
        if (!vm.exists(path)) {
            vm.skip(true, "test/vectors/merkle.json missing (copy server/test/vectors/merkle.json)");
        }
        string memory json = vm.readFile(path);
        if (vm.keyExistsJson(json, ".format")) {
            assertEq(vm.parseJsonString(json, ".format"), "standard-v1");
        }
        string[] memory enc = vm.parseJsonStringArray(json, ".leafEncoding");
        assertEq(enc.length, 5);
        assertEq(enc[0], "string");
        assertEq(enc[1], "string");
        assertEq(enc[2], "bytes32");
        assertEq(enc[3], "bytes32");
        assertEq(enc[4], "bytes32");

        bytes32[] memory tree = vm.parseJsonBytes32Array(json, ".tree");
        uint256 n = (tree.length + 1) / 2;
        assertGt(n, 0);
        for (uint256 i = tree.length - n; i > 0; --i) {
            assertEq(tree[i - 1], StandardTree.hashPair(tree[2 * i - 1], tree[2 * i]), "internal node");
        }
        if (vm.keyExistsJson(json, ".root")) {
            assertEq(vm.parseJsonBytes32(json, ".root"), tree[0], "root");
        }

        _post(EPOCH, tree[0]);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".values[", vm.toString(i), "]");
            string[] memory v = vm.parseJsonStringArray(json, string.concat(k, ".value"));
            uint256 ti = vm.parseJsonUint(json, string.concat(k, ".treeIndex"));
            bytes32 lf = StandardTree.leaf(
                v[0], v[1], vm.parseBytes32(v[2]), vm.parseBytes32(v[3]), vm.parseBytes32(v[4])
            );
            assertEq(tree[ti], lf, "leaf hash");
            assertEq(
                anchor.leafHash(
                    v[0], v[1], vm.parseBytes32(v[2]), vm.parseBytes32(v[3]), vm.parseBytes32(v[4])
                ),
                lf
            );
            bytes32[] memory p = StandardTree.proof(tree, ti);
            assertTrue(anchor.verify(EPOCH, lf, p), "vector leaf must verify");
            assertFalse(anchor.verify(EPOCH, lf ^ bytes32(uint256(1)), p));
        }
    }

    // ---------- owner ----------

    function test_setPoster() public {
        address next = makeAddr("next");
        vm.expectEmit(true, true, false, false);
        emit PosterChanged(POSTER, next);
        vm.prank(OWNER);
        anchor.setPoster(next);
        assertEq(anchor.poster(), next);

        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ToolAnchor.NotPoster.selector, POSTER));
        anchor.post(EPOCH, bytes32(uint256(1)), 1, "");

        vm.prank(next);
        anchor.post(EPOCH, bytes32(uint256(1)), 1, "");
    }

    function test_setPoster_rejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(ToolAnchor.ZeroAddress.selector);
        anchor.setPoster(address(0));
    }

    function testFuzz_setPoster_onlyOwner(address caller) public {
        vm.assume(caller != OWNER);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        anchor.setPoster(caller);
    }

    function test_ownership_twoStep() public {
        address next = makeAddr("newOwner");
        vm.prank(OWNER);
        anchor.transferOwnership(next);
        assertEq(anchor.owner(), OWNER);
        assertEq(anchor.pendingOwner(), next);

        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, POSTER));
        anchor.acceptOwnership();

        vm.prank(next);
        anchor.acceptOwnership();
        assertEq(anchor.owner(), next);
        assertEq(anchor.pendingOwner(), address(0));
    }

    function test_renounce_disabled() public {
        vm.prank(OWNER);
        vm.expectRevert(ToolAnchor.RenounceDisabled.selector);
        anchor.renounceOwnership();
        assertEq(anchor.owner(), OWNER);

        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, POSTER));
        anchor.renounceOwnership();
    }
}

/// Isolated calls for `forge test --gas-report --match-contract ToolAnchorGas`.
contract ToolAnchorGasTest is Test {
    address constant POSTER = 0x3D0d1B5dfe2f5004640A42595EbCff5fE3dE59eC;
    uint256 constant NOW = 1792366200;
    uint64 constant EPOCH = uint64(NOW / 3600);
    string constant URI60 = "https://fraywick.dev/snapshots/497879.json?sha=0123456789abc";

    ToolAnchor anchor;
    bytes32[] proof12;
    bytes32 leaf12;

    function setUp() public {
        vm.warp(NOW);
        anchor = new ToolAnchor(address(0xA11CE), POSTER);
        vm.prank(POSTER);
        anchor.post(EPOCH - 2, bytes32(uint256(1)), 1, URI60);

        leaf12 = keccak256("leaf");
        bytes32 node = leaf12;
        for (uint256 i; i < 12; ++i) {
            bytes32 sib = keccak256(abi.encode("sibling", i));
            proof12.push(sib);
            node = StandardTree.hashPair(node, sib);
        }
        vm.prank(POSTER);
        anchor.post(EPOCH - 1, node, 4096, URI60);
    }

    function test_gas_post60CharUri() public {
        assertEq(bytes(URI60).length, 60);
        vm.prank(POSTER);
        anchor.post(EPOCH, keccak256("root"), 4000, URI60);
    }

    function test_gas_flag() public {
        vm.prank(POSTER);
        anchor.flag(
            EPOCH - 1,
            keccak256("mcp:io.example/weather"),
            keccak256("old"),
            keccak256("new"),
            87,
            "description: new imperative + hidden unicode"
        );
    }

    function test_gas_verify12Deep() public view {
        assertTrue(anchor.verify(EPOCH - 1, leaf12, proof12));
    }
}
