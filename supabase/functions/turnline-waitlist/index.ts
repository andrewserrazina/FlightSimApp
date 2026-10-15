// Supabase Edge Function: turnline-waitlist
// Public endpoint; deploy with verify_jwt=false ONLY after configuring Turnstile, Resend and origin allowlist.
// Secrets live in function environment, never in the browser or Git.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env=(key:string)=>Deno.env.get(key)?.trim() || "";
const SUPABASE_URL=env("SUPABASE_URL"), SERVICE=env("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN=env("WAITLIST_ALLOWED_ORIGIN"), SITE=env("WAITLIST_SITE_URL");
const endpoint=env("WAITLIST_FUNCTION_URL");
const service=()=>createClient(SUPABASE_URL,SERVICE,{auth:{autoRefreshToken:false,persistSession:false}});
const encoder=new TextEncoder();
const toHex=(bytes:Uint8Array)=>Array.from(bytes).map(x=>x.toString(16).padStart(2,"0")).join("");
const sha=async(s:string)=>toHex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(s))));
const hmac=async(s:string)=>{
 const k=await crypto.subtle.importKey("raw",encoder.encode(env("WAITLIST_SIGNING_SECRET")),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return toHex(new Uint8Array(await crypto.subtle.sign("HMAC",k,encoder.encode(s))));
};
const cors={"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Methods":"POST, GET, OPTIONS","Access-Control-Allow-Headers":"content-type","Vary":"Origin"};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...cors}});
const redirect=(state:string)=>Response.redirect(SITE+"/?waitlist="+encodeURIComponent(state)+"#early-access",303);
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const allowConfigured=()=>[SUPABASE_URL,SERVICE,ORIGIN,SITE,endpoint,env("TURNSTILE_SECRET_KEY"),env("RESEND_API_KEY"),env("WAITLIST_FROM_EMAIL"),env("WAITLIST_SIGNING_SECRET")].every(Boolean);
const send=async(to:string,subject:string,html:string)=>{
 const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+env("RESEND_API_KEY"),"Content-Type":"application/json"},body:JSON.stringify({from:env("WAITLIST_FROM_EMAIL"),to:[to],subject,html})});
 if(!r.ok)throw new Error("email provider rejected send");
};
Deno.serve(async(req)=>{
 if(!allowConfigured())return response({error:"service_unconfigured"},503);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 const url=new URL(req.url);
 if(req.method==="GET"){
   const id=url.searchParams.get("id")||"",token=url.searchParams.get("token")||"",action=url.searchParams.get("action")||"";
   if(!/^[0-9a-f-]{36}$/i.test(id)||!token||token.length>200)return redirect("invalid");
   const db=service();
   if(action==="confirm"){
     const {data,error}=await db.from("turnline_waitlist").select("id,verification_hash,verification_expires_at,unsubscribed_at,confirmed_at").eq("id",id).maybeSingle();
     if(error||!data||data.unsubscribed_at)return redirect("invalid");
     if(data.confirmed_at)return redirect("confirmed");
     if(Date.parse(data.verification_expires_at)<Date.now()||(await sha(token))!==data.verification_hash)return redirect("invalid");
     const {error:upErr}=await db.from("turnline_waitlist").update({confirmed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).eq("verification_hash",data.verification_hash).is("unsubscribed_at",null);
     return redirect(upErr?"error":"confirmed");
   }
   if(action==="unsubscribe"){
     if((await hmac("unsubscribe:"+id))!==token)return redirect("invalid");
     const {error}=await db.from("turnline_waitlist").update({unsubscribed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id);
     return redirect(error?"error":"unsubscribed");
   }
   return redirect("invalid");
 }
 if(req.method!=="POST")return response({error:"method_not_allowed"},405);
 if(req.headers.get("origin")!==ORIGIN)return response({error:"invalid_origin"},403);
 let input:Record<string,unknown>;try{const raw=await req.text();if(raw.length>5000)return response({error:"invalid_request"},413);input=JSON.parse(raw);if(!input||typeof input!=="object"||Array.isArray(input))throw Error("invalid");}catch{return response({error:"invalid_request"},400);}
 const email=String(input.email||"").trim().toLowerCase();
 if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||input.consent!==true||typeof input.captcha!=="string"||input.captcha.length>4096)return response({error:"invalid_request"},400);
 // Database-backed atomic limits; global and email limits still apply if proxy IP headers are absent.
 const db=service();
 const digest=async(v:string)=>sha(env("WAITLIST_SIGNING_SECRET")+":"+v);
 const rate=async(label:string,identity:string,limit:number)=>{
   const {data,error}=await db.rpc("turnline_waitlist_check_limit",{p_bucket:label+":"+await digest(identity),p_limit:limit});
   return !error&&data===true;
 };
 const ip=req.headers.get("cf-connecting-ip")||req.headers.get("x-real-ip")||req.headers.get("x-forwarded-for")?.split(",").slice(-1)[0]?.trim()||"unknown";
 if(!(await rate("global","waitlist",300))||!(await rate("ip",ip,20))||!(await rate("email",email,4)))
   return response({error:"rate_limited"},429);
 const captcha=new URLSearchParams({secret:env("TURNSTILE_SECRET_KEY"),response:input.captcha});
 const cf=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",body:captcha});
 if(!cf.ok)return response({error:"temporarily_unavailable"},503);
 const check=await cf.json();
 if(!check.success||check.hostname!==new URL(ORIGIN).hostname)return response({error:"verification_failed"},400);
 const {data:existing,error:readError}=await db.from("turnline_waitlist").select("id,created_at,confirmed_at,unsubscribed_at,updated_at").eq("email_normalized",email).maybeSingle();
 if(readError)return response({error:"temporarily_unavailable"},503);
 // Avoid revealing whether an email already belongs to the list.
 if(existing?.confirmed_at&&!existing.unsubscribed_at)return response({ok:true});
 if(existing && Date.now()-Date.parse(existing.updated_at)<60_000)return response({ok:true});
 const token=crypto.randomUUID()+crypto.randomUUID(), hash=await sha(token);
 const meta=(k:string)=>typeof input[k]==="string"?String(input[k]).slice(0,100):null;
 const patch={email,consented_at:new Date().toISOString(),verification_hash:hash,verification_expires_at:new Date(Date.now()+48*3600_000).toISOString(),confirmed_at:null,unsubscribed_at:null,source:"turnline_waitlist",utm_source:meta("utm_source"),utm_medium:meta("utm_medium"),utm_campaign:meta("utm_campaign"),updated_at:new Date().toISOString()};
 let id:string;
 if(existing){
   const {error}=await db.from("turnline_waitlist").update(patch).eq("id",existing.id);
   if(error)return response({error:"temporarily_unavailable"},503);id=existing.id;
 }else{
   const {data,error}=await db.from("turnline_waitlist").insert(patch).select("id").single();
   if(error||!data)return response({error:"temporarily_unavailable"},503);id=data.id;
 }
 const confirm=endpoint+"?action=confirm&id="+encodeURIComponent(id)+"&token="+encodeURIComponent(token);
 const unsubscribe=endpoint+"?action=unsubscribe&id="+encodeURIComponent(id)+"&token="+encodeURIComponent(await hmac("unsubscribe:"+id));
 const body='<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0b1f3a"><h1>TURNLINE</h1><p>Confirm your email to receive development updates and beta invitations.</p><p><a style="background:#f4b400;color:#0b1f3a;padding:12px 18px;display:inline-block" href="'+escapeHtml(confirm)+'">Confirm my email</a></p><p>This link expires in 48 hours. If you did not request this, ignore the message.</p><hr><p style="font-size:12px">You can <a href="'+escapeHtml(unsubscribe)+'">unsubscribe</a> at any time.</p></div>';
 try{await send(email,"Confirm your Turnline updates",body);}catch{return response({error:"temporarily_unavailable"},503);}
 return response({ok:true});
});
