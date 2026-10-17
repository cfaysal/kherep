import fs from "node:fs";

export function publishOutcome(outcome: string, value: string): void {
  const staged = `${outcome}.pending`;
  fs.writeFileSync(staged, value, { flag: "wx" });
  try { fs.linkSync(staged, outcome); }
  finally { fs.unlinkSync(staged); }
}

interface ContenderOptions { outcome: string; gate: string; releaseGate: string; file: string; moduleUrl: string; stalePid: number }

export function reclaimContenderProgram({ outcome, gate, releaseGate, file, moduleUrl, stalePid }: ContenderOptions): string {
  return `import fs from "node:fs";import{acquireServiceOwnerFile,defaultServiceOwnerProbe as p}from ${JSON.stringify(moduleUrl)};`
    + `const publishOutcome=${publishOutcome.toString()};`
    + `while(!fs.existsSync(${JSON.stringify(gate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`
    + `const probe={current:()=>p.current(),active:o=>o.pid===${stalePid}?false:p.active(o)};`
    + `try{const release=acquireServiceOwnerFile(${JSON.stringify(file)},"synthetic active",probe);publishOutcome(${JSON.stringify(outcome)},"owned");console.log("owned");`
    + `while(!fs.existsSync(${JSON.stringify(releaseGate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`
    + `release()}catch(error){publishOutcome(${JSON.stringify(outcome)},"blocked");console.log("blocked:"+error.message)}`;
}
