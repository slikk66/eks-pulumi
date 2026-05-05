// IAM roles for in-cluster controllers.
//
// IRSA roles (OIDC web-identity trust):
//   - aws-load-balancer-controller          (kube-system)
//   - aws-node                              (kube-system)        [vpc-cni]
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
import { vpcId } from "./vpc";

const accountId = aws.getCallerIdentityOutput().accountId;

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

// ALB Controller -------------------------------------------------------------
//
// Base policy fetched at IMPLEMENT time (2026-05-05) from kubernetes-sigs
// upstream:
//   https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
//
// Tightenings vs upstream (defense-in-depth, single-cluster stack):
//   - SLR Resource narrowed to elasticloadbalancing service-role path.
//   - SG Authorize/Revoke/Create fallbacks bound to this VPC via ec2:Vpc.
//   - Mutating ELB actions (CreateLB/CreateTG, listener-rule Delete, AddTags
//     on listener/listener-rule, RegisterTargets, Modify*/Set*) bound to
//     aws:ResourceTag/elbv2.k8s.aws/cluster = ${clusterName} (was Null:false
//     or unscoped). CreateListener/CreateRule remain unscoped — child ARN
//     does not exist at request time.
//   - EC2/ELBv2 Describe* and ACM/IAM/WAF/Shield/Cognito lookups keep
//     Resource:"*" because per the AWS Service Authorization Reference
//     these actions do not support resource-level permissions.

