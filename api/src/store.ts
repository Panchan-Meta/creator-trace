import {id,now} from './domain';
export interface Bindings {DB:D1Database;ASSETS?:Fetcher;APP_ORIGIN:string;RP_ID:string;OPERATOR_TOKEN?:string;BITCOIN_RPC_URL?:string;BITCOIN_API_BASE_URL?:string;PUBLIC_PROOF_IDS?:string;SIGNUP_ENABLED?:string;XAI_API_KEY?:string;XAI_BASE_URL?:string;XAI_MODEL?:string;}
// Authentication tables are retained independently of the retired certificate service.
export class Store {
 constructor(public env:Bindings){}
 sql(query:string,...args:(string|number|null)[]){return this.env.DB.prepare(query).bind(...args);}
 audit(actor:string,action:string,targetType:string,target:string,metadata:object={}){return this.sql('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',id(),actor==='recipient'?'USER':'SYSTEM',actor==='recipient'?target:actor,action,targetType,target,JSON.stringify(metadata),now());}
}
