import {test,assert} from './runner.js';
import {generateToolpath} from '../engine/toolpath.js';
import {defaultParamsFor} from '../engine/op-defaults.js';
import {makeRevolved} from './fixtures.js';
import {MOVE_STRIDE,OP} from '../engine/cl.js';
import {simulateRemoval,SimulationPlayback} from '../engine/simulate.js';
const tool={number:1,type:'ball',diameter:6,fluteLength:20,spindleRpm:10000,feedCut:800,feedPlunge:200};
const stock={kind:'box',min:[-10,-10,0],max:[10,10,9]};
const outline=[[0,0],[8,0]];
for(let d=5;d<=90;d+=5)outline.push([8*Math.cos(d*Math.PI/180),8*Math.sin(d*Math.PI/180)]);
const mesh=makeRevolved(outline,48);
function generate(pattern, five){return generateToolpath({type:'finish5',mesh,tool,stock,five,params:{...defaultParamsFor('finish5',{stock,tool}),pattern,topZ:9,bottomZ:0.5,clearanceHeight:20,stepover:0.2,tolerance:0.04,leadAngle:0}});}
test('concentric finish circles a round part and covers its centre without raster reversals',()=>{
 const cl=generate('concentric');let tangents=0,cuts=0,inner=Infinity;
 for(let n=1;n<cl.count;n++){
 const o=n*MOVE_STRIDE,p=o-MOVE_STRIDE,d=cl.moves;
 if(d[o]!==OP.LINE||d[p]===OP.RAPID)continue;
 const x=(d[o+1]+d[p+1])/2,y=(d[o+2]+d[p+2])/2;
 const dx=d[o+1]-d[p+1],dy=d[o+2]-d[p+2];const len=Math.hypot(dx,dy),r=Math.hypot(x,y);
 if(len<1e-6)continue;cuts++;inner=Math.min(inner,r);
 if(r>2&&Math.abs(x*dx+y*dy)/(r*len)<0.1)tangents++;
 }
 assert.ok(cuts>50);assert.ok(tangents/cuts>0.75,`${tangents}/${cuts} tangential`);assert.ok(inner<1);
});
test('concentric finish does not gouge the known dome surface',()=>{
 const cl=generate('concentric');const sim=simulateRemoval({stock,ops:[{cl,tool}],maxCells:20000});
 const pb=new SimulationPlayback(sim);pb.seek(sim.stepCount);let gouge=0,proud=0;
 for(let j=0;j<sim.height;j++)for(let i=0;i<sim.width;i++){
 const x=sim.origin[0]+i*sim.cellSize,y=sim.origin[1]+j*sim.cellSize,r2=x*x+y*y;if(r2>36)continue;
 const truth=Math.sqrt(64-r2),h=pb.current[j*sim.width+i];gouge=Math.max(gouge,truth-h);proud=Math.max(proud,h-truth);
 }
 assert.ok(gouge<0.08,`gouge ${gouge}`);assert.ok(proud<0.5,`excess ${proud}`);
});


test('radial dome finish avoids a full retract for every spoke', () => {
 const cl=generate('radial');
 let rapid=0;
 for(let n=0;n<cl.count;n++) if(cl.moves[n*MOVE_STRIDE]===OP.RAPID) rapid++;
 assert.ok(rapid<100, `${rapid} rapid moves; original path had 300`);
});
