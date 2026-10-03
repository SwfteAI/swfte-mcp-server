import test from 'node:test';
import assert from 'node:assert/strict';
import { argsOf, declaredType, evalPieces, literalOf, lookupName, nameOf, symbolOf, walk, withTree } from '../src/codemap/detectors/java/parse.js';

function probes(body: string) {
  const result = withTree(body, root => {
    const rows: Array<{symbol:string; name:string; value:string|null; bound:string; type:string|null}> = [];
    walk(root, call => {
      if (call.type !== 'method_invocation' || nameOf(call) !== 'probe') return;
      const arg = argsOf(call)[0]!;
      const found = lookupName(arg.text, arg);
      rows.push({symbol:symbolOf(call),name:arg.text,value:literalOf(evalPieces(arg)),
        bound:found === null ? 'missing' : found === 'opaque' ? 'opaque' : 'env' in found ? 'env:'+found.env : 'node',
        type:declaredType(arg.text,arg)});
    });
    return rows;
  });
  assert.notEqual(result,null,'actual Java grammar must parse the fixture');
  return result!;
}

test('scope index keeps parameter and local shadowing over class fields', () => {
  const rows=probes(`class Scope {
    String target="wf_field";
    void field(){probe(target);}
    void parameter(String target){probe(target);}
    void local(){String target="wf_local";probe(target);}
  }`);
  assert.deepEqual(rows.map(row=>[row.value,row.bound,row.type]),[
    ['wf_field','node','String'],[null,'opaque','String'],['wf_local','node','String']]);
});

test('all-name lookup preserves conflicting assignments, equal assignments and update opacity', () => {
  const rows=probes(`class Scope {void go(){
    String a="wf_A";a="wf_B";probe(a);
    String b="wf_B";b="wf_B";probe(b);
    String c="wf_C";c+="!";probe(c);
    int n=1;n++;probe(n);
    for(String loop:items){probe(loop);}
  }}`);
  assert.deepEqual(rows.map(row=>[row.name,row.value,row.bound]),[
    ['a',null,'opaque'],['b','wf_B','node'],['c',null,'opaque'],['n',null,'opaque'],['loop',null,'opaque']]);
});

test('nested lambda and local class bindings and types do not pollute the outer method', () => {
  const rows=probes(`class Scope {void outer(){
    String target="wf_outer";
    Runnable task=()->{int target=1;probe(target);};
    class Inner {void go(){long target=2;probe(target);}}
    probe(target);
  }}`);
  assert.deepEqual(rows.map(row=>[row.value,row.type]),[[null,'int'],[null,'long'],['wf_outer','String']]);
});

test('lambda parameter shadows an outer HTTP type instead of inheriting it', () => {
  const rows=probes(`class Scope {java.net.http.HttpClient client;void outer(){
    probe(client);
    java.util.function.Consumer<Object> task=(client)->probe(client);
  }}`);
  assert.equal(rows[0]!.type,'java.net.http.HttpClient');
  assert.equal(rows[1]!.bound,'opaque');
  assert.equal(rows[1]!.type,null);
});

test('binding index handles absent names and distinct native wrappers without mixing trees', () => {
  const one=probes(`class Scope {void go(){String known="wf_one";probe(known);probe(absent);}}`);
  const two=probes(`class Scope {void go(){String known="wf_two";probe(known);probe(absent);}}`);
  assert.deepEqual(one.map(row=>[row.value,row.bound]),[['wf_one','node'],[null,'missing']]);
  assert.deepEqual(two.map(row=>[row.value,row.bound]),[['wf_two','node'],[null,'missing']]);
});

test('class field index preserves final constants, nearest-class shadowing and record types', () => {
  const rows=probes(`class Scope {static final String target="wf_outer";void outer(){probe(target);}
    class Inner {static final String target="wf_inner";void go(){probe(target);}}
  }
  record Rec(String target){void go(){probe(target);}}`);
  assert.deepEqual(rows.map(row=>[row.value,row.type]),[['wf_outer','String'],['wf_inner','String'],[null,'String']]);
});

test('class field assignments and updates stay opaque instead of reviving initializer evidence', () => {
  const rows=probes(`class Scope {String different="wf_A";String equal="wf_B";String appended="wf_C";int counter=1;
    void mutate(){different="wf_D";equal="wf_B";this.appended+="!";counter++;}
    void go(){probe(different);probe(equal);probe(appended);probe(counter);}
  }`);
  assert.deepEqual(rows.map(row=>[row.value,row.bound]),[[null,'opaque'],[null,'opaque'],[null,'opaque'],[null,'opaque']]);
});
