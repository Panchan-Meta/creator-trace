export function pagination(params:URLSearchParams){
 const number=(key:string,fallback:number,max:number)=>{const value=Number(params.get(key));return Number.isFinite(value)&&value>0?Math.min(max,Math.max(1,Math.floor(value))):fallback;};
 const page=number('page',1,100000),limit=number('limit',50,100);
 return {page,limit,offset:(page-1)*limit};
}
export function pageResult<T>(rows:T[],paging:ReturnType<typeof pagination>){
 return {items:rows.slice(0,paging.limit),page:paging.page,limit:paging.limit,hasNext:rows.length>paging.limit};
}
// Existing API clients retain arrays; the web UI explicitly requests metadata.
export function listResponse<T>(rows:T[],paging:ReturnType<typeof pagination>,params:URLSearchParams){
 const result=pageResult(rows,paging);return Response.json(params.get('pagination')==='1'?result:result.items);
}
