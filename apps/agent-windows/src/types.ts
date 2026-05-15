import type { AgentToServer } from "@cmc/protocol";

export type AgentJobLog = Extract<AgentToServer, { type: "job.log" }>;
export type AgentJobDone = Extract<AgentToServer, { type: "job.done" }>;