const albControllerPolicyDoc = pulumi
    .all([clusterName, vpcId, region, accountId])
    .apply(([cluster, vpc, reg, acct]) => {
        const vpcArn = `arn:aws:ec2:${reg}:${acct}:vpc/${vpc}`;
        return JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["iam:CreateServiceLinkedRole"],
                    Resource:
                        `arn:aws:iam::*:role/aws-service-role/elasticloadbalancing.amazonaws.com/*`,
                    Condition: {
                        StringEquals: {
                            "iam:AWSServiceName":
                                "elasticloadbalancing.amazonaws.com",
                        },
                    },
                },
                {
                    // Resource:"*" required — EC2/ELBv2 Describe* lack
                    // resource-level perms per AWS docs.
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
                    // Resource:"*" required — ACM/IAM cert listing, WAF
                    // lookup-for-resource, Shield subscription state, Cognito
                    // user-pool describe lack resource-level perms or operate
                    // on user-supplied ARNs not enumerable at policy-write
                    // time.
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
                    // Bound to this VPC; closes cross-VPC blast radius.
                    Effect: "Allow",
                    Action: [
                        "ec2:AuthorizeSecurityGroupIngress",
                        "ec2:RevokeSecurityGroupIngress",
                    ],
                    Resource: "*",
                    Condition: {
                        ArnEquals: { "ec2:Vpc": vpcArn },
                    },
                },
                {
                    Effect: "Allow",
                    Action: ["ec2:CreateSecurityGroup"],
                    Resource: "*",
                    Condition: {
                        ArnEquals: { "ec2:Vpc": vpcArn },
                    },
                },
                {
                    // RequestTag bound to cluster (was Null:false).
                    Effect: "Allow",
                    Action: ["ec2:CreateTags"],
                    Resource: `arn:aws:ec2:*:*:security-group/*`,
                    Condition: {
                        StringEquals: {
                            "ec2:CreateAction": "CreateSecurityGroup",
                            "aws:RequestTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // ResourceTag bound to cluster (was Null:false).
                    Effect: "Allow",
                    Action: ["ec2:CreateTags", "ec2:DeleteTags"],
                    Resource: `arn:aws:ec2:*:*:security-group/*`,
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                        Null: {
                            "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                        },
                    },
                },
                {
                    // ResourceTag bound to cluster (was Null:false).
                    Effect: "Allow",
                    Action: [
                        "ec2:AuthorizeSecurityGroupIngress",
                        "ec2:RevokeSecurityGroupIngress",
                        "ec2:DeleteSecurityGroup",
                    ],
                    Resource: "*",
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // Bound to this cluster's tag value (was Null:false).
                    Effect: "Allow",
                    Action: [
                        "elasticloadbalancing:CreateLoadBalancer",
                        "elasticloadbalancing:CreateTargetGroup",
                    ],
                    Resource: "*",
                    Condition: {
                        StringEquals: {
                            "aws:RequestTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // Resource:"*" — child ARN does not exist at request
                    // time. RequestTag bound to cluster: ALB Controller
                    // v2.5+ tags listener/listener-rule at create with
                    // elbv2.k8s.aws/cluster=<clusterName> when
                    // --cluster-name is set (chart default). Ref:
                    // https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
                    Effect: "Allow",
                    Action: [
                        "elasticloadbalancing:CreateListener",
                        "elasticloadbalancing:CreateRule",
                    ],
                    Resource: "*",
                    Condition: {
                        StringEquals: {
                            "aws:RequestTag/elbv2.k8s.aws/cluster": cluster,
                        },
                        Null: {
                            "aws:RequestTag/elbv2.k8s.aws/cluster": "false",
                        },
                    },
                },
                {
                    // Delete listener / rule scoped to listener and listener-
                    // rule ARNs with cluster-tag condition.
                    Effect: "Allow",
                    Action: [
                        "elasticloadbalancing:DeleteListener",
                        "elasticloadbalancing:DeleteRule",
                    ],
                    Resource: [
                        `arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*`,
                    ],
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // ResourceTag bound to cluster (was Null:false).
                    Effect: "Allow",
                    Action: [
                        "elasticloadbalancing:AddTags",
                        "elasticloadbalancing:RemoveTags",
                    ],
                    Resource: [
                        `arn:aws:elasticloadbalancing:*:*:targetgroup/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*`,
                    ],
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                        Null: {
                            "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                        },
                    },
                },
                {
                    // Listener / listener-rule AddTags/RemoveTags bound to
                    // cluster on both ResourceTag and RequestTag. ALB
                    // Controller v2.5+ includes elbv2.k8s.aws/cluster=
                    // <clusterName> in AddTags requests (same default tag
                    // it sets at create — see CreateListener stmt above).
                    // https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
                    Effect: "Allow",
                    Action: [
                        "elasticloadbalancing:AddTags",
                        "elasticloadbalancing:RemoveTags",
                    ],
                    Resource: [
                        `arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*`,
                    ],
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                            "aws:RequestTag/elbv2.k8s.aws/cluster": cluster,
                        },
                        Null: {
                            "aws:RequestTag/elbv2.k8s.aws/cluster": "false",
                        },
                    },
                },
                {
                    // ResourceTag bound to cluster (was Null:false).
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
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // RequestTag bound to cluster (was Null:false).
                    Effect: "Allow",
                    Action: ["elasticloadbalancing:AddTags"],
                    Resource: [
                        `arn:aws:elasticloadbalancing:*:*:targetgroup/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*`,
                        `arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*`,
                    ],
                    Condition: {
                        StringEquals: {
                            "elasticloadbalancing:CreateAction": [
                                "CreateTargetGroup",
                                "CreateLoadBalancer",
                            ],
                            "aws:RequestTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // Now bound to cluster (was unscoped in upstream).
                    Effect: "Allow",
                    Action: [
                        "elasticloadbalancing:RegisterTargets",
                        "elasticloadbalancing:DeregisterTargets",
                    ],
                    Resource:
                        `arn:aws:elasticloadbalancing:*:*:targetgroup/*/*`,
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
                {
                    // Mixed resource types (LB / listener / listener-rule).
                    // Constrain by cluster-tag (was unscoped in upstream).
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
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/elbv2.k8s.aws/cluster": cluster,
                        },
                    },
                },
            ],
        });
    });

const albRole = irsaRole(
    "alb-controller",
    "kube-system",
    "aws-load-balancer-controller",
);

