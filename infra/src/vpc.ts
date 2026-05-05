// VPC for the EKS cluster — configurable AZ count (default 3), public +
// private subnets per AZ, S3 gateway endpoint (always), optional multi-AZ
// NAT (one per AZ) when enableNat=true.
//
// Uses raw aws.ec2.* resources rather than awsx.ec2.Vpc: the awsx
// abstraction hides per-subnet kubernetes.io/role/* tags and the
// conditional per-AZ NAT toggle this design needs.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { prefix, region, vpcCidr, enableNat, azCount } from "../pulumi.config";

// Equivalent to Terraform's cidrsubnet(): split `base` into 2^newbits
// subnets of prefix (basePrefix + newbits) and return the netnum-th.
// Pure synchronous string math — no Output<> wrapping needed.
// https://developer.hashicorp.com/terraform/language/functions/cidrsubnet
function cidrsubnet(base: string, newbits: number, netnum: number): string {
    const [ip, prefixStr] = base.split("/");
    const basePrefix = parseInt(prefixStr, 10);
    const newPrefix = basePrefix + newbits;
    if (newPrefix > 32) {
        throw new Error(`cidrsubnet: result prefix /${newPrefix} > 32 (base=${base}, newbits=${newbits})`);
    }
    if (netnum < 0 || netnum >= 2 ** newbits) {
        throw new Error(`cidrsubnet: netnum ${netnum} out of range for newbits ${newbits}`);
    }
    const octets = ip.split(".").map(o => parseInt(o, 10));
    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const offset = (netnum * (2 ** (32 - newPrefix))) >>> 0;
    const subnetInt = (baseInt | offset) >>> 0;
    const out = [
        (subnetInt >>> 24) & 0xff,
        (subnetInt >>> 16) & 0xff,
        (subnetInt >>> 8) & 0xff,
        subnetInt & 0xff,
    ];
    return `${out.join(".")}/${newPrefix}`;
}

// vpcCidr must be /20 or larger so each subnet gets at least a /20
// (~4096 IPs — fine for EKS pod density via prefix delegation).
const vpcPrefix = parseInt(vpcCidr.split("/")[1], 10);
if (vpcPrefix > 20) {
    throw new Error(
        `vpcCidr ${vpcCidr} too small (prefix /${vpcPrefix}); use /20 or larger so subnets are /20.`,
    );
}
const newbits = 20 - vpcPrefix;

// Deterministic /20 subnets derived from (vpcCidr, azCount). With the
// default vpcCidr=10.50.0.0/16 and azCount=3 these match the previously
// hardcoded values exactly: public=[.0.0/20,.16.0/20,.32.0/20],
// private=[.48.0/20,.64.0/20,.80.0/20].
const PUBLIC_CIDRS: string[] = Array.from({ length: azCount }, (_, i) => cidrsubnet(vpcCidr, newbits, i));
const PRIVATE_CIDRS: string[] = Array.from({ length: azCount }, (_, i) => cidrsubnet(vpcCidr, newbits, azCount + i));

const azs = aws.getAvailabilityZonesOutput({ state: "available" });
// Pre-flight guard: fail loudly with region + counts if the region has
// fewer AZs than requested. Without this, downstream subnet construction
// surfaces as a cryptic CIDR / capacity error mid-apply.
const azNames = pulumi.all([azs.names, region]).apply(([names, r]) => {
    if (names.length < azCount) {
        throw new Error(
            `Region ${r} has only ${names.length} AZ(s); azCount=${azCount} requested. ` +
            `Reduce azCount in Pulumi config or choose a region with at least ${azCount} AZs.`,
        );
    }
    return names.slice(0, azCount);
});

const vpc = new aws.ec2.Vpc(`${prefix}-vpc`, {
    cidrBlock: vpcCidr,
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: `${prefix}-vpc` },
});

const igw = new aws.ec2.InternetGateway(`${prefix}-igw`, {
    vpcId: vpc.id,
    tags: { Name: `${prefix}-igw` },
});

