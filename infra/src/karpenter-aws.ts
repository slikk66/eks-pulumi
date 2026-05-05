// Karpenter interruption infrastructure: SQS queue + EventBridge rules +
// Pod Identity Association.
//
// EC2 surface interruption signals (spot interruption, instance state-change,
// rebalance recommendations) via EventBridge. We route them to a per-cluster
// SQS queue that the Karpenter controller polls, so it can drain and replace
// nodes before the underlying EC2 instance is reclaimed.
//
// Pattern + event sources: https://karpenter.sh/docs/concepts/disruption/
// Event detail-types fetched 2026-05-05 from the Karpenter v1.12 CloudFormation
// reference: https://karpenter.sh/docs/reference/cloudformation/

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { prefix } from "../pulumi.config";
import { cluster } from "./cluster";
import { karpenterControllerRoleArn } from "./iam";

// IMPORTANT: this name is also constructed as a literal in iam.ts (the
// Karpenter controller policy needs the queue ARN before this file runs,
// so iam.ts builds it from prefix + region + account). Any rename of the
// queue MUST be mirrored in iam.ts or interruption handling silently
// breaks at runtime.
const queueName = `${prefix}-karpenter-interruption`;

// SQS interruption queue ----------------------------------------------------
//
// 5-minute message retention: interruption signals are perishable (the
// instance is going away in ~2 minutes for spot, ~30s for state-change).
// SSE-SQS is AWS-managed encryption at rest with no KMS key to provision.
// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html

const interruptionQueue = new aws.sqs.Queue(`${prefix}-karpenter-interruption`, {
    name: queueName,
    messageRetentionSeconds: 300,
    sqsManagedSseEnabled: true,
});

// Allow EventBridge + SQS service principals to deliver to this queue.
// Matches the Karpenter CF reference template's KarpenterInterruptionQueuePolicy.
new aws.sqs.QueuePolicy(`${prefix}-karpenter-interruption-policy`, {
    queueUrl: interruptionQueue.id,
    policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Id: "EC2InterruptionPolicy",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: ["events.amazonaws.com", "sqs.amazonaws.com"],
            },
            Action: "sqs:SendMessage",
            Resource: interruptionQueue.arn,
        }],
    }),
});

// EventBridge rules → SQS target -------------------------------------------
//
// Three event sources surface as Karpenter-actionable interruption signals.
// All routed to the same queue so the controller has a single poll loop.

interface RuleSpec {
    name: string;
    detailType: string;
}

const rules: RuleSpec[] = [
    {
        name: "spot-interruption",
        detailType: "EC2 Spot Instance Interruption Warning",
    },
    {
        name: "rebalance-recommendation",
        detailType: "EC2 Instance Rebalance Recommendation",
    },
    {
        name: "instance-state-change",
        detailType: "EC2 Instance State-change Notification",
    },
];

for (const r of rules) {
    const rule = new aws.cloudwatch.EventRule(`${prefix}-karpenter-${r.name}`, {
        name: `${prefix}-karpenter-${r.name}`,
        eventPattern: JSON.stringify({
            source: ["aws.ec2"],
            "detail-type": [r.detailType],
        }),
    });

    new aws.cloudwatch.EventTarget(`${prefix}-karpenter-${r.name}-target`, {
        rule: rule.name,
        arn: interruptionQueue.arn,
    });
}

// Pod Identity Association --------------------------------------------------
//
// Wires the karpenter ServiceAccount in kube-system to the controller IAM
// role via Pod Identity. Requires the eks-pod-identity-agent addon (created
// in cluster.ts).
// https://docs.aws.amazon.com/eks/latest/userguide/pod-identity-association.html

new aws.eks.PodIdentityAssociation(`${prefix}-karpenter-pi`, {
    clusterName: cluster.name,
    namespace: "kube-system",
    serviceAccount: "karpenter",
    roleArn: karpenterControllerRoleArn,
});

// Exports -------------------------------------------------------------------

export const interruptionQueueName: pulumi.Output<string> = interruptionQueue.name;
export const interruptionQueueArn: pulumi.Output<string> = interruptionQueue.arn;
