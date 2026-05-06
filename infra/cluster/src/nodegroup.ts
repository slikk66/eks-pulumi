// EKS managed node group — Bottlerocket m7a.large × 2 with the
// CriticalAddonsOnly taint. Hosts only system pods + ArgoCD + Karpenter
// controller; everything else is scheduled by Karpenter onto NodePool-managed
// nodes (which reuse the same node IAM role via the EC2_LINUX access entry
// below).
//
// Also owns:
//   - vpc-cni managed addon. MUST install before the node group: kubelet won't
//     mark a node Ready until CNI is functional, and node-role no longer has
//     AmazonEKS_CNI_Policy (IRSA-only via kube-system/aws-node SA).
//   - Karpenter EC2_LINUX access entry. NO AccessPolicyAssociation — AWS
//     forbids policy associations on non-STANDARD types; the bare EC2_LINUX
//     entry implicitly grants system:nodes.
//     https://docs.aws.amazon.com/eks/latest/userguide/access-policies.html

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { prefix } from "../pulumi.config";
import { workerSubnetIds } from "./stack-references";
import { cluster } from "./cluster";
import { vpcCniRoleArn } from "./iam";

// Node IAM role --------------------------------------------------------------
//
// Resource URN kept as `${prefix}-node-role` (NOT `karpenter-node-role`):
// iam.ts builds the karpenter controller's iam:PassRole target ARN as a
// literal string `arn:aws:iam::${acct}:role/${prefix}-node-role` to break
// the iam ↔ nodegroup import cycle, so any rename here must be mirrored
// there in lockstep.

export const nodeRole = new aws.iam.Role(`${prefix}-node-role`, {
    name: `${prefix}-node-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
            },
        ],
    }),
});

// AmazonEKS_CNI_Policy intentionally absent: VPC-CNI uses IRSA via
// `kube-system/aws-node` (role declared in iam.ts). Attaching it here would
// expose ENI-mutating creds to every pod via the IMDS endpoint.
const nodeManagedPolicies: { suffix: string; arn: string }[] = [
    { suffix: "eks-worker", arn: "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy" },
    { suffix: "ecr-ro", arn: "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly" },
];

const nodePolicyAttachments = nodeManagedPolicies.map(
    p =>
        new aws.iam.RolePolicyAttachment(`${prefix}-node-${p.suffix}`, {
            role: nodeRole.name,
            policyArn: p.arn,
        }),
);

export const nodeRoleArn: pulumi.Output<string> = nodeRole.arn;
export const karpenterNodeRoleName: pulumi.Output<string> = nodeRole.name;

// vpc-cni addon (must install before nodeGroup) ------------------------------

const vpcCniVersion = aws.eks.getAddonVersionOutput({
    addonName: "vpc-cni",
    kubernetesVersion: cluster.version,
    mostRecent: true,
});

export const vpcCniAddon = new aws.eks.Addon(`${prefix}-vpc-cni`, {
    clusterName: cluster.name,
    addonName: "vpc-cni",
    addonVersion: vpcCniVersion.version,
    serviceAccountRoleArn: vpcCniRoleArn,
    resolveConflictsOnCreate: "OVERWRITE",
    resolveConflictsOnUpdate: "OVERWRITE",
});

// Node group -----------------------------------------------------------------
//
// workerSubnetIds is computed in the network project (private when NAT is
// on, public otherwise) so this slice stays oblivious to enableNat.

export const nodeGroup = new aws.eks.NodeGroup(`${prefix}-system-ng`, {
    clusterName: cluster.name,
    nodeRoleArn: nodeRole.arn,
    subnetIds: workerSubnetIds,
    amiType: "BOTTLEROCKET_x86_64",
    instanceTypes: ["m7a.large"],
    scalingConfig: {
        desiredSize: 2,
        minSize: 2,
        maxSize: 3,
    },
    // CriticalAddonsOnly keeps general workloads off this group. Only system
    // pods that tolerate the taint (ArgoCD, Karpenter controller, kube-proxy,
    // CoreDNS) land here; Karpenter schedules everything else.
    taints: [
        { key: "CriticalAddonsOnly", value: "true", effect: "NO_SCHEDULE" },
    ],
}, { dependsOn: [...nodePolicyAttachments, vpcCniAddon] });

// Karpenter access entry -----------------------------------------------------
//
// EC2_LINUX type implicitly grants system:nodes. AWS forbids
// AccessPolicyAssociation on non-STANDARD types, so this stands alone.
// https://docs.aws.amazon.com/eks/latest/userguide/access-policies.html

new aws.eks.AccessEntry(`${prefix}-node-entry`, {
    clusterName: cluster.name,
    principalArn: nodeRole.arn,
    type: "EC2_LINUX",
});