const albPolicy = new aws.iam.Policy(`${prefix}-alb-controller-policy`, {
    name: `${prefix}-alb-controller-policy`,
    policy: albControllerPolicyDoc,
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

// VPC CNI --------------------------------------------------------------------
// AWS-managed policy bound to the upstream `kube-system/aws-node` SA via
// IRSA. Without IRSA the policy lands on the node role and every pod on the
// node can mutate ENIs via the IMDS credential endpoint.
// https://docs.aws.amazon.com/eks/latest/userguide/cni-iam-role.html

const vpcCniRole = irsaRole(
    "vpc-cni",
    "kube-system",
    "aws-node",
);

new aws.iam.RolePolicyAttachment(`${prefix}-vpc-cni-attach`, {
    role: vpcCniRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
});

// EFS CSI --------------------------------------------------------------------
// Inline policy fetched at IMPLEMENT time (2026-05-05) from kubernetes-sigs:
//   https://github.com/kubernetes-sigs/aws-efs-csi-driver/blob/master/docs/iam-policy-example.json
//
// Tightenings vs upstream:
//   - TagResource and DeleteAccessPoint Resource narrowed from "*" to the
//     access-point ARN pattern (the driver only ever tags or deletes
//     access-points it created).
//   - efs.csi.aws.com/cluster tag value bound to clusterName (not literal
//     "true") so a neighbour EFS-CSI deployment in the same account
//     reusing the upstream tag does not share blast radius. REQUIRES the
//     GitOps repo's EFS-CSI chart to set
//     controller.tags.efs.csi.aws.com/cluster=<clusterName> so the driver
//     emits that value at access-point create time. Until that wiring
//     lands the access-point create flow is denied — defense-in-depth
//     fail-closed; tighten here, coordinate downstream.
//   - StringLike → StringEquals (no glob in tag value; consistency).
//   - Describe* keep Resource:"*" — EFS Describe* lacks resource-level
//     perms per AWS Service Authorization Reference.

const efsCsiPolicyDoc = pulumi
    .all([region, accountId, clusterName])
    .apply(([reg, acct, cluster]) => {
        const accessPointArn =
            `arn:aws:elasticfilesystem:${reg}:${acct}:access-point/*`;
        return JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    // Resource:"*" required — EFS Describe* and EC2
                    // DescribeAvailabilityZones lack resource-level perms.
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
                    // Resource:"*" required — access-point ARN does not exist
                    // at request time. Tag-on-create scoped via RequestTag
                    // bound to clusterName.
                    Effect: "Allow",
                    Action: ["elasticfilesystem:CreateAccessPoint"],
                    Resource: "*",
                    Condition: {
                        StringEquals: {
                            "aws:RequestTag/efs.csi.aws.com/cluster": cluster,
                        },
                    },
                },
                {
                    Effect: "Allow",
                    Action: ["elasticfilesystem:TagResource"],
                    Resource: accessPointArn,
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/efs.csi.aws.com/cluster": cluster,
                        },
                    },
                },
                {
                    Effect: "Allow",
                    Action: "elasticfilesystem:DeleteAccessPoint",
                    Resource: accessPointArn,
                    Condition: {
                        StringEquals: {
                            "aws:ResourceTag/efs.csi.aws.com/cluster": cluster,
                        },
                    },
                },
            ],
        });
    });

const efsRole = irsaRole(
    "efs-csi",
    "kube-system",
    "efs-csi-controller-sa",
);