const publicSubnets: aws.ec2.Subnet[] = [];
const privateSubnets: aws.ec2.Subnet[] = [];
const publicRouteTables: aws.ec2.RouteTable[] = [];
const privateRouteTables: aws.ec2.RouteTable[] = [];

for (let i = 0; i < azCount; i++) {
    const az = azNames.apply(n => n[i]);

    // mapPublicIpOnLaunch: true is required for EKS managed node groups
    // launched into a public subnet (workers without a public IP cannot
    // reach the EKS control plane).
    // https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html
    const publicSubnet = new aws.ec2.Subnet(`${prefix}-public-${i}`, {
        vpcId: vpc.id,
        cidrBlock: PUBLIC_CIDRS[i],
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: {
            Name: `${prefix}-public-${i}`,
            "kubernetes.io/role/elb": "1",
        },
    });
    publicSubnets.push(publicSubnet);

    const publicRt = new aws.ec2.RouteTable(`${prefix}-public-rt-${i}`, {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-public-rt-${i}` },
    });
    publicRouteTables.push(publicRt);

    new aws.ec2.Route(`${prefix}-public-default-${i}`, {
        routeTableId: publicRt.id,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: igw.id,
    });

    new aws.ec2.RouteTableAssociation(`${prefix}-public-rta-${i}`, {
        subnetId: publicSubnet.id,
        routeTableId: publicRt.id,
    });

    const privateSubnet = new aws.ec2.Subnet(`${prefix}-private-${i}`, {
        vpcId: vpc.id,
        cidrBlock: PRIVATE_CIDRS[i],
        availabilityZone: az,
        tags: {
            Name: `${prefix}-private-${i}`,
            "kubernetes.io/role/internal-elb": "1",
        },
    });
    privateSubnets.push(privateSubnet);

    const privateRt = new aws.ec2.RouteTable(`${prefix}-private-rt-${i}`, {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-private-rt-${i}` },
    });
    privateRouteTables.push(privateRt);

    new aws.ec2.RouteTableAssociation(`${prefix}-private-rta-${i}`, {
        subnetId: privateSubnet.id,
        routeTableId: privateRt.id,
    });

    if (enableNat) {
        const eip = new aws.ec2.Eip(`${prefix}-nat-eip-${i}`, {
            domain: "vpc",
            tags: { Name: `${prefix}-nat-eip-${i}` },
        }, { dependsOn: [igw] });

        const nat = new aws.ec2.NatGateway(`${prefix}-nat-${i}`, {
            allocationId: eip.id,
            subnetId: publicSubnet.id,
            tags: { Name: `${prefix}-nat-${i}` },
        }, { dependsOn: [igw] });

        new aws.ec2.Route(`${prefix}-private-default-${i}`, {
            routeTableId: privateRt.id,
            destinationCidrBlock: "0.0.0.0/0",
            natGatewayId: nat.id,
        });
    }
}

// S3 gateway endpoint — free; useful for ECR layer pulls (S3-backed).
// Attach to every route table so traffic from any subnet stays on-AWS.
new aws.ec2.VpcEndpoint(`${prefix}-s3-endpoint`, {
    vpcId: vpc.id,
    serviceName: pulumi.interpolate`com.amazonaws.${region}.s3`,
    vpcEndpointType: "Gateway",
    routeTableIds: [...publicRouteTables, ...privateRouteTables].map(rt => rt.id),
    tags: { Name: `${prefix}-s3-endpoint` },
});

export const vpcId: pulumi.Output<string> = vpc.id;
export const vpcCidrBlock: pulumi.Output<string> = vpc.cidrBlock;
export const publicSubnetIds: pulumi.Output<string[]> = pulumi.all(publicSubnets.map(s => s.id));
export const privateSubnetIds: pulumi.Output<string[]> = pulumi.all(privateSubnets.map(s => s.id));
export const availabilityZones: pulumi.Output<string[]> = azNames;
