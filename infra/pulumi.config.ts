// Typed config loader. Single source of truth for stack inputs.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const cfg = new pulumi.Config();

// Cluster
export const kubernetesVersion = cfg.get("kubernetesVersion") ?? "1.35";
export const vpcCidr = cfg.get("vpcCidr") ?? "10.50.0.0/16";
export const enableNat = cfg.getBoolean("enableNat") ?? false;

// Client VPN
export const clientVpnCidr = cfg.get("clientVpnCidr") ?? "10.100.0.0/22";

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
