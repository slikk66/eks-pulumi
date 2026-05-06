// Cluster-stack composition. Side-effect imports trigger top-level resource
// declarations in dependency order: cluster → iam → nodegroup → karpenter-aws.
//
// Stack outputs (consumed by the gitops slice via StackReference):
//   clusterName, clusterEndpoint, kubeconfig (secret-marked), oidcProviderArn,
//   oidcProviderUrl, albRoleArn, ebsCsiRoleArn, efsCsiRoleArn, vpcCniRoleArn,
//   externalSecretsRoleArn, fluentBitRoleArn, karpenterRoleArn,
//   karpenterNodeRoleArn, karpenterNodeRoleName, karpenterInterruptionQueueName,
//   accountId, region.

import "./src/karpenter-aws";

import * as pulumi from "@pulumi/pulumi";
import { region, accountId } from "./pulumi.config";
import {
    clusterName,
    clusterEndpoint,
    clusterCertificateAuthorityData,
    oidcProvider,
} from "./src/cluster";
import {
    albControllerRoleArn,
    ebsCsiRoleArn,
    efsCsiRoleArn,
    vpcCniRoleArn,
    externalSecretsRoleArn,
    fluentBitRoleArn,
    karpenterControllerRoleArn,
} from "./src/iam";
import { nodeRoleArn, karpenterNodeRoleName } from "./src/nodegroup";
import { interruptionQueueName } from "./src/karpenter-aws";

// kubeconfig (exec-auth, v1beta1 client.authentication API). Pattern from
// the legacy infra/src/argocd.ts kubeconfig builder; gitops slice rebuilds
// the k8s.Provider from this stack output.
//   https://kubernetes.io/docs/reference/config-api/client-authentication.v1beta1/
//   https://docs.aws.amazon.com/cli/latest/reference/eks/get-token.html
const kubeconfigDoc = pulumi
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

export const kubeconfig = pulumi.secret(pulumi.jsonStringify(kubeconfigDoc));

export {
    clusterName,
    clusterEndpoint,
    region,
    accountId,
    ebsCsiRoleArn,
    efsCsiRoleArn,
    vpcCniRoleArn,
    externalSecretsRoleArn,
    fluentBitRoleArn,
    karpenterNodeRoleName,
};
export const oidcProviderArn = oidcProvider.arn;
export const oidcProviderUrl = oidcProvider.url;
export const albRoleArn = albControllerRoleArn;
export const karpenterRoleArn = karpenterControllerRoleArn;
export const karpenterNodeRoleArn = nodeRoleArn;
export const karpenterInterruptionQueueName = interruptionQueueName;
