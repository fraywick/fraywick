// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ToolAnchor} from "../src/ToolAnchor.sol";

/// @notice Deploys ToolAnchor with owner and poster set in the constructor. The deployer only pays gas.
/// Env:
///   OWNER       optional  owner wallet (setPoster, ownership transfer); default below
///   POSTER      optional  hourly root poster; default below
///   DEPLOY_OUT  optional  output JSON path (default deployments/robinhood.json)
contract Deploy is Script {
    address constant DEFAULT_OWNER = 0x26c22014016BE6B55F00E6BBb8C5058801404092;
    address constant DEFAULT_POSTER = 0x3D0d1B5dfe2f5004640A42595EbCff5fE3dE59eC;

    function run() external returns (ToolAnchor anchor) {
        address owner = vm.envOr("OWNER", DEFAULT_OWNER);
        address poster = vm.envOr("POSTER", DEFAULT_POSTER);
        address deployer = msg.sender;
        require(owner != address(0), "OWNER is zero");
        require(poster != address(0), "POSTER is zero");
        require(owner != deployer, "OWNER must not be the deployer");
        require(poster != deployer, "POSTER must not be the deployer");
        if (block.chainid != 4663) console.log("warning: chain id is not 4663 (Robinhood Chain mainnet)");

        // block.number on Robinhood Chain (Arbitrum Orbit) is the L1 block; record the L2 head instead.
        uint256 startBlock = _l2BlockNumber();

        vm.startBroadcast();
        anchor = new ToolAnchor(owner, poster);
        vm.stopBroadcast();

        require(
            anchor.owner() == owner && anchor.poster() == poster && anchor.pendingOwner() == address(0),
            "post-deploy check failed"
        );
        console.log("ToolAnchor", address(anchor));
        console.log("owner", owner);
        console.log("poster", poster);
        console.log("deployer", deployer);

        string memory o = "deployment";
        vm.serializeAddress(o, "address", address(anchor));
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", startBlock);
        vm.serializeAddress(o, "owner", owner);
        vm.serializeAddress(o, "poster", poster);
        string memory json = vm.serializeAddress(o, "deployer", deployer);
        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/robinhood.json"));
        vm.writeJson(json, out);
        console.log("wrote", out);
    }

    function _l2BlockNumber() internal returns (uint256 n) {
        bytes memory raw = vm.rpc("eth_blockNumber", "[]");
        for (uint256 i; i < raw.length; ++i) {
            n = (n << 8) | uint8(raw[i]);
        }
    }
}
