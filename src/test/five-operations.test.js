import {test,assert} from './runner.js';
import {generateToolpath,opsForMode} from '../engine/toolpath.js';
import {defaultParamsFor} from '../engine/op-defaults.js';
import {isFiveAxisOp} from '../engine/five/ops.js';
import {createOperation,createProject,serializeProject,deserializeProject} from '../doc/schema.js';
import {strategyCard} from '../app/op-catalog.js';
import {makeRevolved} from './fixtures.js';
import {MOVE_STRIDE,OP} from '../engine/cl.js';
import {simulateRemoval,SimulationPlayback} from '../engine/simulate.js';
import {paramApplies,OP_PARAM_GROUPS} from '../app/op-params.js';
const tool={number:1,type:'ball',diameter:4,fluteLength:20,spindleRpm:10000,feedCut:600,feedPlunge:200};
const stock={kind:'box',min:[-6,-6,0],max:[6,6,5]};
const outline=[[0,0],[4,0]];
for(let d=10;d<=90;d+=10)outline.push([4*Math.cos(d*Math.PI/180),4*Math.sin(d*Math.PI/180)]);
const mesh=makeRevolved(outline,36);
for(const [type,pattern] of [['finish5Concentric','concentric'],['finish5Spiral','spiral'],['finish5Radial','radial']]){
 test(`${type} migrates to a finish pattern and is absent from the operation picker`,()=>{
 assert.ok(!opsForMode('mill').includes(type));assert.ok(opsForMode('mill').includes('finish5'));assert.ok(!opsForMode('turn').includes(type));assert.ok(isFiveAxisOp('finish5'));
 assert.ok(strategyCard('finish5').summary);const params={...defaultParamsFor('finish5',{stock,tool}),pattern};assert.eq(params.pattern,pattern);
 const op=createOperation('finish5');Object.assign(op.params,params);assert.ok(OP_PARAM_GROUPS.flatMap(g=>g.fields).some(f=>f.key==='leadAngle'&&paramApplies(f,op)));
 const project=createProject();op.type=type;project.setups.push({id:'setup-test',mode:'mill',operations:[op]});
 const restored=deserializeProject(serializeProject(project));assert.eq(restored.setups[0].operations[0].type,'finish5');assert.eq(restored.setups[0].operations[0].params.pattern,pattern);
 });
 test(`${type} generates finite tilted motion and leaves the dome intact`,()=>{
 const params={...defaultParamsFor('finish5',{stock,tool}),pattern,topZ:5,bottomZ:0.3,clearanceHeight:12,stepover:0.25,tolerance:0.06,leadAngle:0};
 const cl=generateToolpath({type:'finish5',mesh,stock,tool,params});assert.ok(cl.count>20);assert.ok(cl.fiveAxis);assert.ok([...cl.moves].every(Number.isFinite));
 let minRadius=Infinity,cut=0,outward=0,inward=0,tangent=0,segments=0;
 for(let n=0;n<cl.count;n++){const o=n*MOVE_STRIDE;if(cl.moves[o]!==OP.LINE)continue;cut++;minRadius=Math.min(minRadius,Math.hypot(cl.moves[o+1],cl.moves[o+2]));}
 assert.ok(cut>10);assert.ok(minRadius<0.7);
 for(let n=1;n<cl.count;n++){
  const o=n*MOVE_STRIDE,q=o-MOVE_STRIDE,d=cl.moves;
  if(d[o]!==OP.LINE||d[q]!==OP.LINE)continue;
  const r0=Math.hypot(d[q+1],d[q+2]),r1=Math.hypot(d[o+1],d[o+2]);
  const length=Math.hypot(d[o+1]-d[q+1],d[o+2]-d[q+2]);
  if(length<0.01||r0<0.5||r1<0.5)continue;segments++;
  if(r1-r0>0.01)outward++;
  if(r0-r1>0.001)inward++;
  if(Math.abs(r1-r0)<0.01)tangent++;
 }
 assert.ok(segments>5);
 if(pattern==='radial'){assert.ok(outward/segments>0.3,`radial outward ${outward}/${segments}`);assert.ok(inward/segments>0.3,`radial inward ${inward}/${segments}`);}
 if(pattern==='spiral')assert.ok(inward/segments>0.8,`spiral inward ${inward}/${segments}`);
 if(pattern==='concentric')assert.ok(tangent/segments>0.8,`concentric ${tangent}/${segments}`);
 const sim=simulateRemoval({stock,ops:[{cl,tool}],maxCells:10000});const pb=new SimulationPlayback(sim);pb.seek(sim.stepCount);let gouge=0,excess=0;
 for(let j=0;j<sim.height;j++)for(let i=0;i<sim.width;i++){const x=sim.origin[0]+i*sim.cellSize,y=sim.origin[1]+j*sim.cellSize,r=x*x+y*y;if(r>9)continue;const truth=Math.sqrt(16-r),h=pb.current[j*sim.width+i];gouge=Math.max(gouge,truth-h);excess=Math.max(excess,h-truth);}
 assert.ok(gouge<0.12,`gouge ${gouge}`);assert.ok(excess<0.5,`excess ${excess}`);
 });
}

