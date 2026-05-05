// EKS cluster — raw aws.eks.* resources (NOT @pulumi/eks v4 wrapper, which
// bundles defaults that fight our minimal-bootstrap pattern).
//
// What this file owns:
//   - Cluster IAM role (eks.amazonaws.com trust + AmazonEKSClusterPolicy)
//   - Cluster security group (ingress 443 from VPC CIDR; tagged for Karpenter
//     NodeClass discovery)
//   - aws.eks.Cluster (private endpoint, auth mode: API)
//   - aws.iam.OpenIdConnectProvider (issuer derived from cluster output)
//   - 3 managed addons (kube-proxy, coredns, eks-pod-identity-agent) — versions
//     resolved from the EKS API per cluster Kubernetes version
//   - Admin AccessEntry + AmazonEKSClusterAdminPolicy association
//
// What lives in nodegroup.ts (intentional split — vpc-cni and the Karpenter
// access entry both depend on node-group outputs, and the node group depends
// on cluster outputs; placing them in the same file as the node group breaks
// what would otherwise be a TS circular import).

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import {
    prefix,
    clusterName as clusterNameStr,
    kubernetesVersion,
    adminRoleArn,
} from "../pulumi.config";
import { vpcId, vpcCidrBlock, publicSubnetIds, privateSubnetIds } from "./vpc";

// Cluster IAM role -----------------------------------------------------------

const clusterRole = new aws.iam.Role(`${prefix}-cluster-role`, {
    name: `${prefix}-cluster-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                // sts:TagSession is required alongside sts:AssumeRole on new
                // EKS service-role trust policies.
                // https://docs.aws.amazon.com/eks/latest/userguide/service_IAM_role.html
                Action: ["sts:AssumeRole", "sts:TagSession"],
                Effect: "Allow",
                Principal: { Service: "eks.amazonaws.com" },
            },
        ],
    }),
});

const clusterPolicyAttachment = new aws.iam.RolePolicyAttachment(
    `${prefix}-cluster-policy`,
    {
        role: clusterRole.name,
        policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    },
);

// Cluster security group -----------------------------------------------------
//
// Karpenter NodeClass selectors discover this SG by the karpenter.sh/discovery
// tag and attach it to launched EC2 instances. The cluster also references it
// in vpcConfig.securityGroupIds so VPN clients can hit the API on 443.
// https://karpenter.sh/docs/concepts/nodeclasses/#specsecuritygroupselectorterms

const clusterSg = new aws.ec2.SecurityGroup(`${prefix}-cluster-sg`, {
    name: `${prefix}-cluster-sg`,
    vpcId: vpcId,
    description: "EKS cluster + node SG (Karpenter-discovered)",
    tags: {
        Name: `${prefix}-cluster-sg`,
        "karpenter.sh/discovery": clusterNameStr,
    },
});

new aws.vpc.SecurityGroupIngressRule(`${prefix}-cluster-sg-https`, {
    securityGroupId: clusterSg.id,
    ipProtocol: "tcp",
    fromPort: 443,
    toPort: 443,
    cidrIpv4: vpcCidrBlock,
    description: "HTTPS from in-VPC clients (incl. Client VPN)",
});

// All-traffic egress: this SG also rides Karpenter-launched nodes via discovery
// tag, so nodes need outbound internet (ECR, EKS API, addons) to bootstrap.
new aws.vpc.SecurityGroupEgressRule(`${prefix}-cluster-sg-egress`, {
    securityGroupId: clusterSg.id,
    ipProtocol: "-1",
    cidrIpv4: "0.0.0.0/0",
    description: "All egress",
});

// EKS cluster ----------------------------------------------------------------

export const cluster = new aws.eks.Cluster(`${prefix}-cluster`, {
    name: clusterNameStr,
    version: kubernetesVersion,
    roleArn: clusterRole.arn,
    accessConfig: {
        authenticationMode: "API",
    },
    vpcConfig: {
        // Both subnet sets so EKS places control-plane ENIs across all 3 AZs
        // regardless of enableNat. Worker subnet selection is in nodegroup.ts.
        subnetIds: pulumi
            .all([publicSubnetIds, privateSubnetIds])
            .apply(([pub, priv]) => [...pub, ...priv]),
        securityGroupIds: [clusterSg.id],
        endpointPrivateAccess: true,
        endpointPublicAccess: false,
    },
}, {
    dependsOn: [clusterPolicyAttachment],
});

// OIDC provider --------------------------------------------------------------
//
// IRSA is mandatory for ALB Controller, EBS-CSI, EFS-CSI, and VPC-CNI.
// thumbprintLists is empty: EKS uses an Amazon S3-hosted JWKS endpoint, so AWS
// validates with its own trusted root CAs and ignores any configured
// thumbprints.
// https://repost.aws/questions/QUqnijJ8BxSFOUgUeW8fg-Fg/oidc-provider-thumbprints-optional

export const oidcProvider = new aws.iam.OpenIdConnectProvider(
    `${prefix}-oidc`,
    {
        url: cluster.identities.apply(ids => ids[0].oidcs[0].issuer),
        clientIdLists: ["sts.amazonaws.com"],
        thumbprintLists: [],
    },
);

// Admin access entry ---------------------------------------------------------

const adminAccessEntry = new aws.eks.AccessEntry(`${prefix}-admin-entry`, {
    clusterName: cluster.name,
    principalArn: adminRoleArn,
    type: "STANDARD",
});

new aws.eks.AccessPolicyAssociation(`${prefix}-admin-policy`, {
    clusterName: cluster.name,
    principalArn: adminRoleArn,
    policyArn:
        "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
    accessScope: { type: "cluster" },
}, { dependsOn: [adminAccessEntry] });

// Managed addons (3 of 4 — vpc-cni lives in nodegroup.ts) --------------------
//
// addonVersion comes from the EKS API per cluster.version (no pinned strings;
// versions track the cluster on minor upgrades). resolveConflicts: OVERWRITE
// on both create and update — Pulumi is the source of truth for these addons.

function managedAddon(localName: string, addonName: string): aws.eks.Addon {
    const v = aws.eks.getAddonVersionOutput({
        addonName,
        kubernetesVersion: cluster.version,
        mostRecent: true,
    });
    return new aws.eks.Addon(`${prefix}-${localName}`, {
        clusterName: cluster.name,
        addonName,
        addonVersion: v.version,
        resolveConflictsOnCreate: "OVERWRITE",
        resolveConflictsOnUpdate: "OVERWRITE",
    });
}

managedAddon("kube-proxy", "kube-proxy");
managedAddon("coredns", "coredns");
managedAddon("pod-identity-agent", "eks-pod-identity-agent");

// Exports --------------------------------------------------------------------

export const clusterName: pulumi.Output<string> = cluster.name;
export const clusterEndpoint: pulumi.Output<string> = cluster.endpoint;
export const clusterCertificateAuthorityData: pulumi.Output<string> =
    cluster.certificateAuthority.apply(ca => ca.data);
export const clusterSecurityGroupId: pulumi.Output<string> = clusterSg.id;
