// Run: node src/test/five-pattern-benchmark.js
import {generateToolpath} from '../engine/toolpath.js';
import {defaultParamsFor} from '../engine/op-defaults.js';
import {makeRevolved} from './fixtures.js';
import {MOVE_STRIDE,OP} from '../engine/cl.js';
const tool={number:1,type:'ball',diameter:6,fluteLength:20,spindleRpm:10000,feedCut:800,feedPlunge:200};
const stock={kind:'box',min:[-10,-10,0],max:[10,10,9]};
const outline=[[0,0],[8,0]];
for(let d=5;d<=90;d+=5)outline.push([8*Math.cos(d*Math.PI/180),8*Math.sin(d*Math.PI/180)]);
const mesh=makeRevolved(outline,48);
for(const pattern of ['zigzag','concentric','spiral','radial']) {
 const start=performance.now();
 const cl=generateToolpath({type:'finish5',mesh,tool,stock,params:{...defaultParamsFor('finish5',{stock,tool}),pattern,topZ:9,bottomZ:.5,clearanceHeight:20,stepover:.2,tolerance:.04,leadAngle:0}});
 let rapid=0,rapidLength=0,feedLength=0,previous=null;
 for(let n=0;n<cl.count;n++) {
  const o=n*MOVE_STRIDE,d=cl.moves;
  if(d[o]!==OP.LINE&&d[o]!==OP.RAPID)continue;
  const p=[d[o+1],d[o+2],d[o+3]];
  if(d[o]===OP.RAPID)rapid++;
  if(previous){const length=Math.hypot(...p.map((v,i)=>v-previous[i]));if(d[o]===OP.RAPID)rapidLength+=length;else feedLength+=length;}
  previous=p;
 }
 console.log(JSON.stringify({pattern,moves:cl.count,rapid,rapidLength,feedLength,generationMs:performance.now()-start}));
}
