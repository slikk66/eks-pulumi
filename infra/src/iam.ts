// IAM roles for in-cluster controllers.
//
// IRSA roles (OIDC web-identity trust):
//   - aws-load-balancer-controller          (kube-system)
//   - ebs-csi-controller-sa                 (kube-system)
//   - efs-csi-controller-sa                 (kube-system)
//   - external-secrets                      (external-secrets)
//   - fluent-bit                            (amazon-cloudwatch)
//
// Pod Identity role (pods.eks.amazonaws.com Service trust):
//   - karpenter                             (kube-system)
//
// Karpenter chart v1.12+ supports Pod Identity natively, sidestepping the
// IRSA OIDC dance. The Pod Identity *Association* itself lives in
// karpenter-aws.ts (alongside the SQS queue it depends on).
// https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import {
    prefix,
    region,
    externalSecretsAllowedSecretArns,
} from "../pulumi.config";
import { oidcProvider, clusterName } from "./cluster";
import { nodeRoleArn } from "./nodegroup";

const accountId = aws.getCallerIdentityOutput().accountId;
const partition = "aws";

// IRSA helper ----------------------------------------------------------------
//
// Builds the OIDC web-identity trust policy. The OIDC issuer URL has its
// https:// prefix stripped before use as the IAM condition key prefix
// (the issuer host is the actual key namespace).
// https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts-technical-overview.html

function irsaRole(
    name: string,
    namespace: string,
    serviceAccount: string,
): aws.iam.Role {
    const assumeRolePolicy = pulumi
        .all([oidcProvider.arn, oidcProvider.url])
        .apply(([arn, url]) => {
            const issuer = url.replace(/^https:\/\//, "");
            return JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Principal: { Federated: arn },
                    Action: "sts:AssumeRoleWithWebIdentity",
                    Condition: {
                        StringEquals: {
                            [`${issuer}:sub`]:
                                `system:serviceaccount:${namespace}:${serviceAccount}`,
                            [`${issuer}:aud`]: "sts.amazonaws.com",
                        },
                    },
                }],
            });
        });

    return new aws.iam.Role(`${prefix}-${name}-role`, {
        name: `${prefix}-${name}-role`,
        assumeRolePolicy,
    });
}

// Pod Identity helper --------------------------------------------------------
//
// Service trust on pods.eks.amazonaws.com with sts:AssumeRole + sts:TagSession
// (TagSession is required to carry the cluster/namespace/SA tags that the
// Pod Identity agent injects into the assumed session).

function podIdentityRole(name: string): aws.iam.Role {
    const assumeRolePolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "pods.eks.amazonaws.com" },
            Action: ["sts:AssumeRole", "sts:TagSession"],
        }],
    });

    return new aws.iam.Role(`${prefix}-${name}-role`, {
        name: `${prefix}-${name}-role`,
        assumeRolePolicy,
    });
}

// ALB Controller -------------------------------------------------------------
//
// Policy fetched at IMPLEMENT time (2026-05-05) from kubernetes-sigs upstream:
// https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json

