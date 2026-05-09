// Typed wrapper around the cluster stack reference. Mirrors
// infra/cluster/src/stack-references.ts. All getters return a concrete
// pulumi.Output<T> — never Output<any>. requireOutput throws at preview
// time if the named output is missing, so failures surface fast.
//
// DIY S3 backend stack-reference syntax: <organization>/<project>/<stack>
// where <organization> is the literal string "organization" for self-managed
// backends. https://www.pulumi.com/docs/iac/concepts/stacks/#stackreferences

import * as pulumi from "@pulumi/pulumi";

const stack = pulumi.getStack();

const cluster = new pulumi.StackReference(`organization/eks-pulumi-cluster/${stack}`);

function clusterString(name: string): pulumi.Output<string> {
    return cluster.requireOutput(name) as pulumi.Output<string>;
}

export const accountId                      = clusterString("accountId");
export const region                         = clusterString("region");
export const clusterName                    = clusterString("clusterName");
export const vpcId                          = clusterString("vpcId");
// kubeconfig is secret-marked at the cluster stack output; the marking
// propagates through requireOutput so the k8s.Provider receives a secret.
export const kubeconfig                     = clusterString("kubeconfig");
export const albRoleArn                     = clusterString("albRoleArn");
export const ebsCsiRoleArn                  = clusterString("ebsCsiRoleArn");
export const efsCsiRoleArn                  = clusterString("efsCsiRoleArn");
export const externalSecretsRoleArn         = clusterString("externalSecretsRoleArn");
export const fluentBitRoleArn               = clusterString("fluentBitRoleArn");
export const karpenterRoleArn               = clusterString("karpenterRoleArn");
export const karpenterNodeRoleName          = clusterString("karpenterNodeRoleName");
export const karpenterInterruptionQueueName = clusterString("karpenterInterruptionQueueName");
export const oidcProviderArn                = clusterString("oidcProviderArn");
export const oidcProviderUrl                = clusterString("oidcProviderUrl");
