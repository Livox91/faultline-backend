const test=require('node:test');
const assert=require('node:assert/strict');
const N=require('@faultline/notifications');
const {VoiceAgentController}=require('../apps/api/dist/voice-agent.controller.js');

const user={id:'admin-1',organizationId:'org',email:'admin@example.com',username:'admin',name:'Admin',role:'Admin',status:'active',mfaEnabled:false,mustChangePassword:false,assignments:[]};

test('voice dashboard returns safe status, masked deliveries, and queues an Admin test call',async()=>{
  const statuses=new N.InMemoryNotificationProviderStatusRepository();
  await statuses.save({organizationId:'org',provider:'retell',configured:true,connected:true,maskedFromNumber:'+••••4567',voiceAgentConfigured:true,smsAgentConfigured:false,checkedAt:'2026-01-01T00:00:00Z',message:'Connected'});
  const communications=new N.InMemoryIncidentCommunicationRepository();
  await communications.save({id:'comm-1',incidentId:'inc-1',organizationId:'org',audience:'ENGINEERING',channel:'VOICE',recipientId:'contact-1',communicationType:'INITIAL',messageVersion:'v1',status:'DELIVERED',createdAt:'2026-01-01T00:00:00Z',dedupeKey:'one'});
  const contacts=new N.InMemoryContactRepository();
  await contacts.create({id:'contact-1',organizationId:'org',userId:user.id,name:'Head Engineer',role:'TEAM_LEAD',phoneNumber:'+15551234567',smsEnabled:false,voiceEnabled:true,enabled:true,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});
  let published;let audited;
  const controller=new VoiceAgentController(statuses,communications,contacts,{async publish(topic,message){published={topic,message};}},{async record(value){audited=value;}});
  assert.equal((await controller.status(user)).connected,true);
  const deliveries=await controller.deliveries(user);
  assert.equal(deliveries[0].sreName,'Head Engineer');
  assert.equal(deliveries[0].maskedPhoneNumber.endsWith('4567'),true);
  assert.doesNotMatch(JSON.stringify(deliveries),/15551234567/);
  const result=await controller.testCall(user);
  assert.equal(result.status,'QUEUED');
  assert.equal(published.message.payload.userId,user.id);
  assert.equal(audited.action,'voice-agent.test-call.requested');
});

test('voice dashboard refuses a test call when the Admin has no callable contact',async()=>{
  const controller=new VoiceAgentController(new N.InMemoryNotificationProviderStatusRepository(),new N.InMemoryIncidentCommunicationRepository(),new N.InMemoryContactRepository(),{async publish(){throw new Error('must not publish');}},{async record(){}});
  await assert.rejects(()=>controller.testCall(user),/does not have an enabled voice contact/);
});