const albControllerPolicyDoc = {
    Version: "2012-10-17",
    Statement: [
        {
            Effect: "Allow",
            Action: ["iam:CreateServiceLinkedRole"],
            Resource: "*",
            Condition: {
                StringEquals: {
                    "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com",
                },
            },
        },
        {
            Effect: "Allow",
            Action: [
                "ec2:DescribeAccountAttributes",
                "ec2:DescribeAddresses",
                "ec2:DescribeAvailabilityZones",
                "ec2:DescribeInternetGateways",
                "ec2:DescribeVpcs",
                "ec2:DescribeVpcPeeringConnections",
                "ec2:DescribeSubnets",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeInstances",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DescribeTags",
                "ec2:GetCoipPoolUsage",
                "ec2:DescribeCoipPools",
                "ec2:GetSecurityGroupsForVpc",
                "ec2:DescribeIpamPools",
                "ec2:DescribeRouteTables",
                "elasticloadbalancing:DescribeLoadBalancers",
                "elasticloadbalancing:DescribeLoadBalancerAttributes",
                "elasticloadbalancing:DescribeListeners",
                "elasticloadbalancing:DescribeListenerCertificates",
                "elasticloadbalancing:DescribeSSLPolicies",
                "elasticloadbalancing:DescribeRules",
                "elasticloadbalancing:DescribeTargetGroups",
                "elasticloadbalancing:DescribeTargetGroupAttributes",
                "elasticloadbalancing:DescribeTargetHealth",
                "elasticloadbalancing:DescribeTags",
                "elasticloadbalancing:DescribeTrustStores",
                "elasticloadbalancing:DescribeListenerAttributes",
                "elasticloadbalancing:DescribeCapacityReservation",
            ],
            Resource: "*",
        },
        {
            Effect: "Allow",
            Action: [
                "cognito-idp:DescribeUserPoolClient",
                "acm:ListCertificates",
                "acm:DescribeCertificate",
                "iam:ListServerCertificates",
                "iam:GetServerCertificate",
                "waf-regional:GetWebACL",
                "waf-regional:GetWebACLForResource",
                "waf-regional:AssociateWebACL",
                "waf-regional:DisassociateWebACL",
                "wafv2:GetWebACL",
                "wafv2:GetWebACLForResource",
                "wafv2:AssociateWebACL",
                "wafv2:DisassociateWebACL",
                "shield:GetSubscriptionState",
                "shield:DescribeProtection",
                "shield:CreateProtection",
                "shield:DeleteProtection",
            ],
            Resource: "*",
        },
        {
            Effect: "Allow",
            Action: [
                "ec2:AuthorizeSecurityGroupIngress",
                "ec2:RevokeSecurityGroupIngress",
            ],
            Resource: "*",
        },
        {
            Effect: "Allow",
            Action: ["ec2:CreateSecurityGroup"],
            Resource: "*",
        },
        {
            Effect: "Allow",
            Action: ["ec2:CreateTags"],
            Resource: "arn:aws:ec2:*:*:security-group/*",
            Condition: {
                StringEquals: { "ec2:CreateAction": "CreateSecurityGroup" },
                Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "false" },
            },
        },
        {
            Effect: "Allow",
            Action: ["ec2:CreateTags", "ec2:DeleteTags"],
            Resource: "arn:aws:ec2:*:*:security-group/*",
            Condition: {
                Null: {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                    "aws:ResourceTag/elbv2.k8s.aws/cluster": "false",
                },
            },
        },
        {
            Effect: "Allow",
            Action: [
                "ec2:AuthorizeSecurityGroupIngress",
                "ec2:RevokeSecurityGroupIngress",
                "ec2:DeleteSecurityGroup",
            ],
            Resource: "*",
            Condition: {
                Null: { "aws:ResourceTag/elbv2.k8s.aws/cluster": "false" },
            },
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:CreateLoadBalancer",
                "elasticloadbalancing:CreateTargetGroup",
            ],
            Resource: "*",
            Condition: {
                Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "false" },
            },
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:CreateListener",
                "elasticloadbalancing:DeleteListener",
                "elasticloadbalancing:CreateRule",
                "elasticloadbalancing:DeleteRule",
            ],
            Resource: "*",
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:AddTags",
                "elasticloadbalancing:RemoveTags",
            ],
            Resource: [
                "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
            ],
            Condition: {
                Null: {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                    "aws:ResourceTag/elbv2.k8s.aws/cluster": "false",
                },
            },
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:AddTags",
                "elasticloadbalancing:RemoveTags",
            ],
            Resource: [
                "arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
                "arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
                "arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
                "arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*",
            ],
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:ModifyLoadBalancerAttributes",
                "elasticloadbalancing:SetIpAddressType",
                "elasticloadbalancing:SetSecurityGroups",
                "elasticloadbalancing:SetSubnets",
                "elasticloadbalancing:DeleteLoadBalancer",
                "elasticloadbalancing:ModifyTargetGroup",
                "elasticloadbalancing:ModifyTargetGroupAttributes",
                "elasticloadbalancing:DeleteTargetGroup",
                "elasticloadbalancing:ModifyListenerAttributes",
                "elasticloadbalancing:ModifyCapacityReservation",
                "elasticloadbalancing:ModifyIpPools",
            ],
            Resource: "*",
            Condition: {
                Null: { "aws:ResourceTag/elbv2.k8s.aws/cluster": "false" },
            },
        },
        {
            Effect: "Allow",
            Action: ["elasticloadbalancing:AddTags"],
            Resource: [
                "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
            ],
            Condition: {
                StringEquals: {
                    "elasticloadbalancing:CreateAction": [
                        "CreateTargetGroup",
                        "CreateLoadBalancer",
                    ],
                },
                Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "false" },
            },
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:RegisterTargets",
                "elasticloadbalancing:DeregisterTargets",
            ],
            Resource: "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
        },
        {
            Effect: "Allow",
            Action: [
                "elasticloadbalancing:SetWebAcl",
                "elasticloadbalancing:ModifyListener",
                "elasticloadbalancing:AddListenerCertificates",
                "elasticloadbalancing:RemoveListenerCertificates",
                "elasticloadbalancing:ModifyRule",
                "elasticloadbalancing:SetRulePriorities",
            ],
            Resource: "*",
        },
    ],
};

