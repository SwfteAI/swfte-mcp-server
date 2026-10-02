import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from '../src/codemap/detect.js';
import { tagCallSites } from '../src/codemap/tag.js';
import { assigned, project } from './codemap-support.js';
import { buildManifest, serializeManifest } from '../src/codemap/manifest.js';
import { literalRevision, numericVersion, pathVersion } from '../src/codemap/revisions.js';

type Language = 'ts' | 'py' | 'java';
test('literal revision policy preserves raw strings and raw-path decoding is exactly once',()=>{
  for(const value of ['v3','custom@v3:release','0','-1','2147483648','a'.repeat(128)])assert.equal(literalRevision(value),value);
  for(const value of ['', '.', '..', '@:+-', 'v%33', 'v/3','v\\3',' v3','v3\n','a'.repeat(129)])assert.equal(literalRevision(value),null);
  assert.equal(literalRevision(3),null);assert.equal(numericVersion(2147483647),'2147483647');
  for(const value of [0,-1,2147483648,1.5,NaN])assert.equal(numericVersion(value),null);
  assert.equal(pathVersion('%76%33'),'v3');assert.equal(pathVersion('custom%40v3%3Arelease'),'custom@v3:release');
  for(const value of ['v%253A3','v%2F3','v%5C3','v%00three','%2e%2e','v%ZZ'])assert.equal(pathVersion(value),null);
});
function sdkSource(language: Language, versions: string[], wait = false): string {
  const calls = versions.map((version, index) => {
    const id = `wf_${index}`;
    if (language === 'ts') return `client.workflows.${wait ? 'invokeVersionAndWait' : 'invokeVersion'}('${id}', ${JSON.stringify(version)}, {amount:1}, {timeoutMs:1000});`;
    if (language === 'py') return `client.workflows.${wait ? 'invoke_version_and_wait' : 'invoke_version'}(workflow_id='${id}', version=${JSON.stringify(version)}, inputs={'amount':1})`;
    return `client.workflows().${wait ? 'invokeVersionAndWait' : 'invokeVersion'}("${id}", ${JSON.stringify(version)}, java.util.Map.of("amount", 1)${wait ? ', 1000, 10, false' : ''});`;
  });
  if (language === 'ts') return "import Swfte from '@swfte/sdk';\nconst client = new Swfte({});\n" + calls.join('\n');
  if (language === 'py') return 'from swfte import Swfte\nclient = Swfte()\n' + calls.join('\n');
  return 'import com.swfte.sdk.SwfteClient;\nclass Caller { void run(SwfteClient client) {\n' + calls.join('\n') + '\n} }';
}

