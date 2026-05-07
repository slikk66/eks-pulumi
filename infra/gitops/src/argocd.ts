// ArgoCD bootstrap — Helm chart + GitOps-Bridge cluster Secret + root
// Application CR pointing at the public eks-argo-bootstrap repo.
//
// Pulumi installs ArgoCD only; everything else (cert-manager, AWS LB
// Controller, Karpenter chart, External Secrets, observability, app
// workloads) is GitOps-managed downstream by the root Application.
//
// GitOps-Bridge pattern: account- and cluster-specific identifiers (account
// ID, role ARNs, queue names, OIDC issuer) live as annotations on a single
// Secret labelled `argocd.argoproj.io/secret-type=cluster`. ApplicationSets
// in the public bootstrap repo template these via {{metadata.annotations.X}}.
// https://github.com/gitops-bridge-dev/gitops-bridge

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

import {
    prefix,
    stack,
    argoBootstrapRepoUrl,
    argoBootstrapRepoRevision,
    argoBootstrapRepoPath,
} from "../pulumi.config";
import {
    accountId,
    region,
    clusterName,
    kubeconfig,
    albRoleArn,
    ebsCsiRoleArn,
    efsCsiRoleArn,
    externalSecretsRoleArn,
    fluentBitRoleArn,
    karpenterRoleArn,
    karpenterNodeRoleName,
    karpenterInterruptionQueueName,
    oidcProviderArn,
    oidcProviderUrl,
} from "./stack-references";

// k8s.Provider — built from the cluster stack's kubeconfig output. The
// kubeconfig is already a serialized JSON string (secret-marked) carrying
// the `aws eks get-token` exec-auth users entry; no need to re-build it
// here. https://www.pulumi.com/registry/packages/kubernetes/api-docs/provider/

const k8sProvider = new k8s.Provider(`${prefix}-k8s`, {
    kubeconfig,
    enableServerSideApply: true,
});

// argocd namespace ----------------------------------------------------------

const ns = new k8s.core.v1.Namespace(`${prefix}-argocd-ns`, {
    metadata: { name: "argocd" },
}, { provider: k8sProvider });

// ArgoCD Helm release -------------------------------------------------------
//
// Chart: argo-cd 9.5.11 (latest 9.5.x; deploys ArgoCD v3.3.x).
//   https://artifacthub.io/packages/helm/argo/argo-cd
//   https://github.com/argoproj/argo-helm/releases
//
// `global.tolerations` — required because the bootstrap node group taints
// every node `CriticalAddonsOnly=true:NoSchedule`. Chart 9.5.11 plumbs
// `global.tolerations` to controller / server / repo-server / applicationSet
// / notifications / dex / redis when no per-component override is set.

const argocdRelease = new k8s.helm.v3.Release(`${prefix}-argocd`, {
    chart: "argo-cd",
    version: "9.5.11",
    namespace: ns.metadata.name,
    repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
    values: {
        global: {
            tolerations: [
                { key: "CriticalAddonsOnly", operator: "Exists" },
            ],
        },
        server: {
            // No ALB in the Pulumi phase — ALB Controller arrives via GitOps.
            service: { type: "ClusterIP" },
        },
        configs: {
            // TLS terminates at the controller; only reachable through the
            // Client VPN, so the API server can speak plain HTTP internally.
            params: { "server.insecure": true },
            cm: { "application.resourceTrackingMethod": "annotation" },
        },
    },
}, {
    provider: k8sProvider,
    customTimeouts: { create: "10m", update: "5m" },
});

// GitOps-Bridge cluster Secret ---------------------------------------------
//
// Every dynamic value the public eks-argo-bootstrap repo references is an
// annotation here, sourced from the cluster stack outputs (no hardcoded
// values). Keep this list in sync with the bootstrap repo's ApplicationSet
// templates.

const clusterSecret = new k8s.core.v1.Secret(`${prefix}-argocd-cluster`, {
    metadata: {
        name: "in-cluster",
        namespace: ns.metadata.name,
        labels: {
            "argocd.argoproj.io/secret-type": "cluster",
            env: stack,
        },
        annotations: {
            aws_account_id: accountId,
            aws_region: region,
            cluster_name: clusterName,
            karpenter_role_arn: karpenterRoleArn,
            karpenter_node_role_name: karpenterNodeRoleName,
            karpenter_interruption_queue_name: karpenterInterruptionQueueName,
            alb_role_arn: albRoleArn,
            ebs_csi_role_arn: ebsCsiRoleArn,
            efs_csi_role_arn: efsCsiRoleArn,
            external_secrets_role_arn: externalSecretsRoleArn,
            fluentbit_role_arn: fluentBitRoleArn,
            oidc_provider_arn: oidcProviderArn,
            oidc_provider_url: oidcProviderUrl,
        },
    },
    stringData: {
        name: "in-cluster",
        server: "https://kubernetes.default.svc",
        config: '{"tlsClientConfig":{"insecure":false}}',
    },
}, {
    provider: k8sProvider,
    dependsOn: [argocdRelease],
});

// Root Application CR ------------------------------------------------------
//
// The resources-finalizer.argocd.argoproj.io finalizer ensures that
// `kubectl delete application root-app` cascades through child apps (ALB
// Controller deletes ALBs, ESO deletes secrets, etc.) before the root is
// removed — required for clean teardown.
//   https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/

const rootAppMetadataName = "root-app";

new k8s.apiextensions.CustomResource(`${prefix}-root-app`, {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
        name: rootAppMetadataName,
        namespace: ns.metadata.name,
        finalizers: ["resources-finalizer.argocd.argoproj.io"],
    },
    spec: {
        project: "default",
        source: {
            repoURL: argoBootstrapRepoUrl,
            targetRevision: argoBootstrapRepoRevision,
            path: argoBootstrapRepoPath,
        },
        destination: {
            server: "https://kubernetes.default.svc",
            namespace: "argocd",
        },
        syncPolicy: {
            automated: { prune: true, selfHeal: true, allowEmpty: false },
            syncOptions: ["CreateNamespace=true", "ServerSideApply=true"],
            retry: {
                limit: 5,
                backoff: { duration: "5s", factor: 2, maxDuration: "3m" },
            },
        },
    },
}, {
    provider: k8sProvider,
    dependsOn: [argocdRelease, clusterSecret],
});

// Exports ------------------------------------------------------------------

export const argocdNamespace: pulumi.Output<string> = ns.metadata.name;
export const rootAppName: string = rootAppMetadataName;