const albRole = irsaRole(
    "alb-controller",
    "kube-system",
    "aws-load-balancer-controller",
);

const albPolicy = new aws.iam.Policy(`${prefix}-alb-controller-policy`, {
    name: `${prefix}-alb-controller-policy`,
    policy: JSON.stringify(albControllerPolicyDoc),
});

new aws.iam.RolePolicyAttachment(`${prefix}-alb-controller-attach`, {
    role: albRole.name,
    policyArn: albPolicy.arn,
});

// EBS CSI --------------------------------------------------------------------
// AWS-managed policy. Service-role variant scopes to volumes tagged for the
// CSI driver.
// https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html

const ebsRole = irsaRole(
    "ebs-csi",
    "kube-system",
    "ebs-csi-controller-sa",
);

new aws.iam.RolePolicyAttachment(`${prefix}-ebs-csi-attach`, {
    role: ebsRole.name,
    policyArn:
        "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
});

// EFS CSI --------------------------------------------------------------------
// Inline policy: describe + access-point lifecycle (tag-scoped to the
// efs.csi.aws.com/cluster=true tag).
// https://github.com/kubernetes-sigs/aws-efs-csi-driver/blob/master/docs/iam-policy-example.json

const efsCsiPolicyDoc = {
    Version: "2012-10-17",
    Statement: [
        {
            Effect: "Allow",
            Action: [
                "elasticfilesystem:DescribeAccessPoints",
                "elasticfilesystem:DescribeFileSystems",
                "elasticfilesystem:DescribeMountTargets",
                "ec2:DescribeAvailabilityZones",
            ],
            Resource: "*",
        },
        {
            Effect: "Allow",
            Action: ["elasticfilesystem:CreateAccessPoint"],
            Resource: "*",
            Condition: {
                StringLike: {
                    "aws:RequestTag/efs.csi.aws.com/cluster": "true",
                },
            },
        },
        {
            Effect: "Allow",
            Action: ["elasticfilesystem:TagResource"],
            Resource: "*",
            Condition: {
                StringLike: {
                    "aws:ResourceTag/efs.csi.aws.com/cluster": "true",
                },
            },
        },
        {
            Effect: "Allow",
            Action: "elasticfilesystem:DeleteAccessPoint",
            Resource: "*",
            Condition: {
                StringEquals: {
                    "aws:ResourceTag/efs.csi.aws.com/cluster": "true",
                },
            },
        },
    ],
};

const efsRole = irsaRole(
    "efs-csi",
    "kube-system",
    "efs-csi-controller-sa",
);

new aws.iam.RolePolicy(`${prefix}-efs-csi-policy`, {
    name: `${prefix}-efs-csi-policy`,
    role: efsRole.name,
    policy: JSON.stringify(efsCsiPolicyDoc),
});

// External Secrets ----------------------------------------------------------
//
// Scoped IRSA: the controller can read only secrets in the configured
// allow-list. Empty config (default) → single-element glob
// `secret:<prefix>-*`, which catches AWS's 6-char random suffix on every
// Secrets Manager ARN. Populated config → literal ARN list (no glob added).
//
// kms:Decrypt is scoped to the AWS-managed default Secrets Manager key alias
// (alias/aws/secretsmanager). Customer-managed KMS keys are NOT supported
// here — add a separate config field if required (do not regress to "*").
//
// https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html
// https://docs.aws.amazon.com/kms/latest/developerguide/alias-authorization.html
// https://external-secrets.io/main/provider/aws-secrets-manager/

const externalSecretsRole = irsaRole(
    "external-secrets",
    "external-secrets",
    "external-secrets",
);

