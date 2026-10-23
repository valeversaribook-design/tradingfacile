import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({error:"Configura OPENAI_API_KEY nelle Environment Variables di Vercel per leggere le immagini."},{status:503});
    const {imageData} = await request.json();
    if (typeof imageData !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(imageData) || imageData.length > 12_000_000)
      return NextResponse.json({error:"Immagine non valida o troppo grande."},{status:400});
    const response = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"gpt-4.1-mini",temperature:0,
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:"Estrai solo le operazioni XAUUSD visibili da uno screenshot di storico MT4 Android o LUCA iOS. Rispondi con JSON {trades:[{side,lot,entry,exit,closeTime,profit}]}. side buy/sell, numeri JSON con punto, closeTime ISO 8601 con offset +02:00 o +01:00 se chiaramente applicabile all'Italia; non estrarre Balance/Deposito/Profitto aggregati. Non inventare campi illeggibili: ometti la riga. Non inventare mai l'ora di apertura. Trascrivi fedelmente i prezzi e i profitti anche se aritmeticamente inattesi."},
          {role:"user",content:[{type:"text",text:"Leggi tutte le righe di operazioni visibili, non il riepilogo."},{type:"image_url",image_url:{url:imageData,detail:"high"}}]}
        ]
      })
    });
    const raw=await response.text();
    if (!response.ok) return NextResponse.json({error:`Servizio riconoscimento non disponibile (HTTP ${response.status}).`},{status:502});
    const data=JSON.parse(raw);
    const parsed=JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const trades=(Array.isArray(parsed.trades)?parsed.trades:[]).filter(t=>{
      return ["buy","sell"].includes(String(t.side).toLowerCase()) &&
        [t.lot,t.entry,t.exit,t.profit].every(x=>x!==null && x!=="" && Number.isFinite(Number(x))) &&
        Number.isFinite(new Date(t.closeTime).getTime());
    }).map(t=>({side:String(t.side).toLowerCase(),lot:Number(t.lot),entry:Number(t.entry),exit:Number(t.exit),profit:Number(t.profit),closeTime:new Date(t.closeTime).toISOString()}));
    return NextResponse.json({trades});
  } catch (e) {
    console.error("Image import:",e);
    return NextResponse.json({error:"Impossibile interpretare lo screenshot. Riprova con un'immagine più nitida."},{status:500});
  }
}
