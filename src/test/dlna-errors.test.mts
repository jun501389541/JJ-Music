import test from 'node:test'
import assert from 'node:assert/strict'
const {dlnaFailure}=await import('./shared/dlna-errors.js')
test('DLNA errors classify actionable failures without exposing raw diagnostics',()=>{
 for(const [raw,code] of [['stop-unconfirmed','stop-unconfirmed'],['DLNA interface changed','network-changed'],['connect ECONNREFUSED 192.168.1.5','offline'],['ETIMEDOUT','timeout'],['EACCES','permission'],['Unsupported DLNA action','unsupported']])assert.equal(dlnaFailure(new Error(raw)).code,code)
 const result=dlnaFailure(new Error('secret https://host/audio/private-token C:\\music\\secret.mp3'))
 assert.equal(result.code,'unknown');assert.ok(!JSON.stringify(result).includes('secret'))
 assert.equal(dlnaFailure(null).code,'unknown')
 assert.equal(dlnaFailure(new Error('stop-unconfirmed')).requiresStopConfirmation,true)
})