const externalSecretsPolicyDoc = pulumi
    .all([region, accountId])
    .apply(([reg, acct]) => {
        const secretArns = externalSecretsAllowedSecretArns.length > 0
            ? externalSecretsAllowedSecretArns
            : [`arn:${partition}:secretsmanager:${reg}:${acct}:secret:${prefix}-*`];
        return JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "secretsmanager:GetSecretValue",
                        "secretsmanager:DescribeSecret",
                    ],
                    Resource: secretArns,
                },
                {
                    Effect: "Allow",
                    Action: ["kms:Decrypt"],
                    Resource:
                        `arn:${partition}:kms:${reg}:${acct}:alias/aws/secretsmanager`,
                },
            ],
        });
    });

new aws.iam.RolePolicy(`${prefix}-external-secrets-policy`, {
    name: `${prefix}-external-secrets-policy`,
    role: externalSecretsRole.name,
    policy: externalSecretsPolicyDoc,
});

// Fluent Bit ----------------------------------------------------------------
// CloudWatchAgentServerPolicy is the canonical managed policy for log/metric
// shippers (covers logs:Put + cwagent + xray).
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Observability-EKS-addon.html

const fluentBitRole = irsaRole(
    "fluent-bit",
    "amazon-cloudwatch",
    "fluent-bit",
);

