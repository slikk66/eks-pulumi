// Typed config loader for the network stack.
// Single source of truth for VPC + Client VPN inputs.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const cfg = new pulumi.Config();

// VPC
export const vpcCidr = cfg.get("vpcCidr") ?? "10.50.0.0/16";
export const enableNat = cfg.getBoolean("enableNat") ?? false;

// AZ count — default 3. Range [2, 6]: EKS requires >= 2; real AWS regions
// max at 6 AZs (us-east-1) and a /16 vpcCidr split into /20s yields 16 slots
// (2 × azCount used) so 6 leaves headroom. Set to 2 in regions like us-west-1.
export const azCount = cfg.getNumber("azCount") ?? 3;
if (!Number.isInteger(azCount) || azCount < 2 || azCount > 6) {
    throw new Error(
        `azCount must be an integer in [2, 6]; got ${azCount}. ` +
        `EKS requires >= 2 AZs; cap at 6 (real AWS region max + /16 CIDR headroom).`,
    );
}

// Client VPN
export const clientVpnCidr = cfg.get("clientVpnCidr") ?? "10.100.0.0/22";
// Reject overlapping vpcCidr / clientVpnCidr at config-load. A typo in
// Pulumi.<stack>.yaml otherwise surfaces as a cryptic mid-apply AWS error.
function cidrToRange(cidr: string): [number, number] {
    const [ip, prefixStr] = cidr.split("/");
    const prefix = parseInt(prefixStr, 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`Invalid CIDR prefix: ${cidr}`);
    }
    const octets = ip.split(".").map(o => parseInt(o, 10));
    if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new Error(`Invalid CIDR octet: ${cidr}`);
    }
    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const size = (2 ** (32 - prefix)) >>> 0;
    return [baseInt, (baseInt + size - 1) >>> 0];
}
const [vpcStart, vpcEnd] = cidrToRange(vpcCidr);
const [vpnStart, vpnEnd] = cidrToRange(clientVpnCidr);
if (vpcStart <= vpnEnd && vpnStart <= vpcEnd) {
    throw new Error(
        `vpcCidr (${vpcCidr}) and clientVpnCidr (${clientVpnCidr}) must not overlap. ` +
        `Pick non-overlapping ranges; defaults are 10.50.0.0/16 and 10.100.0.0/22.`,
    );
}
// false (default) = single subnet association (cost-sensitive). true = one
// association per private subnet (multi-AZ HA, ~$72/mo per extra association).
export const vpnHighAvailability = cfg.getBoolean("vpnHighAvailability") ?? false;

// Resolved at runtime
export const region = aws.getRegionOutput().id;

// Naming
export const project = pulumi.getProject();
export const stack = pulumi.getStack();
export const prefix = `${project}-${stack}`;
