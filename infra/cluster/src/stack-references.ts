// Typed wrapper around the network stack reference. All getters return a
// concrete pulumi.Output<T> — never Output<any>. requireOutput throws at
// preview time if the named output is missing, so failures surface fast.
//
// DIY S3 backend stack-reference syntax: <organization>/<project>/<stack>
// where <organization> is the literal string "organization" for self-managed
// backends. https://www.pulumi.com/docs/iac/concepts/stacks/#stackreferences

import * as pulumi from "@pulumi/pulumi";

const stack = pulumi.getStack();

const network = new pulumi.StackReference(`organization/eks-pulumi-network/${stack}`);

function netString(name: string): pulumi.Output<string> {
    return network.requireOutput(name) as pulumi.Output<string>;
}
function netStringArray(name: string): pulumi.Output<string[]> {
    return network.requireOutput(name) as pulumi.Output<string[]>;
}

export const vpcId            = netString("vpcId");
export const vpcCidrBlock     = netString("vpcCidrBlock");
export const publicSubnetIds  = netStringArray("publicSubnetIds");
export const privateSubnetIds = netStringArray("privateSubnetIds");
// workerSubnetIds is computed in the network project (private when NAT is on,
// public otherwise) so the cluster slice stays oblivious to enableNat.
export const workerSubnetIds  = netStringArray("workerSubnetIds");
