import type { PlanEdge, PlanNode } from '../types/molecule';

export const planNodes: PlanNode[] = [
{
  nodeId: 'nd_cotton',
  kind: 'SUPPLY',
  merchantName: 'Aegean Fibre Co.',
  capabilityName: 'Organic cotton jersey',
  quantity: 1200,
  unit: 'm',
  unitCost: 4.2,
  totalCost: 5040,
  startsAt: 'Mar 04',
  completesAt: 'Mar 11',
  status: 'success',
  x: 60,
  y: 120,
  region: 'İzmir, TR',
  leadTimeDays: 7
},
{
  nodeId: 'nd_dye',
  kind: 'SUPPLY',
  merchantName: 'Noor Pigments',
  capabilityName: 'Low-impact reactive dye',
  quantity: 90,
  unit: 'kg',
  unitCost: 11.5,
  totalCost: 1035,
  startsAt: 'Mar 04',
  completesAt: 'Mar 09',
  status: 'success',
  x: 60,
  y: 360,
  region: 'Porto, PT',
  leadTimeDays: 5
},
{
  nodeId: 'nd_knit',
  kind: 'TRANSFORM',
  merchantName: 'Verde Knitworks',
  capabilityName: 'Circular knit & finish',
  quantity: 1200,
  unit: 'm',
  unitCost: 2.8,
  totalCost: 3360,
  startsAt: 'Mar 12',
  completesAt: 'Mar 19',
  status: 'running',
  x: 420,
  y: 120,
  region: 'Porto, PT',
  leadTimeDays: 7,
  note: 'Dye lot matching in progress'
},
{
  nodeId: 'nd_trim',
  kind: 'TRANSFORM',
  merchantName: 'Kestrel Trims',
  capabilityName: 'Woven label & care tag',
  quantity: 2400,
  unit: 'pcs',
  unitCost: 0.18,
  totalCost: 432,
  startsAt: 'Mar 10',
  completesAt: 'Mar 16',
  status: 'failed',
  x: 420,
  y: 360,
  region: 'Leicester, UK',
  leadTimeDays: 6,
  note: 'Supplier went offline — replacement staged'
},
{
  nodeId: 'nd_assemble',
  kind: 'ASSEMBLE',
  merchantName: 'Atelier Ninety',
  capabilityName: 'Cut, sew & QC',
  quantity: 2400,
  unit: 'units',
  unitCost: 6.4,
  totalCost: 15360,
  startsAt: 'Mar 20',
  completesAt: 'Apr 02',
  status: 'idle',
  x: 780,
  y: 240,
  region: 'Guimarães, PT',
  leadTimeDays: 13
},
{
  nodeId: 'nd_fulfill',
  kind: 'FULFILL',
  merchantName: 'Northline 3PL',
  capabilityName: 'Pick, pack & ship',
  quantity: 2400,
  unit: 'units',
  unitCost: 1.15,
  totalCost: 2760,
  startsAt: 'Apr 03',
  completesAt: 'Apr 08',
  status: 'idle',
  x: 1140,
  y: 240,
  region: 'Rotterdam, NL',
  leadTimeDays: 5
}];


export const planEdges: PlanEdge[] = [
{
  edgeId: 'eg_1',
  fromNodeId: 'nd_cotton',
  toNodeId: 'nd_knit',
  material: 'Greige jersey',
  quantity: 1200,
  unit: 'm'
},
{
  edgeId: 'eg_2',
  fromNodeId: 'nd_dye',
  toNodeId: 'nd_knit',
  material: 'Dye stock',
  quantity: 90,
  unit: 'kg'
},
{
  edgeId: 'eg_3',
  fromNodeId: 'nd_knit',
  toNodeId: 'nd_assemble',
  material: 'Finished fabric',
  quantity: 1200,
  unit: 'm'
},
{
  edgeId: 'eg_4',
  fromNodeId: 'nd_trim',
  toNodeId: 'nd_assemble',
  material: 'Trim kit',
  quantity: 2400,
  unit: 'pcs'
},
{
  edgeId: 'eg_5',
  fromNodeId: 'nd_assemble',
  toNodeId: 'nd_fulfill',
  material: 'Packed units',
  quantity: 2400,
  unit: 'units'
}];


export const planSummary = {
  planId: 'pln_8f21c4',
  status: 'VALID' as const,
  totalCost: 27987,
  unitCost: 11.66,
  units: 2400,
  span: 'Mar 04 → Apr 08',
  confidence: 0.86
};