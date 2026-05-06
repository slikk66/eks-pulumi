// Network stack composition. Side-effect importing ./src/vpn transitively
// loads ./src/vpc (vpn depends on vpc's exports), so both modules' top-level
// resource declarations execute. index.ts only re-exports the values that
// should appear as stack outputs for downstream stacks (cluster, gitops) to
// consume via pulumi.StackReference.

import "./src/vpn";

import { vpcId, vpcCidrBlock, publicSubnetIds, privateSubnetIds, workerSubnetIds } from "./src/vpc";
import { clientVpnEndpointId, clientOvpn } from "./src/vpn";

// `clientOvpn` is already wrapped with pulumi.secret(...) in src/vpn.ts;
// re-exporting preserves the secret marking on the stack output.
export {
    vpcId,
    vpcCidrBlock,
    publicSubnetIds,
    privateSubnetIds,
    workerSubnetIds,
    clientVpnEndpointId,
    clientOvpn,
};
