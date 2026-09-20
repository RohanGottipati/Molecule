import type {
  ActivityEvent,
  Project,
  Recipe,
  SourceClaim,
  Supplier,
  Turn } from
'../types/molecule';

export const projects: Project[] = [
{
  id: 'prj_atlas',
  name: 'Atlas heavyweight tee',
  brief: '2,400 organic heavyweight tees, EU-made, delivered before April 10.',
  state: 'awaiting-approval',
  updatedAt: '4 min ago',
  units: 2400,
  nodeCount: 6,
  totalCost: 27987
},
{
  id: 'prj_harbor',
  name: 'Harbor canvas tote',
  brief: '800 recycled canvas totes with two-colour screen print.',
  state: 'executing',
  updatedAt: '2 hours ago',
  units: 800,
  nodeCount: 5,
  totalCost: 9120
},
{
  id: 'prj_ember',
  name: 'Ember ceramic mug',
  brief: '1,500 stoneware mugs, reactive glaze, gift-boxed.',
  state: 'planning',
  updatedAt: 'Yesterday',
  units: 1500,
  nodeCount: 7,
  totalCost: 14250
},
{
  id: 'prj_quartz',
  name: 'Quartz field notebook',
  brief: '5,000 FSC notebooks, foil-stamped cover, EU fulfilment.',
  state: 'complete',
  updatedAt: 'Mar 02',
  units: 5000,
  nodeCount: 4,
  totalCost: 18400
},
{
  id: 'prj_lumen',
  name: 'Lumen desk lamp',
  brief: 'Prototype run of 120 aluminium desk lamps.',
  state: 'draft',
  updatedAt: 'Feb 27',
  units: 120,
  nodeCount: 0,
  totalCost: 0
}];


export const suppliers: Supplier[] = [
{
  id: 'mch_aegean',
  name: 'Aegean Fibre Co.',
  region: 'İzmir, TR',
  capabilities: ['Organic cotton', 'Jersey knit', 'GOTS certified'],
  leadTimeDays: 7,
  reliability: 0.97,
  status: 'connected',
  minOrder: 500
},
{
  id: 'mch_verde',
  name: 'Verde Knitworks',
  region: 'Porto, PT',
  capabilities: ['Circular knit', 'Finishing', 'Dye house'],
  leadTimeDays: 7,
  reliability: 0.94,
  status: 'connected',
  minOrder: 300
},
{
  id: 'mch_kestrel',
  name: 'Kestrel Trims',
  region: 'Leicester, UK',
  capabilities: ['Woven labels', 'Care tags', 'Hangtags'],
  leadTimeDays: 6,
  reliability: 0.71,
  status: 'offline',
  minOrder: 1000
},
{
  id: 'mch_atelier',
  name: 'Atelier Ninety',
  region: 'Guimarães, PT',
  capabilities: ['Cut & sew', 'QC', 'Sampling'],
  leadTimeDays: 13,
  reliability: 0.91,
  status: 'connected',
  minOrder: 250
},
{
  id: 'mch_northline',
  name: 'Northline 3PL',
  region: 'Rotterdam, NL',
  capabilities: ['Pick & pack', 'EU shipping', 'Returns'],
  leadTimeDays: 5,
  reliability: 0.99,
  status: 'quoting',
  minOrder: 100
},
{
  id: 'mch_noor',
  name: 'Noor Pigments',
  region: 'Porto, PT',
  capabilities: ['Reactive dye', 'Low-impact', 'Colour matching'],
  leadTimeDays: 5,
  reliability: 0.88,
  status: 'connected',
  minOrder: 20
}];


export const sourceClaims: SourceClaim[] = [
{
  id: 'clm_1',
  merchant: 'Aegean Fibre Co.',
  claim: 'GOTS certification valid through 2027',
  evidence: 'certificate scan · gots.org registry lookup',
  confidence: 0.96,
  state: 'verified',
  capturedAt: 'Mar 03, 09:12'
},
{
  id: 'clm_2',
  merchant: 'Verde Knitworks',
  claim: 'Circular knit capacity 1,500 m / week',
  evidence: 'supplier quote email · capacity sheet v4',
  confidence: 0.82,
  state: 'verified',
  capturedAt: 'Mar 03, 11:40'
},
{
  id: 'clm_3',
  merchant: 'Kestrel Trims',
  claim: 'Lead time 6 days for woven labels',
  evidence: 'site listing says 6 days · quote says 11 days',
  confidence: 0.41,
  state: 'conflict',
  capturedAt: 'Mar 04, 08:02'
},
{
  id: 'clm_4',
  merchant: 'Atelier Ninety',
  claim: 'Living-wage audit completed',
  evidence: 'no document retrieved',
  confidence: 0.12,
  state: 'gap',
  capturedAt: 'Mar 04, 08:15'
}];


