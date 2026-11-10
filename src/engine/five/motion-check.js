// Bounded spatial/angular sampling shared by finishing and linking checks.
import {angleBetween, blendAxis} from './tilt-sweep.js';
export function checkMotion(a, b, {spacing, angleStep=1, maxSamples=4096, check}) {
  if (!(spacing>0) || !(angleStep>0)) throw new Error('Invalid motion-check resolution');
  const distance=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);
  const count=Math.max(1,Math.ceil(distance/spacing),Math.ceil(angleBetween(a.a,b.a)/angleStep));
  if (!Number.isFinite(count) || count>maxSamples) return {ok:false,reason:'motion verification sample budget exceeded'};
  for(let k=0;k<=count;k++) {
    const t=k/count;
    const pose={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,a:blendAxis(a.a,b.a,t)};
    const reason=check(pose);
    if(reason) return {ok:false,reason,pose,fraction:t};
  }
  return {ok:true};
}
