import {test,assert} from './runner.js';
import {checkMotion} from '../engine/five/motion-check.js';
const a={x:0,y:0,z:0,a:[0,0,1]},b={x:10,y:0,z:0,a:[0,0,1]};
test('motion verification detects interference between clear endpoints',()=>{
 const result=checkMotion(a,b,{spacing:.1,check:p=>p.x>4.9&&p.x<5.1?'obstacle':null});
 assert.ok(!result.ok);assert.eq(result.reason,'obstacle');assert.ok(result.fraction>0&&result.fraction<1);
});
test('motion verification samples stationary orientation changes',()=>{
 const end={...a,a:[1,0,0]};let count=0;
 const result=checkMotion(a,end,{spacing:.1,angleStep:1,check:p=>{count++;return p.a[0]>.5&&p.a[0]<.8?'body':null;}});
 assert.ok(!result.ok);assert.ok(count>1);assert.eq(result.reason,'body');
});
test('motion verification refuses unchecked segments when its budget is exceeded',()=>{
 let called=false;const result=checkMotion(a,b,{spacing:.0001,maxSamples:10,check:()=>{called=true;}});
 assert.ok(!result.ok);assert.ok(!called);assert.ok(result.reason.includes('budget'));
});
