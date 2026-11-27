import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fileURLToPath } from "node:url";
import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";

const index = JSON.parse(readFileSync(new URL("../data/catalog.index.json", import.meta.url), "utf8"));
const normalized = loadRuntimeCatalog(fileURLToPath(new URL("..", import.meta.url))).catalog;

test("RAG index is built for the exact normalized catalog snapshot",()=>{
 assert.equal(index.catalog_version,normalized.version,"Stale index catalog version");
 assert.equal(index.entries.length,normalized.chunks.length,"Missing or extra indexed chunks");
 assert.ok(index.entries.length>0,"Index is empty");
});
test("every RAG profession and industry reference belongs to the runtime catalog",()=>{
 const professions=new Set(normalized.professions.map(p=>p.profession_id));
 const industries=new Set(normalized.industries.map(p=>p.id));
 const unknown=[];
 for(const e of index.entries){
  const p=e.metadata?.profession_id, i=e.metadata?.industry_id;
  if(p&&!professions.has(p))unknown.push('profession '+p);
  if(i&&!industries.has(i))unknown.push('industry '+i);
 }
 assert.deepEqual(unknown,[]);
});
test("RAG index vectors have a consistent finite dimension",()=>{
 const dimensions=new Set(index.entries.map(e=>e.vector?.length));
 assert.equal(dimensions.size,1,"Mixed embedding dimensions");
 assert.ok([...dimensions][0]>0,"Empty embedding vectors");
 for(const [i,e] of index.entries.entries()){
  assert.ok(e.vector.every(v=>typeof v==="number"&&Number.isFinite(v)),"Invalid vector at index "+i);
 }
});
