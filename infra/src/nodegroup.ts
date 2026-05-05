// EKS managed node group — Bottlerocket m7a.large × 2 with the
// CriticalAddonsOnly taint. Hosts only system pods + ArgoCD + Karpenter
// controller; everything else is scheduled by Karpenter onto NodePool-managed
// nodes (which reuse the same node IAM role via the EC2_LINUX access entry
// below).
//
// Also owns:
//   - Karpenter EC2_LINUX access entry. NO AccessPolicyAssociation — AWS
//     forbids policy associations on non-STANDARD types; the bare EC2_LINUX
//     entry implicitly grants system:nodes.
//     https://docs.aws.amazon.com/eks/latest/userguide/access-policies.html
//   - vpc-cni managed addon (dependsOn the node group so nodes exist before
//     the CNI configures them; placing it here keeps cluster.ts free of
//     reverse imports from nodegroup.ts).

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { prefix, enableNat } from "../pulumi.config";
import { publicSubnetIds, privateSubnetIds } from "./vpc";
import { cluster } from "./cluster";

// Node IAM role --------------------------------------------------------------

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

const nodeManagedPolicies = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
];

const nodePolicyAttachments = nodeManagedPolicies.map(
    policyArn =>
        new aws.iam.RolePolicyAttachment(
            `${prefix}-node-${policyArn.split("/").pop()}`,
            {
                role: nodeRole.name,
                policyArn,
            },
        ),
);

export const nodeRoleArn: pulumi.Output<string> = nodeRole.arn;

// Node group -----------------------------------------------------------------

const workerSubnetIds = enableNat ? privateSubnetIds : publicSubnetIds;

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
}, { dependsOn: nodePolicyAttachments });

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

// vpc-cni addon --------------------------------------------------------------

const vpcCniVersion = aws.eks.getAddonVersionOutput({
    addonName: "vpc-cni",
    kubernetesVersion: cluster.version,
    mostRecent: true,
});

new aws.eks.Addon(`${prefix}-vpc-cni`, {
    clusterName: cluster.name,
    addonName: "vpc-cni",
    addonVersion: vpcCniVersion.version,
    resolveConflictsOnCreate: "OVERWRITE",
    resolveConflictsOnUpdate: "OVERWRITE",
}, { dependsOn: [nodeGroup] });
