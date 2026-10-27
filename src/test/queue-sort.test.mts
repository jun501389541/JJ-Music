import assert from 'node:assert/strict'
import {test} from 'node:test'
const local=(id,name=id,singer='')=>({id,path:'E:/generated/'+id+'.wav',name,singer})
test('queue sort four modes normalize natural numbers and keep equal groups stable with blanks last',async()=>{
 const {planQueueSort}=await import('./shared/queue-sort.js')
 const q=[local('ten','Song10','乙'),local('two','Ｓｏｎｇ２','阿'),local('equal','song2','阿'),local('blank','  ',' ')]
 for(const field of ['name','singer']){
  assert.deepEqual(planQueueSort(q,1,field,'asc').queue.map(t=>t.id),['two','equal','ten','blank'])
  assert.deepEqual(planQueueSort(q,1,field,'desc').queue.map(t=>t.id),['ten','two','equal','blank'])
 }
 assert.equal(q[1].name,'Ｓｏｎｇ２')
})
test('queue sort maps exact duplicate current occurrence and preserves every original object and identity',async()=>{
 const {planQueueSort}=await import('./shared/queue-sort.js'),a=local('same','Z'),b={...local('same','A'),source:undefined},online={id:'same',source:'wy',name:'B'},q=[a,online,b],copy=[...q]
 const r=planQueueSort(q,2,'name','asc');assert.deepEqual(r.queue,[b,online,a]);assert.equal(r.currentIndex,0);assert.equal(r.queue[0],q[2]);assert.deepEqual(q,copy);assert.equal(r.changed,true)
 const shared=local('shared','N'),s=planQueueSort([shared,local('a','A'),shared],2,'name','asc')
 assert.equal(s.currentIndex,2);assert.equal(s.queue[1],shared);assert.equal(s.queue[2],shared)
})
test('queue sort treats missing metadata as blank and compares combined singers as displayed',async()=>{
 const {planQueueSort}=await import('./shared/queue-sort.js'),q=[local('none',null,undefined),local('combo','Z','A / B'),local('single','A','A')]
 assert.deepEqual(planQueueSort(q,-1,'singer','asc').queue.map(t=>t.id),['single','combo','none'])
 assert.equal(planQueueSort(q,-1,'name','desc').queue.at(-1),q[0])
})
test('queue sort validates options and index and detects true no-ops without reversing ties',async()=>{
 const {planQueueSort}=await import('./shared/queue-sort.js'),q=[local('1','a'),local('2','A')]
 for(const direction of ['asc','desc'])assert.equal(planQueueSort(q,1,'name',direction).changed,false)
 assert.equal(planQueueSort([],-1,'name','asc').changed,false);assert.equal(planQueueSort([q[0]],-1,'name','asc').currentIndex,-1)
 for(const [i,f,d] of [[-2,'name','asc'],[2,'name','asc'],[NaN,'name','asc'],[0,'id','asc'],[0,'name','reverse']])assert.throws(()=>planQueueSort(q,i,f,d))
})