new aws.iam.RolePolicyAttachment(`${prefix}-fluent-bit-attach`, {
    role: fluentBitRole.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

// Karpenter controller (Pod Identity) ---------------------------------------
//
// Controller policy fetched at IMPLEMENT time (2026-05-05) from
// karpenter.sh, version v1.12 (latest):
// https://karpenter.sh/docs/reference/cloudformation/
//
// CloudFormation source maps these statements across six managed policies
// (NodeLifecycle / IAMIntegration / EKSIntegration / Interruption /
// ResourceDiscovery / ZonalShift). They're combined into one inline policy
// here for brevity. ZonalShift is omitted (the optional zonal-shift
// integration is not enabled in this stack).
//
// The interruption queue ARN is constructed from prefix + region + account
// rather than imported from karpenter-aws.ts to avoid a circular import.
// The queue is created with a deterministic name in karpenter-aws.ts.

const karpenterRole = podIdentityRole("karpenter-controller");

const karpenterControllerPolicyDoc = pulumi
    .all([region, accountId, clusterName, nodeRoleArn])
    .apply(([reg, acct, cluster, nodeArn]) => {
        const interruptionQueueArn =
            `arn:${partition}:sqs:${reg}:${acct}:${prefix}-karpenter-interruption`;
        return JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Sid: "AllowScopedEC2InstanceAccessActions",
                    Effect: "Allow",
                    Resource: [
                        `arn:${partition}:ec2:${reg}::image/*`,
                        `arn:${partition}:ec2:${reg}::snapshot/*`,
                        `arn:${partition}:ec2:${reg}:*:security-group/*`,
                        `arn:${partition}:ec2:${reg}:*:subnet/*`,
                        `arn:${partition}:ec2:${reg}:*:capacity-reservation/*`,
                        `arn:${partition}:ec2:${reg}:*:placement-group/*`,
                    ],
                    Action: ["ec2:RunInstances", "ec2:CreateFleet"],
                },
                {
                    Sid: "AllowScopedEC2LaunchTemplateAccessActions",
                    Effect: "Allow",
                    Resource: `arn:${partition}:ec2:${reg}:*:launch-template/*`,
                    Action: ["ec2:RunInstances", "ec2:CreateFleet"],
                    Condition: {
                        StringEquals: {
                            [`aws:ResourceTag/kubernetes.io/cluster/${cluster}`]: "owned",
                        },
                        StringLike: {
                            "aws:ResourceTag/karpenter.sh/nodepool": "*",
                        },
                    },
                },
                {
                    Sid: "AllowScopedEC2InstanceActionsWithTags",
                    Effect: "Allow",
                    Resource: [
                        `arn:${partition}:ec2:${reg}:*:fleet/*`,
                        `arn:${partition}:ec2:${reg}:*:instance/*`,
                        `arn:${partition}:ec2:${reg}:*:volume/*`,
                        `arn:${partition}:ec2:${reg}:*:network-interface/*`,
                        `arn:${partition}:ec2:${reg}:*:launch-template/*`,
                        `arn:${partition}:ec2:${reg}:*:spot-instances-request/*`,
                    ],
                    Action: [
                        "ec2:RunInstances",
                        "ec2:CreateFleet",
                        "ec2:CreateLaunchTemplate",
                    ],
                    Condition: {
                        StringEquals: {
                            [`aws:RequestTag/kubernetes.io/cluster/${cluster}`]: "owned",
                            "aws:RequestTag/eks:eks-cluster-name": cluster,
                        },
                        StringLike: {
                            "aws:RequestTag/karpenter.sh/nodepool": "*",
                        },
                    },
                },
                {
                    Sid: "AllowScopedResourceCreationTagging",
                    Effect: "Allow",
                    Resource: [
                        `arn:${partition}:ec2:${reg}:*:fleet/*`,
                        `arn:${partition}:ec2:${reg}:*:instance/*`,
                        `arn:${partition}:ec2:${reg}:*:volume/*`,
                        `arn:${partition}:ec2:${reg}:*:network-interface/*`,
                        `arn:${partition}:ec2:${reg}:*:launch-template/*`,
                        `arn:${partition}:ec2:${reg}:*:spot-instances-request/*`,
                    ],
                    Action: "ec2:CreateTags",
                    Condition: {
                        StringEquals: {
                            [`aws:RequestTag/kubernetes.io/cluster/${cluster}`]: "owned",
                            "aws:RequestTag/eks:eks-cluster-name": cluster,
                            "ec2:CreateAction": [
                                "RunInstances",
                                "CreateFleet",
                                "CreateLaunchTemplate",
                            ],
                        },
                        StringLike: {
                            "aws:RequestTag/karpenter.sh/nodepool": "*",
                        },
                    },
                },
                {
                    Sid: "AllowScopedResourceTagging",
                    Effect: "Allow",
                    Resource: `arn:${partition}:ec2:${reg}:*:instance/*`,
                    Action: "ec2:CreateTags",
                    Condition: {
                        StringEquals: {
                            [`aws:ResourceTag/kubernetes.io/cluster/${cluster}`]: "owned",
                        },
                        StringLike: {
                            "aws:ResourceTag/karpenter.sh/nodepool": "*",
                        },
                        StringEqualsIfExists: {
                            "aws:RequestTag/eks:eks-cluster-name": cluster,
                        },
                        "ForAllValues:StringEquals": {
                            "aws:TagKeys": [
                                "eks:eks-cluster-name",
                                "karpenter.sh/nodeclaim",
                                "Name",
                            ],
                        },
                    },
                },
                {
                    Sid: "AllowScopedDeletion",
                    Effect: "Allow",
                    Resource: [
                        `arn:${partition}:ec2:${reg}:*:instance/*`,
                        `arn:${partition}:ec2:${reg}:*:launch-template/*`,
                    ],
                    Action: [
                        "ec2:TerminateInstances",
                        "ec2:DeleteLaunchTemplate",
                    ],
                    Condition: {
                        StringEquals: {
                            [`aws:ResourceTag/kubernetes.io/cluster/${cluster}`]: "owned",
                        },
                        StringLike: {
                            "aws:ResourceTag/karpenter.sh/nodepool": "*",
                        },
                    },
                },
                {
                    Sid: "AllowRegionalReadActions",
                    Effect: "Allow",
                    Resource: "*",
                    Action: [
                        "ec2:DescribeCapacityReservations",
                        "ec2:DescribeImages",
                        "ec2:DescribeInstances",
                        "ec2:DescribeInstanceStatus",
                        "ec2:DescribeInstanceTypeOfferings",
                        "ec2:DescribeInstanceTypes",
                        "ec2:DescribeLaunchTemplates",
                        "ec2:DescribePlacementGroups",
                        "ec2:DescribeSecurityGroups",
                        "ec2:DescribeSpotPriceHistory",
                        "ec2:DescribeSubnets",
                    ],
                    Condition: {
                        StringEquals: { "aws:RequestedRegion": reg },
                    },
                },
                {
                    Sid: "AllowSSMReadActions",
                    Effect: "Allow",
                    Resource: `arn:${partition}:ssm:${reg}::parameter/aws/service/*`,
                    Action: "ssm:GetParameter",
                },
                {
                    Sid: "AllowPricingReadActions",
                    Effect: "Allow",
                    Resource: "*",
                    Action: "pricing:GetProducts",
                },
                {
                    Sid: "AllowInterruptionQueueActions",
                    Effect: "Allow",
                    Resource: interruptionQueueArn,
                    Action: [
                        "sqs:DeleteMessage",
                        "sqs:GetQueueUrl",
                        "sqs:ReceiveMessage",
                    ],
                },
                {
                    Sid: "AllowPassingInstanceRole",
                    Effect: "Allow",
                    Resource: nodeArn,
                    Action: "iam:PassRole",
                    Condition: {
                        StringEquals: {
                            "iam:PassedToService": [
                                "ec2.amazonaws.com",
                                "ec2.amazonaws.com.cn",
                            ],
                        },
                    },
                },
                {
                    Sid: "AllowScopedInstanceProfileCreationActions",
                    Effect: "Allow",
                    Resource: `arn:${partition}:iam::${acct}:instance-profile/*`,
                    Action: ["iam:CreateInstanceProfile"],
                    Condition: {
                        StringEquals: {
                            [`aws:RequestTag/kubernetes.io/cluster/${cluster}`]: "owned",
                            "aws:RequestTag/eks:eks-cluster-name": cluster,
                            "aws:RequestTag/topology.kubernetes.io/region": reg,
                        },
                        StringLike: {
                            "aws:RequestTag/karpenter.k8s.aws/ec2nodeclass": "*",
                        },
                    },
                },
                {
                    Sid: "AllowScopedInstanceProfileTagActions",
                    Effect: "Allow",
                    Resource: `arn:${partition}:iam::${acct}:instance-profile/*`,
                    Action: ["iam:TagInstanceProfile"],
                    Condition: {
                        StringEquals: {
                            [`aws:ResourceTag/kubernetes.io/cluster/${cluster}`]: "owned",
                            "aws:ResourceTag/topology.kubernetes.io/region": reg,
                            [`aws:RequestTag/kubernetes.io/cluster/${cluster}`]: "owned",
                            "aws:RequestTag/eks:eks-cluster-name": cluster,
                            "aws:RequestTag/topology.kubernetes.io/region": reg,
                        },
                        StringLike: {
                            "aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass": "*",
                            "aws:RequestTag/karpenter.k8s.aws/ec2nodeclass": "*",
                        },
                    },
                },
                {
                    Sid: "AllowScopedInstanceProfileActions",
                    Effect: "Allow",
                    Resource: `arn:${partition}:iam::${acct}:instance-profile/*`,
                    Action: [
                        "iam:AddRoleToInstanceProfile",
                        "iam:RemoveRoleFromInstanceProfile",
                        "iam:DeleteInstanceProfile",
                    ],
                    Condition: {
                        StringEquals: {
                            [`aws:ResourceTag/kubernetes.io/cluster/${cluster}`]: "owned",
                            "aws:ResourceTag/topology.kubernetes.io/region": reg,
                        },
                        StringLike: {
                            "aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass": "*",
                        },
                    },
                },
                {
                    Sid: "AllowInstanceProfileReadActions",
                    Effect: "Allow",
                    Resource: `arn:${partition}:iam::${acct}:instance-profile/*`,
                    Action: "iam:GetInstanceProfile",
                },
                {
                    Sid: "AllowUnscopedInstanceProfileListAction",
                    Effect: "Allow",
                    Resource: "*",
                    Action: "iam:ListInstanceProfiles",
                },
                {
                    Sid: "AllowAPIServerEndpointDiscovery",
                    Effect: "Allow",
                    Resource: `arn:${partition}:eks:${reg}:${acct}:cluster/${cluster}`,
                    Action: "eks:DescribeCluster",
                },
            ],
        });
    });

new aws.iam.RolePolicy(`${prefix}-karpenter-controller-policy`, {
    name: `${prefix}-karpenter-controller-policy`,
    role: karpenterRole.name,
    policy: karpenterControllerPolicyDoc,
});

// Exports --------------------------------------------------------------------

export const albControllerRoleArn: pulumi.Output<string> = albRole.arn;
export const ebsCsiRoleArn: pulumi.Output<string> = ebsRole.arn;
export const efsCsiRoleArn: pulumi.Output<string> = efsRole.arn;
export const externalSecretsRoleArn: pulumi.Output<string> =
    externalSecretsRole.arn;
export const fluentBitRoleArn: pulumi.Output<string> = fluentBitRole.arn;
export const karpenterControllerRoleArn: pulumi.Output<string> =
    karpenterRole.arn;
