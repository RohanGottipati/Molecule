export type NodeKind = 'SUPPLY' | 'TRANSFORM' | 'ASSEMBLE' | 'FULFILL';

export type NodeStatus =
'idle' |
'running' |
'success' |
'failed' |
'replaced' |
'offline';

export interface PlanNode {
  nodeId: string;
  kind: NodeKind;
  merchantName: string;
  capabilityName: string;
  quantity: number;
  unit: string;
  unitCost: number;
  totalCost: number;
  startsAt: string;
  completesAt: string;
  status: NodeStatus;
  x: number;
  y: number;
  region: string;
  leadTimeDays: number;
  note?: string;
}

export interface PlanEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  material: string;
  quantity: number;
  unit: string;
}

export interface Project {
  id: string;
  name: string;
  brief: string;
  state: 'draft' | 'planning' | 'awaiting-approval' | 'executing' | 'complete';
  updatedAt: string;
  units: number;
  nodeCount: number;
  totalCost: number;
}

export interface Supplier {
  id: string;
  name: string;
  region: string;
  capabilities: string[];
  leadTimeDays: number;
  reliability: number;
  status: 'connected' | 'quoting' | 'offline';
  minOrder: number;
}

export interface SourceClaim {
  id: string;
  merchant: string;
  claim: string;
  evidence: string;
  confidence: number;
  state: 'verified' | 'conflict' | 'gap';
  capturedAt: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  label: string;
  detail: string;
  at: string;
  level: 'info' | 'success' | 'warn' | 'error';
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  readiness: 'ready' | 'partial' | 'blocked';
  operations: string[];
  suppliers: number;
  missingEvidence: number;
  description: string;
}

export interface Turn {
  id: string;
  role: 'user' | 'molecule';
  text: string;
  at: string;
  voice?: boolean;
  attachments?: string[];
  question?: string;
}