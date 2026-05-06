// Typed config loader for the cluster stack.
// VPC / CIDR / NAT / VPN inputs live in the network project's pulumi.config.ts.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const cfg = new pulumi.Config();

// Cluster
export const kubernetesVersion = cfg.get("kubernetesVersion") ?? "1.35";

// EKS access entry.
//
// Pass the full IAM role ARN (with path if present, e.g. SSO roles include
// `/aws-reserved/sso.amazonaws.com/<region>/...`). EKS rejects path-stripped
// ARNs at access-entry create time because the underlying IAM role doesn't
// exist at the path-less ARN. EKS handles the path → STS-assumed-role
// matching itself at auth time.
export const adminRoleArn = cfg.require("adminRoleArn");
if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(adminRoleArn)) {
    throw new Error(
        `adminRoleArn (${adminRoleArn}) is not a valid IAM role ARN. ` +
        `Expected: arn:aws:iam::<12-digit-account>:role/<role-name>`,
    );
}

// External Secrets IRSA — explicit allow-list of Secrets Manager ARNs.
// Empty list (default) → iam.ts scopes reads to `secret:<prefix>-*` only.
export const externalSecretsAllowedSecretArns =
    cfg.getObject<string[]>("externalSecretsAllowedSecretArns") ?? [];

// Resolved at runtime
export const region = aws.getRegionOutput().id;
export const accountId = aws.getCallerIdentityOutput().accountId;

// Naming
export const project = pulumi.getProject();
export const stack = pulumi.getStack();
export const prefix = `${project}-${stack}`;
export const clusterName = `${prefix}-cluster`;
