const test=require('node:test');
const assert=require('node:assert/strict');
const PDFDocument=require('pdfkit');
const N=require('../packages/notifications/dist/index.js');
const {NotificationService}=require('../apps/notification/dist/notification.service.js');
const {IncidentMessageBuilder}=require('../apps/notification/dist/message-builder.js');
const {EndUserSmsController}=require('../apps/api/dist/end-user-sms.controller.js');
const {IncidentsController}=require('../apps/api/dist/incidents.controller.js');
const {ApplicationLogger}=require('../packages/platform/dist/index.js');

const incident=(changes={})=>({id:'inc-sms',correlationKey:'key',clusterId:'cluster-a',namespace:'prod',primaryResource:{clusterId:'cluster-a',namespace:'prod',workload:'payments'},affectedResources:[],classification:'APPLICATION_DEGRADATION',title:'Payments unavailable',summary:'Requests fail',severity:'CRITICAL',status:'OPEN',logicalService:'payments',estimatedRestorationAt:'2026-10-04T15:30:00.000Z',confidence:1,firstSeen:'2026-10-04T15:00:00.000Z',lastSeen:'2026-10-04T15:01:00.000Z',anomalies:[],evidence:[],timeline:[],...changes});
const lifecycle=(type,value=incident())=>({id:`event-${type}`,type,incident:value,state:type==='INCIDENT_RESOLVED'?'RESOLVED':'OPEN',occurredAt:'2026-10-04T15:01:00.000Z',changedFields:type==='INCIDENT_ETA_UPDATED'?['estimatedRestorationAt']:[]});

test('end-user SMS lifecycle is cluster/service scoped, includes ETA and is idempotent',async()=>{
  const endUsers=new N.InMemoryEndUserContactRepository(),communications=new N.InMemoryIncidentCommunicationRepository(),attempts=new N.InMemoryNotificationAttemptRepository();
  const now=new Date().toISOString();
  for(const value of [{id:'matching',clusterId:'cluster-a',service:'payments'},{id:'wrong-service',clusterId:'cluster-a',service:'search'},{id:'wrong-cluster',clusterId:'cluster-b',service:'payments'}])await endUsers.upsert({...value,organizationId:'org',name:value.id,email:`${value.id}@example.com`,phoneNumber:`+1555000000${value.id==='matching'?'1':value.id==='wrong-service'?'2':'3'}`,enabled:true,createdAt:now,updatedAt:now});
  const sent=[];const provider={name:'retell',async sendSms(input){sent.push(input);return{requestId:`chat-${sent.length}`,status:'SENT'};},async startVoiceCall(){throw new Error('not used');},async getCallStatus(id){return{requestId:id,status:'SENT'};}};
  const service=new NotificationService(new N.SeverityNotificationPolicy(),{},provider,attempts,new N.InMemoryIncidentNotificationStateRepository(),new N.InMemoryNotificationAuditRepository(),new N.InMemoryIdempotencyStore(),new IncidentMessageBuilder(),new ApplicationLogger('test','fatal'),communications,{async getIncident(){return undefined;}},{async get(){return undefined;}},endUsers);
  const opened=lifecycle('INCIDENT_CREATED');await service.handleEndUserLifecycle(opened,'org');await service.handleEndUserLifecycle(opened,'org');
  assert.equal(sent.length,1);assert.equal(sent[0].recipient.id,'matching');assert.match(sent[0].message,/currently unavailable/);assert.match(sent[0].message,/15:30 UTC/);
  await service.handleEndUserLifecycle(lifecycle('INCIDENT_ETA_UPDATED',incident({estimatedRestorationAt:'2026-10-04T16:00:00.000Z'})),'org');
  await service.handleEndUserLifecycle(lifecycle('INCIDENT_RESOLVED',incident({status:'RESOLVED',resolvedAt:'2026-10-04T15:45:00.000Z'})),'org');
  assert.deepEqual(sent.map(item=>item.metadata.communicationType),['INITIAL','ETA_UPDATE','RESOLUTION']);
  assert.match(sent[2].message,/Normal service has been restored/);
});

