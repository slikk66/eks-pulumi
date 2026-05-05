// Typed config loader. Single source of truth for stack inputs.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const cfg = new pulumi.Config();

// Cluster
export const kubernetesVersion = cfg.get("kubernetesVersion") ?? "1.35";
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
// false (default) = single subnet association (cost-sensitive). true = one
// association per private subnet (multi-AZ HA, ~$72/mo per extra association).
export const vpnHighAvailability = cfg.getBoolean("vpnHighAvailability") ?? false;

// EKS access entry
export const adminRoleArn = cfg.require("adminRoleArn");

// ArgoCD root Application source
export const argoBootstrapRepoUrl = cfg.require("argoBootstrapRepoUrl");
export const argoBootstrapRepoRevision = cfg.get("argoBootstrapRepoRevision") ?? "HEAD";
export const argoBootstrapRepoPath = cfg.get("argoBootstrapRepoPath") ?? "bootstrap";

// External Secrets IRSA — explicit allow-list of Secrets Manager ARNs.
// Empty list (default) → iam.ts scopes reads to `secret:<prefix>-*` only.
export const externalSecretsAllowedSecretArns =
    cfg.getObject<string[]>("externalSecretsAllowedSecretArns") ?? [];

// Resolved at runtime
export const region = aws.getRegionOutput().id;

// Naming
export const project = pulumi.getProject();
export const stack = pulumi.getStack();
export const prefix = `${project}-${stack}`;
export const clusterName = `${prefix}-cluster`;