new aws.iam.RolePolicy(`${prefix}-efs-csi-policy`, {
    name: `${prefix}-efs-csi-policy`,
    role: efsRole.name,
    policy: efsCsiPolicyDoc,
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
            : [`arn:aws:secretsmanager:${reg}:${acct}:secret:${prefix}-*`];
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
                        `arn:aws:kms:${reg}:${acct}:alias/aws/secretsmanager`,
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
// The interruption queue ARN and node role ARN are constructed from
// prefix + region + account rather than imported from karpenter-aws.ts /
// nodegroup.ts to avoid circular imports. The queue is created with a
// deterministic name in karpenter-aws.ts; the node role with a
// deterministic name in nodegroup.ts. Once vpc-cni's IRSA role is
// declared in this file (below), nodegroup.ts must import from iam.ts —
// importing back from nodegroup.ts here would close the cycle.

// Pod Identity trust: pods.eks.amazonaws.com with sts:AssumeRole + sts:TagSession
// (TagSession is required to carry the cluster/namespace/SA tags that the
// Pod Identity agent injects into the assumed session).
const karpenterRole = new aws.iam.Role(`${prefix}-karpenter-controller-role`, {
    name: `${prefix}-karpenter-controller-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "pods.eks.amazonaws.com" },
            Action: ["sts:AssumeRole", "sts:TagSession"],
        }],
    }),
});

const karpenterControllerPolicyDoc = pulumi
    .all([region, accountId, clusterName])
    .apply(([reg, acct, cluster]) => {
        const nodeArn =
            `arn:aws:iam::${acct}:role/${prefix}-node-role`;
        const interruptionQueueArn =
            `arn:aws:sqs:${reg}:${acct}:${prefix}-karpenter-interruption`;
        return JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Sid: "AllowScopedEC2InstanceAccessActions",
                    Effect: "Allow",
                    Resource: [
                        `arn:aws:ec2:${reg}::image/*`,
                        `arn:aws:ec2:${reg}::snapshot/*`,
                        `arn:aws:ec2:${reg}:*:security-group/*`,
                        `arn:aws:ec2:${reg}:*:subnet/*`,
                        `arn:aws:ec2:${reg}:*:capacity-reservation/*`,
                        `arn:aws:ec2:${reg}:*:placement-group/*`,
                    ],
                    Action: ["ec2:RunInstances", "ec2:CreateFleet"],
                },
                {
                    Sid: "AllowScopedEC2LaunchTemplateAccessActions",
                    Effect: "Allow",
                    Resource: `arn:aws:ec2:${reg}:*:launch-template/*`,
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
                        `arn:aws:ec2:${reg}:*:fleet/*`,
                        `arn:aws:ec2:${reg}:*:instance/*`,
                        `arn:aws:ec2:${reg}:*:volume/*`,
                        `arn:aws:ec2:${reg}:*:network-interface/*`,
                        `arn:aws:ec2:${reg}:*:launch-template/*`,
                        `arn:aws:ec2:${reg}:*:spot-instances-request/*`,
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
                        `arn:aws:ec2:${reg}:*:fleet/*`,
                        `arn:aws:ec2:${reg}:*:instance/*`,
                        `arn:aws:ec2:${reg}:*:volume/*`,
                        `arn:aws:ec2:${reg}:*:network-interface/*`,
                        `arn:aws:ec2:${reg}:*:launch-template/*`,
                        `arn:aws:ec2:${reg}:*:spot-instances-request/*`,
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
                    Resource: `arn:aws:ec2:${reg}:*:instance/*`,
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
                        `arn:aws:ec2:${reg}:*:instance/*`,
                        `arn:aws:ec2:${reg}:*:launch-template/*`,
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
                    // Karpenter only reads two SSM parameter trees for AMI
                    // discovery: EKS-optimised AL2/AL2023 and Bottlerocket
                    // (per karpenter.sh AMI selectors). Narrowing avoids
                    // catching unrelated /aws/service/* trees (MSK, RDS
                    // proxy, ECS, etc.) that the controller never reads.
                    // https://karpenter.sh/docs/concepts/nodeclasses/#specamifamily
                    Sid: "AllowSSMReadActions",
                    Effect: "Allow",
                    Resource: [
                        `arn:aws:ssm:${reg}::parameter/aws/service/eks/optimized-ami/*`,
                        `arn:aws:ssm:${reg}::parameter/aws/service/bottlerocket/aws-k8s-*`,
                    ],
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
                    Resource: `arn:aws:iam::${acct}:instance-profile/*`,
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
                    Resource: `arn:aws:iam::${acct}:instance-profile/*`,
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
                    Resource: `arn:aws:iam::${acct}:instance-profile/*`,
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
                    Resource: `arn:aws:iam::${acct}:instance-profile/*`,
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
                    Resource: `arn:aws:eks:${reg}:${acct}:cluster/${cluster}`,
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
export const vpcCniRoleArn: pulumi.Output<string> = vpcCniRole.arn;
