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
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

import {
    prefix,
    region,
    stack,
    argoBootstrapRepoUrl,
    argoBootstrapRepoRevision,
    argoBootstrapRepoPath,
} from "../pulumi.config";
import {
    cluster,
    clusterName,
    clusterEndpoint,
    clusterCertificateAuthorityData,
    oidcProvider,
} from "./cluster";
import { nodeRole, nodeGroup } from "./nodegroup";
import {
    albControllerRoleArn,
    ebsCsiRoleArn,
    efsCsiRoleArn,
    externalSecretsRoleArn,
    fluentBitRoleArn,
    karpenterControllerRoleArn,
} from "./iam";
import { interruptionQueueName } from "./karpenter-aws";

// k8s.Provider — exec-auth kubeconfig --------------------------------------
//
// Built by hand (not via @pulumi/eks) since cluster.ts uses raw aws.eks.*.
// Uses the `aws eks get-token` exec plugin at the v1beta1 client-auth API
// (v1alpha1 is deprecated).
//   https://docs.aws.amazon.com/eks/latest/userguide/create-kubeconfig.html
//   https://docs.aws.amazon.com/cli/latest/reference/eks/get-token.html
//   https://kubernetes.io/docs/reference/config-api/client-authentication.v1beta1/
//   https://www.pulumi.com/registry/packages/kubernetes/api-docs/provider/

const kubeconfig = pulumi
    .all([clusterEndpoint, clusterCertificateAuthorityData, clusterName])
    .apply(([endpoint, caData, name]) => ({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{
            name,
            cluster: {
                server: endpoint,
                "certificate-authority-data": caData,
            },
        }],
        contexts: [{ name, context: { cluster: name, user: name } }],
        "current-context": name,
        users: [{
            name,
            user: {
                exec: {
                    apiVersion: "client.authentication.k8s.io/v1beta1",
                    command: "aws",
                    args: [
                        "eks", "get-token",
                        "--cluster-name", name,
                        "--output", "json",
                    ],
                },
            },
        }],
    }));

const k8sProvider = new k8s.Provider(`${prefix}-k8s`, {
    kubeconfig: pulumi.jsonStringify(kubeconfig),
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
// dependsOn note: the issue requests
// `[cluster, vpcCniAddon, podIdentityAgentAddon, nodeGroup]` but the vpc-cni
// and pod-identity-agent Addon resources are constructed without being
// assigned to exported variables (cluster.ts:174-176, nodegroup.ts:101) and
// the scope of this issue forbids modifying those files. The fallback is
// `[cluster, nodeGroup]` plus a generous customTimeouts.create — addon
// convergence (<60s typical) sits well inside the 30-min create budget, and
// pod-identity-agent is irrelevant to ArgoCD itself (Karpenter consumes it,
// and Karpenter is GitOps-installed downstream).

export const argocdRelease = new k8s.helm.v3.Release(`${prefix}-argocd`, {
    chart: "argo-cd",
    version: "9.5.11",
    namespace: ns.metadata.name,
    repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
    values: {
        installCRDs: true,
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
    customTimeouts: { create: "30m", update: "20m" },
    dependsOn: [cluster, nodeGroup],
});

// GitOps-Bridge cluster Secret ---------------------------------------------
//
// Every dynamic value the public eks-argo-bootstrap repo references is an
// annotation here, sourced from Pulumi resource outputs (no hardcoded
// values). Keep this list in sync with the bootstrap repo's ApplicationSet
// templates.

const accountId = aws.getCallerIdentityOutput().accountId;

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
            karpenter_role_arn: karpenterControllerRoleArn,
            karpenter_node_role_name: nodeRole.name,
            karpenter_interruption_queue_name: interruptionQueueName,
            alb_role_arn: albControllerRoleArn,
            ebs_csi_role_arn: ebsCsiRoleArn,
            efs_csi_role_arn: efsCsiRoleArn,
            external_secrets_role_arn: externalSecretsRoleArn,
            fluentbit_role_arn: fluentBitRoleArn,
            oidc_provider_arn: oidcProvider.arn,
            oidc_provider_url: oidcProvider.url,
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

new k8s.apiextensions.CustomResource(`${prefix}-root-app`, {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
        name: "root-app",
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