for (const pattern of ['zigzag', 'concentric', 'spiral', 'radial']) {
 test(`${pattern}: final tilted tips and links respect Bottom Z`, () => {
  const bottomZ = 2.8;
  const cl = generateToolpath({type:'finish5',mesh,stock,tool,params:{
   ...defaultParamsFor('finish5',{stock,tool}),pattern,topZ:5,bottomZ,
   clearanceHeight:12,stepover:0.25,tolerance:0.06,
   tiltMode:'fixed',leadAngle:35,maxTilt:40,
  }});
  let cuts = 0;
  for(let n=0;n<cl.count;n++) {
   const o=n*MOVE_STRIDE;
   if(cl.moves[o]!==OP.LINE) continue;
   cuts++;
   assert.ok(cl.moves[o+3]>=bottomZ-1e-6, `tip below window: ${cl.moves[o+3]}`);
  }
  assert.ok(cuts>3);
 });
}
test('unresolved holder interference refuses generation instead of returning a warning-only path', () => {
 const blockedMesh=makeRevolved([[0,0],[6,0],[6,5],[4,5],[4,1],[0,1]],48);
 const blockedTool={...tool,fluteLength:0.1,shank:[{diameter:4,length:0.1}],holder:[{diameter:30,length:20}]};
 let message='';
 try {generateToolpath({type:'finish5',mesh:blockedMesh,stock,tool:blockedTool,params:{
  ...defaultParamsFor('finish5',{stock,tool:blockedTool}),pattern:'radial',
  topZ:5,bottomZ:0.3,clearanceHeight:25,stepover:0.25,tolerance:0.06,
 }});} catch(e) {message=e.message;}
 assert.ok(message.includes('holder collision'),message || 'unsafe path was returned');
});

