// Typed config loader for the gitops stack.
// AWS / cluster identifiers come from the cluster stack via StackReference
// (see ./src/stack-references.ts) — not duplicated as config here.

import * as pulumi from "@pulumi/pulumi";

const cfg = new pulumi.Config();

// ArgoCD root Application source (consumed by ./src/argocd.ts).
export const argoBootstrapRepoUrl = cfg.require("argoBootstrapRepoUrl");
export const argoBootstrapRepoRevision = cfg.get("argoBootstrapRepoRevision") ?? "HEAD";
export const argoBootstrapRepoPath = cfg.get("argoBootstrapRepoPath") ?? "bootstrap";

// Naming
export const project = pulumi.getProject();
export const stack = pulumi.getStack();
export const prefix = `${project}-${stack}`;