for (const language of ['ts', 'py', 'java'] as const) {
  for (const wait of [false, true]) {
    test(`${language} ${wait ? 'wait' : 'invoke'} preserves actual semantic published-version identity and input position`, async () => {
      const versions = ['1.0.7', '2.1.0-beta.1+build.7', 'v3', 'custom@v3:release', '5', '1.2', '0', '-1', '2147483648', 'A'.repeat(80)];
      const path = `src/caller.${language}`;
      const root = project({[path]: sdkSource(language, versions, wait)});
      try {
        const result = await detectProject(root);
        const sites = result.sites.sort((left, right) => left.line - right.line);
        assert.equal(sites.length, versions.length);
        assert.deepEqual(sites.map(site => [site.artifact.id, site.artifact.pinnedVersion, site.artifact.unresolved, site.inputKeys]),
          versions.map((version, index) => [`wf_${index}`, version, false, ['amount']]));
        const rows = sites.map((site, index) => ({...assigned(path), site, id: `cs_${String(index + 1).padStart(24, '0')}`}));
        assert.deepEqual(tagCallSites(root, rows), [path]);
        const text = readFileSync(join(root, path), 'utf8');
        for (const version of versions) assert(text.includes(version), 'Tagging must preserve the exact version text');
        const after = (await detectProject(root)).sites.sort((left, right) => left.line - right.line);
        assert.deepEqual(after.map(site => [site.artifact.id, site.artifact.pinnedVersion, site.inputKeys]),
          versions.map((version, index) => [`wf_${index}`, version, ['amount']]));
        assert.deepEqual(tagCallSites(root, rows), [], 'Explicit semantic pin tagging is idempotent');
      } finally { rmSync(root, {recursive:true, force:true}); }
    });
  }

  test(`${language} malformed or path-changing string versions stay unknown`, async () => {
    const versions = ['', '.', '..', '@:+-', 'v%33', ' v3', 'v3 ', '../1.0.7', '1.0.7/../invoke', '1.0.7?live=true', '1.0.7#live', '1.0.7\n', 'A'.repeat(129)];
    const root = project({[`src/caller.${language}`]: sdkSource(language, versions)});
    try {
      const result = await detectProject(root);
      assert.equal(result.sites.length, versions.length);
      for (const site of result.sites) {
        assert.equal(site.artifact.id, null); assert.equal(site.artifact.pinnedVersion, null); assert.equal(site.artifact.unresolved, true);
      }
    } finally { rmSync(root, {recursive:true, force:true}); }
  });

  test(`${language} raw HTTP recognizes exact semantic and URI-encoded published pins`, async () => {
    const versions = ['1.0.7', '2.1.0-beta.1+build.7', 'v3', 'custom@v3:release', '0', '-1', '2147483648'];
    const url = (version: string) => JSON.stringify(`https://api.swfte.com/v2/workflows/wf_1/versions/${encodeURIComponent(version)}/invoke`);
    const text = language === 'ts' ? versions.map(version => `fetch(${url(version)}, {method:'POST'});`).join('\n')
      : language === 'py' ? 'import requests\n' + versions.map(version => `requests.post(${url(version)}, json={})`).join('\n')
        : 'import org.springframework.web.client.RestTemplate;\nclass Caller { void run(RestTemplate http) {\n'
          + versions.map(version => `http.postForObject(${url(version)}, null, String.class);`).join('\n') + '\n} }';
    const root = project({[`src/caller.${language}`]: text});
    try {
      const sites = (await detectProject(root)).sites.sort((left, right) => left.line - right.line);
      assert.deepEqual(sites.map(site => [site.artifact.id, site.artifact.pinnedVersion, site.managed]),
        versions.map(version => ['wf_1', version, 'raw-http']));
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
}

for (const language of ['ts', 'py', 'java'] as const) {
  test(`${language} actual numeric constants retain signed32bit bounds and managed dynamic stays conservative`, async () => {
    const values = ['1', '2147483647', '0', '-1', '2147483648'];
    const code = sdkSource(language, values).split('\n').map(line => {
      for (const value of values) line = line.replace(JSON.stringify(value), value);
      return line;
    }).join('\n');
    const root = project({[`src/caller.${language}`]: code});
    try {
      const result = (await detectProject(root)).sites.sort((a,b)=>a.line-b.line);
      assert.equal(result.length, values.length);
      assert.deepEqual(result.map(site=>[site.artifact.id,site.artifact.pinnedVersion,site.artifact.unresolved]),
        values.map((value,index)=>index<2 ? [`wf_${index}`,value,false] : [null,null,true]));
    } finally { rmSync(root,{recursive:true,force:true}); }
    const dynamic = sdkSource(language,['placeholder']).replace('"placeholder"', language==='ts'?'process.env.WORKFLOW_VERSION':language==='py'?'os.getenv("WORKFLOW_VERSION")':'System.getenv("WORKFLOW_VERSION")');
    const dynamicRoot = project({[`src/caller.${language}`]: language==='py'?'import os\n'+dynamic:dynamic});
    try { const sites=(await detectProject(dynamicRoot)).sites; assert.equal(sites.length,1);
      assert.equal(sites[0]!.artifact.id,null);assert.equal(sites[0]!.artifact.pinnedVersion,null);assert.equal(sites[0]!.artifact.unresolved,true);
    } finally { rmSync(dynamicRoot,{recursive:true,force:true}); }
  });
  test(`${language} labels81 through128 retain exact detection but old manifest rejects instead of truncating`, async () => {
    const labels=['A'.repeat(81),'B'.repeat(128)];const path=`src/caller.${language}`;
    const root=project({[path]:sdkSource(language,labels)});
    try {const sites=(await detectProject(root)).sites.sort((a,b)=>a.line-b.line);
      assert.deepEqual(sites.map(site=>site.artifact.pinnedVersion),labels);
      for(const site of sites){
        const input={repo:{id:'r_'+'1'.repeat(32),provider:'github' as const,defaultBranch:'main'},commitSha:'a'.repeat(40),
          scanner:'cli' as const,pathHashing:false,truncated:false,notAnalysed:{},envVarNames:[],sites:[{...assigned(path),site}]};
        const positive=buildManifest({...input,sites:[{...assigned(path),site:{...site,artifact:{...site.artifact,pinnedVersion:'A'.repeat(80)}}}]});
        assert.ok(serializeManifest(positive).includes('A'.repeat(80)));
        assert.throws(()=>buildManifest(input), /pinnedVersion|80/);
      }
    }finally{rmSync(root,{recursive:true,force:true});}
  });
}

test('opaque corpus answer rows independently bind exact pins as well as scanner classification', async()=>{
  const root=new URL('./fixtures/codemap/opaque-versions/',import.meta.url);
  const key=JSON.parse(readFileSync(new URL('answer-key.json',root),'utf8')) as {sites:Array<{path:string;line:number;category:string;artifact:{id:string;pinnedVersion:string}}>};
  const sites=(await detectProject(root.pathname)).sites;
  assert.equal(sites.length,key.sites.length);
  for(const row of key.sites){const matches=sites.filter(site=>site.relPath===row.path&&site.line===row.line);
    assert.equal(matches.length,1);assert.equal(matches[0]!.category,row.category);assert.equal(matches[0]!.artifact.id,row.artifact.id);
    assert.equal(matches[0]!.artifact.pinnedVersion,row.artifact.pinnedVersion);assert.equal(matches[0]!.artifact.unresolved,false);
  }
});