test('SMS agent imports CSV and JSON contacts and keeps them in the selected cluster',async()=>{
  const contacts=new N.InMemoryEndUserContactRepository(),statuses=new N.InMemoryNotificationProviderStatusRepository(),communications=new N.InMemoryIncidentCommunicationRepository();let published;
  await statuses.save({organizationId:'org',provider:'retell',configured:true,connected:true,voiceAgentConfigured:true,smsAgentConfigured:true,checkedAt:new Date().toISOString(),message:'Connected'});
  const controller=new EndUserSmsController({async get(id,org){return id==='cluster-a'&&org==='org'?{id,name:'A'}:undefined;}},contacts,statuses,communications,{async publish(topic,message){published={topic,message};}});
  const user={id:'admin',organizationId:'org',role:'admin'};
  const csv=await controller.import('cluster-a',user,{originalname:'contacts.csv',mimetype:'text/csv',buffer:Buffer.from('name,email,contact,service\nAda,ada@example.com,+15551234567,payments')},{consentConfirmed:'true'});
  assert.equal(csv.imported,1);assert.equal(csv.rejected,0);
  const json=await controller.import('cluster-a',user,{originalname:'contacts.json',mimetype:'application/json',buffer:Buffer.from(JSON.stringify([{name:'Lin',email:'lin@example.com',contact:'+15557654321',service:'*'}]))},{consentConfirmed:'true'});
  assert.equal(json.imported,1);assert.equal((await controller.dashboard('cluster-a',user)).contacts.length,2);
  await assert.rejects(()=>controller.dashboard('cluster-b',user),/Cluster not found/);
  const queued=await controller.test('cluster-a',user);assert.equal(queued.status,'QUEUED');assert.equal(published.topic,'notifications.test-sms.requested');
});

test('SMS agent accepts a text-based PDF template and reports invalid rows',async()=>{
  const controller=new EndUserSmsController({async get(){return{id:'cluster-a'};}},new N.InMemoryEndUserContactRepository(),new N.InMemoryNotificationProviderStatusRepository(),new N.InMemoryIncidentCommunicationRepository(),{async publish(){}});
  const chunks=[];const document=new PDFDocument();document.on('data',chunk=>chunks.push(chunk));const ended=new Promise(resolve=>document.on('end',resolve));document.fontSize(11).text('name,email,contact,service').text('Grace,grace@example.com,+15550001111,payments');document.end();await ended;
  const result=await controller.import('cluster-a',{organizationId:'org'},{originalname:'contacts.pdf',mimetype:'application/pdf',buffer:Buffer.concat(chunks)},{consentConfirmed:'true'});
  assert.equal(result.imported,1);
  const bad=await controller.import('cluster-a',{organizationId:'org'},{originalname:'bad.csv',mimetype:'text/csv',buffer:Buffer.from('name,email,contact,service\nBad,bad@example.com,0300,payments')},{consentConfirmed:'true'});
  assert.equal(bad.imported,0);assert.equal(bad.rejected,1);assert.match(bad.errors[0],/E.164/);
});

test('a confirmed restoration estimate is persisted and publishes an SMS lifecycle update',async()=>{
  let value=incident({estimatedRestorationAt:undefined}),published;
  const controller=new IncidentsController({async getIncident(){return value;},async updateIncident(next){value=next;return next;}},{async resolve(){return{};}},{async publish(topic,message){published={topic,message};}});
  const eta=new Date(Date.now()+3600000).toISOString();const updated=await controller.updateEta({status:'active',assignments:[{projectId:'cluster-a'}]},value.id,{estimatedRestorationAt:eta});
  assert.equal(updated.estimatedRestorationAt,eta);assert.equal(published.topic,'incidents.lifecycle');assert.equal(published.message.payload.type,'INCIDENT_ETA_UPDATED');
});