function controlled(pattern,extra={}) {
 return generateToolpath({type:'finish5',mesh,stock,tool,params:{
  ...defaultParamsFor('finish5',{stock,tool}),pattern,topZ:5,bottomZ:.3,
  clearanceHeight:12,stepover:.25,tolerance:.06,leadAngle:0,...extra,
 }});
}
test('spiral uses the requested setup-coordinate centre',()=>{
 const cl=controlled('spiral',{patternCenterX:.5,patternCenterY:-.5});
 let last;
 for(let n=0;n<cl.count;n++){const o=n*MOVE_STRIDE;if(cl.moves[o]===OP.LINE)last=[cl.moves[o+1],cl.moves[o+2]];}
 assert.close(last[0],.5,1e-6);assert.close(last[1],-.5,1e-6);
});
for(const direction of ['cw','ccw'])test(`concentric supports consistent ${direction} cutting`,()=>{
 const cl=controlled('concentric',{ringDirection:direction,tiltMode:'fixed',maxTilt:0});
 let good=0,total=0;
 for(let n=1;n<cl.count;n++){
  const o=n*MOVE_STRIDE,q=o-MOVE_STRIDE,d=cl.moves;
  if(d[o]!==OP.LINE||d[q]!==OP.LINE)continue;
  const r0=Math.hypot(d[q+1],d[q+2]),r1=Math.hypot(d[o+1],d[o+2]);
  const cross=d[q+1]*d[o+2]-d[q+2]*d[o+1];
  if(Math.abs(r0-r1)>.05||Math.abs(cross)<.01)continue;
  total++;if(direction==='cw'?cross<0:cross>0)good++;
 }
 assert.ok(total>20);assert.ok(good/total>.95,`${good}/${total}`);
});
for(const direction of ['inward','outward'])test(`radial supports ${direction} one-way spokes`,()=>{
 const cl=controlled('radial',{radialDirection:direction,tiltMode:'fixed',maxTilt:0});
 let good=0,total=0;
 for(let n=1;n<cl.count;n++){
  const o=n*MOVE_STRIDE,q=o-MOVE_STRIDE,d=cl.moves;
  if(d[o]!==OP.LINE||d[q]!==OP.LINE)continue;
  const delta=Math.hypot(d[o+1],d[o+2])-Math.hypot(d[q+1],d[q+2]);
  if(Math.abs(delta)<.01)continue;
  total++;if(direction==='outward'?delta>0:delta<0)good++;
 }
 assert.ok(total>20);assert.ok(good/total>.95,`${good}/${total}`);
});
test('circular controls are hidden for raster and exposed for their applicable patterns',()=>{
 const fields=OP_PARAM_GROUPS.flatMap(g=>g.fields);
 const op=createOperation('finish5');
 const centre=fields.find(f=>f.key==='patternCenterX');
 assert.ok(!paramApplies(centre,op));
 op.params.pattern='spiral';assert.ok(paramApplies(centre,op));
 assert.ok(!paramApplies(fields.find(f=>f.key==='ringDirection'),op));
 op.params.pattern='concentric';assert.ok(paramApplies(fields.find(f=>f.key==='ringDirection'),op));
});

test('closed concentric laps meet with the same tool orientation at their seam',()=>{
 const cl=controlled('concentric',{leadAngle:8,ringDirection:'ccw'});
 const seen=new Map();let loops=0;
 for(let n=0;n<cl.count;n++){
  const o=n*MOVE_STRIDE,d=cl.moves;if(d[o]!==OP.LINE)continue;
  const key=[d[o+1],d[o+2],d[o+3]].map(v=>v.toFixed(4)).join(',');
  const previous=seen.get(key);
  if(previous&&n-previous.n>6){
   const error=Math.hypot(d[o+4]-previous.axis[0],d[o+5]-previous.axis[1],d[o+6]-previous.axis[2]);
   assert.ok(error<1e-5,`orientation seam mismatch ${error}`);loops++;
  }
  seen.set(key,{n,axis:[d[o+4],d[o+5],d[o+6]]});
 }
 assert.ok(loops>=2,`${loops} closed laps tested`);
});

test('pattern centre and direction survive project save and reload',()=>{
 const project=createProject(),op=createOperation('finish5');
 Object.assign(op.params,{pattern:'concentric',patternCenterX:-12.5,patternCenterY:3.25,ringDirection:'cw',radialDirection:'inward'});
 project.setups.push({id:'saved-pattern',mode:'mill',operations:[op]});
 const params=deserializeProject(serializeProject(project)).setups[0].operations[0].params;
 assert.eq(params.patternCenterX,-12.5);assert.eq(params.patternCenterY,3.25);
 assert.eq(params.ringDirection,'cw');assert.eq(params.radialDirection,'inward');
});
