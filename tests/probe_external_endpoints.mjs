const targets=[
 ['Stooq (XAUUSD)','https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv'],
 ['FRED (DGS10)','https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&file_type=json'],
 ['Twelve Data (DXY)','https://api.twelvedata.com/quote?symbol=DXY'],
 ['Anthropic API','https://api.anthropic.com/v1/messages'],
 ['GDELT','https://api.gdeltproject.org/api/v2/doc/doc?query=gold&format=json'],
 ['Supabase (generique)','https://supabase.com'],
 ['Cloudflare API','https://api.cloudflare.com/client/v4/user'],
];
for(const [name,url] of targets){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),8000);
  const t0=Date.now();
  try{
    const r=await fetch(url,{signal:c.signal});
    console.log(`${name.padEnd(24)} HTTP ${r.status}  ${Date.now()-t0}ms  deny=${r.headers.get('x-deny-reason')||'-'}`);
  }catch(e){
    console.log(`${name.padEnd(24)} ECHEC RESEAU : ${e.cause?.code||e.name} — ${String(e.message).slice(0,80)}`);
  }finally{clearTimeout(t);}
}