export const activityEvents: ActivityEvent[] = [
{
  id: 'ev_1',
  type: 'execution.failed',
  label: 'Trim supplier went offline',
  detail: 'Kestrel Trims stopped responding mid-quote. Replacement staged.',
  at: '09:41',
  level: 'error'
},
{
  id: 'ev_2',
  type: 'plan.revalidated',
  label: 'Plan revalidated',
  detail: 'Solver returned VALID with 6 nodes, €27,987 total.',
  at: '09:38',
  level: 'success'
},
{
  id: 'ev_3',
  type: 'quote.received',
  label: 'Quote received',
  detail: 'Northline 3PL quoted €1.15 / unit for pick, pack & ship.',
  at: '09:22',
  level: 'info'
},
{
  id: 'ev_4',
  type: 'evidence.conflict',
  label: 'Evidence conflict',
  detail: 'Two lead times found for Kestrel Trims (6d vs 11d).',
  at: '08:02',
  level: 'warn'
},
{
  id: 'ev_5',
  type: 'project.created',
  label: 'Project created',
  detail: 'Brief accepted from dock conversation.',
  at: '07:55',
  level: 'info'
}];


export const recipes: Recipe[] = [
{
  id: 'rcp_tee',
  name: 'Heavyweight tee',
  category: 'Apparel',
  readiness: 'ready',
  operations: ['Knit', 'Dye', 'Cut & sew', 'Pack'],
  suppliers: 12,
  missingEvidence: 0,
  description: '240–280 gsm organic jersey tee with EU-only supply chain.'
},
{
  id: 'rcp_tote',
  name: 'Canvas tote',
  category: 'Accessories',
  readiness: 'ready',
  operations: ['Weave', 'Print', 'Sew'],
  suppliers: 8,
  missingEvidence: 0,
  description: 'Recycled 12 oz canvas with water-based screen print.'
},
{
  id: 'rcp_mug',
  name: 'Stoneware mug',
  category: 'Homeware',
  readiness: 'partial',
  operations: ['Cast', 'Glaze', 'Fire', 'Pack'],
  suppliers: 5,
  missingEvidence: 2,
  description: 'Reactive-glaze stoneware, gift-box ready.'
},
{
  id: 'rcp_notebook',
  name: 'Field notebook',
  category: 'Stationery',
  readiness: 'ready',
  operations: ['Print', 'Foil', 'Bind'],
  suppliers: 9,
  missingEvidence: 0,
  description: 'FSC paper, section-sewn, foil-stamped cover.'
},
{
  id: 'rcp_lamp',
  name: 'Aluminium desk lamp',
  category: 'Hardware',
  readiness: 'blocked',
  operations: ['CNC', 'Anodise', 'Wire', 'Assemble'],
  suppliers: 2,
  missingEvidence: 5,
  description: 'Low-volume machined lamp — electrical certification missing.'
},
{
  id: 'rcp_candle',
  name: 'Soy candle',
  category: 'Homeware',
  readiness: 'partial',
  operations: ['Blend', 'Pour', 'Label'],
  suppliers: 6,
  missingEvidence: 1,
  description: 'Soy wax vessel candle with custom fragrance load.'
}];


export const conversation: Turn[] = [
{
  id: 't1',
  role: 'user',
  text: 'I need 2,400 heavyweight organic tees made in Europe, landed before April 10.',
  at: '07:55',
  voice: true
},
{
  id: 't2',
  role: 'molecule',
  text: 'Got it. I found 12 suppliers that can cover knit, dye, cut & sew and EU fulfilment inside that window. Before I solve, two things are ambiguous.',
  at: '07:55',
  question: 'Is 240 gsm acceptable, or do you need 280 gsm?'
},
{
  id: 't3',
  role: 'user',
  text: '280 gsm. And the label has to be woven, not printed.',
  at: '07:58'
},
{
  id: 't4',
  role: 'molecule',
  text: 'Locked as hard constraints. Plan pln_8f21c4 is ready: 6 nodes, €27,987 total, €11.66 per unit, completing April 8.',
  at: '09:38',
  attachments: ['plan-pln_8f21c4.json', 'quote-northline.pdf']
}];


export const hardConstraints = [
'280 gsm minimum fabric weight',
'Woven label only',
'EU manufacturing',
'Landed before Apr 10'];