export interface OnCallSchedule {
  id: string;
  organizationId: string;
  teamId: string;
  name: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OnCallShift {
  id: string;
  scheduleId: string;
  contactId: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnCallAssignment {
  scheduleId: string;
  contactId: string;
  shift: OnCallShift;
  override?: AvailabilityOverride;
  validUntil: string;
}

export interface AvailabilityOverride {
  id: string;
  scheduleId: string;
  replacementContactId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnCallScheduleRepository { create(value:OnCallSchedule):Promise<OnCallSchedule>; update(value:OnCallSchedule):Promise<OnCallSchedule>; get(id:string):Promise<OnCallSchedule|undefined>; list(organizationId?:string):Promise<readonly OnCallSchedule[]>; }
export interface OnCallShiftRepository { create(value:OnCallShift):Promise<OnCallShift>; get(id:string):Promise<OnCallShift|undefined>; listForSchedule(scheduleId:string):Promise<readonly OnCallShift[]>; findActive(scheduleId:string,at:string):Promise<OnCallShift|undefined>; hasOverlap(scheduleId:string,startsAt:string,endsAt:string,excludeId?:string):Promise<boolean>; }
export interface AvailabilityOverrideRepository { create(value:AvailabilityOverride):Promise<AvailabilityOverride>; get(id:string):Promise<AvailabilityOverride|undefined>; listForSchedule(scheduleId:string):Promise<readonly AvailabilityOverride[]>; findActive(scheduleId:string,at:string):Promise<AvailabilityOverride|undefined>; hasOverlap(scheduleId:string,startsAt:string,endsAt:string,excludeId?:string):Promise<boolean>; }

export function isValidTimezone(value:string):boolean { try { new Intl.DateTimeFormat('en-US',{timeZone:value}).format(); return true; } catch { return false; } }
export function normalizeInstant(value:string):string { const time=Date.parse(value); if(!Number.isFinite(time))throw new Error('Timestamp must include a valid timezone-aware instant'); if(!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))throw new Error('Timestamp must include Z or an explicit UTC offset'); return new Date(time).toISOString(); }
export function validateTimeRange(startsAt:string,endsAt:string):{startsAt:string;endsAt:string}{const start=normalizeInstant(startsAt),end=normalizeInstant(endsAt);if(end<=start)throw new Error('endsAt must be after startsAt');return{startsAt:start,endsAt:end};}

abstract class MemoryScheduleChildren<T extends {id:string;scheduleId:string;startsAt:string;endsAt:string}>{protected values=new Map<string,T>();async create(value:T){if(this.values.has(value.id))throw new Error('Entity already exists');this.values.set(value.id,structuredClone(value));return structuredClone(value);}async get(id:string){const value=this.values.get(id);return value?structuredClone(value):undefined;}async listForSchedule(id:string){return[...this.values.values()].filter(v=>v.scheduleId===id).sort((a,b)=>a.startsAt.localeCompare(b.startsAt)).map(v=>structuredClone(v));}async findActive(id:string,at:string){const value=[...this.values.values()].find(v=>v.scheduleId===id&&v.startsAt<=at&&at<v.endsAt);return value?structuredClone(value):undefined;}async hasOverlap(id:string,start:string,end:string,excludeId?:string){return[...this.values.values()].some(v=>v.scheduleId===id&&v.id!==excludeId&&v.startsAt<end&&start<v.endsAt);}}
export class InMemoryOnCallScheduleRepository implements OnCallScheduleRepository {private values=new Map<string,OnCallSchedule>();async create(v:OnCallSchedule){if(this.values.has(v.id))throw new Error('Entity already exists');this.values.set(v.id,structuredClone(v));return structuredClone(v);}async update(v:OnCallSchedule){if(!this.values.has(v.id))throw new Error('Entity not found');this.values.set(v.id,structuredClone(v));return structuredClone(v);}async get(id:string){const v=this.values.get(id);return v?structuredClone(v):undefined;}async list(org?:string){return[...this.values.values()].filter(v=>!org||v.organizationId===org).map(v=>structuredClone(v));}}
export class InMemoryOnCallShiftRepository extends MemoryScheduleChildren<OnCallShift> implements OnCallShiftRepository {}
export class InMemoryAvailabilityOverrideRepository extends MemoryScheduleChildren<AvailabilityOverride> implements AvailabilityOverrideRepository {}

export class OnCallResolver {
  constructor(private readonly schedules:OnCallScheduleRepository,private readonly shifts:OnCallShiftRepository,private readonly overrides:AvailabilityOverrideRepository){}
  async resolve(scheduleId:string,at=new Date().toISOString()):Promise<OnCallAssignment|undefined>{
    const schedule=await this.schedules.get(scheduleId);if(!schedule||!schedule.enabled)return undefined;
    const instant=normalizeInstant(at),shift=await this.shifts.findActive(scheduleId,instant);if(!shift)return undefined;
    const override=await this.overrides.findActive(scheduleId,instant);
    return{scheduleId,contactId:override?.replacementContactId??shift.contactId,shift,...(override?{override}:{}),validUntil:override&&override.endsAt<shift.endsAt?override.endsAt:shift.endsAt};
  }
}

export const ON_CALL_SCHEDULE_REPOSITORY=Symbol('faultline.on-call-schedule-repository');
export const ON_CALL_SHIFT_REPOSITORY=Symbol('faultline.on-call-shift-repository');
export const AVAILABILITY_OVERRIDE_REPOSITORY=Symbol('faultline.availability-override-repository');
