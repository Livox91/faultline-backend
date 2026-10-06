const test=require('node:test');
const assert=require('node:assert/strict');
const N=require('@faultline/notifications');
const {VoiceAgentController}=require('../apps/api/dist/voice-agent.controller.js');

const user={id:'admin-1',organizationId:'org',email:'admin@example.com',username:'admin',name:'Admin',role:'Admin',status:'active',mfaEnabled:false,mustChangePassword:false,assignments:[]};

test('voice dashboard returns safe status and queues a one-time destination test call',async()=>{
  const statuses=new N.InMemoryNotificationProviderStatusRepository();
  await statuses.save({organizationId:'org',provider:'retell',configured:true,connected:true,maskedFromNumber:'+••••4567',voiceAgentConfigured:true,smsAgentConfigured:false,checkedAt:new Date().toISOString(),message:'Connected'});
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
  const result=await controller.testCall(user,{phoneNumber:'+15559876543'});
  assert.equal(result.status,'QUEUED');
  assert.equal(published.message.payload.phoneNumber,'+15559876543');
  assert.equal(published.message.payload.userId,undefined);
  assert.equal(result.maskedPhoneNumber.endsWith('6543'),true);
  assert.equal(audited.action,'voice-agent.test-call.requested');
  assert.doesNotMatch(JSON.stringify(audited),/15559876543/);
});

test('voice dashboard validates a one-time test destination without requiring an Admin contact',async()=>{
  const controller=new VoiceAgentController(new N.InMemoryNotificationProviderStatusRepository(),new N.InMemoryIncidentCommunicationRepository(),new N.InMemoryContactRepository(),{async publish(){throw new Error('must not publish');}},{async record(){}});
  await assert.rejects(()=>controller.testCall(user,{phoneNumber:'555-123'}),/valid international E\.164/);
});

test('voice dashboard refuses to present an old worker heartbeat as connected',async()=>{
  const statuses=new N.InMemoryNotificationProviderStatusRepository();
  await statuses.save({organizationId:'org',provider:'retell',configured:true,connected:true,voiceAgentConfigured:true,smsAgentConfigured:true,checkedAt:'2020-01-01T00:00:00Z',message:'Connected'});
  const controller=new VoiceAgentController(statuses,new N.InMemoryIncidentCommunicationRepository(),new N.InMemoryContactRepository(),{async publish(){}},{async record(){}});
  const result=await controller.status(user);
  assert.equal(result.connected,false);assert.equal(result.stale,true);assert.match(result.message,/stale/);
});

test('voice dashboard uses the deployment-wide worker heartbeat across organizations',async()=>{
  const statuses=new N.InMemoryNotificationProviderStatusRepository();
  await statuses.save({organizationId:'worker-default',provider:'retell',configured:true,connected:true,voiceAgentConfigured:true,smsAgentConfigured:true,checkedAt:new Date().toISOString(),message:'Connected'});
  const controller=new VoiceAgentController(statuses,new N.InMemoryIncidentCommunicationRepository(),new N.InMemoryContactRepository(),{async publish(){}},{async record(){}});
  const result=await controller.status(user);
  assert.equal(result.organizationId,'org');assert.equal(result.connected,true);assert.equal(result.voiceAgentConfigured,true);assert.equal(result.smsAgentConfigured,true);
});
