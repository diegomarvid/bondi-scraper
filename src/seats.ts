import puppeteer from "puppeteer";
import { STATIONS } from "./cot-client.js";

const ALIASES: Record<string, string> = {
  maldonado: "Maldonado terminal",
  "tres-cruces": "Montevideo terminal tres cruces",
  montevideo: "Montevideo terminal tres cruces",
  mvd: "Montevideo terminal tres cruces",
  pde: "Punta del este terminal",
  "punta-del-este": "Punta del este terminal",
  piriapolis: "Piriapolis terminal",
  rocha: "Rocha terminal",
  colonia: "Colonia terminal",
  chuy: "Chuy terminal",
};

function resolve(input: string) {
  const lower = input.toLowerCase();
  const name = ALIASES[lower] ??
    Object.keys(STATIONS).find((n) => n.toLowerCase().includes(lower));
  if (!name) throw new Error(`Unknown station: ${input}`);
  return { name, code: STATIONS[name] };
}

const DELAY = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  let from = "maldonado", to = "tres-cruces", date = "", time = "", outDir = "/tmp";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--from": from = args[++i]; break;
      case "--to": to = args[++i]; break;
      case "--date": date = args[++i]; break;
      case "--time": time = args[++i]; break;
      case "--out": outDir = args[++i]; break;
      case "--help":
        console.log(`Usage: npx tsx src/seats.ts --date 2026-03-31 --time 18:30 [--from maldonado] [--to mvd] [--out /tmp]`);
        process.exit(0);
    }
  }

  if (!date) date = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  if (!time) { console.error("--time HH:MM is required"); process.exit(1); }

  const origin = resolve(from);
  const dest = resolve(to);

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1800 });

  try {
    // 1. Home → search
    await page.goto("https://www.cot.com.uy", { waitUntil: "networkidle2" });
    await page.evaluate(`(() => {
      var o = document.getElementById('origen'); o.value='${origin.code}'; $(o).trigger('change');
    })()`);
    await DELAY(1000);
    await page.evaluate(`(() => {
      document.getElementById('destino').value='${dest.code}';
      $(document.getElementById('destino')).trigger('change');
      document.querySelector('input[name="fecha_ida"]').value='${date}';
      document.querySelector('input[value="ida"]').checked=true;
      $('#btn_buscar').attr("disabled",false);
      recordarPagina("index"); botonBuscar();
    })()`);
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    await DELAY(3000);

    // 2. Click matching trip
    const clicked = await page.evaluate(`(function(){
      var rows=document.querySelectorAll("#lista-turnos-ida tr");
      for(var i=0;i<rows.length;i++){
        var t=rows[i].textContent;
        if(t.indexOf("${time}")!==-1){
          var a=rows[i].querySelector("a"); if(a){a.click();return t.substring(0,80);}
        }
      }
      return null;
    })()`);

    if (!clicked) {
      console.error(`No trip found at ${time}`);
      process.exit(1);
    }
    console.error(`Selected: ${(clicked as string).replace(/\s+/g, " ").trim()}`);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    await DELAY(3000);

    // 3. Get seat info (handles both single and double decker)
    const seatData = (await page.evaluate(`(function(){
      var tables=document.querySelectorAll("table");
      var seatTables=[];
      for(var ti=0;ti<tables.length;ti++){
        var t=tables[ti];
        if(t.id&&t.id.indexOf("matriz-de-asientos")!==-1&&t.id.indexOf("-ida")!==-1){
          var cbs=t.querySelectorAll("input[type=checkbox]");
          var seatCount=0;
          for(var ci=0;ci<cbs.length;ci++){if(!isNaN(parseInt(cbs[ci].name)))seatCount++;}
          if(seatCount>0&&t.style.display!=="none"){
            seatTables.push({id:t.id,count:seatCount});
          }
        }
      }
      if(seatTables.length===0)return null;
      var isDoubleDecker=seatTables.length>=2;
      var free=[],taken=[];
      for(var si=0;si<seatTables.length;si++){
        var st=document.getElementById(seatTables[si].id);
        var cbs2=st.querySelectorAll("input[type=checkbox]");
        for(var i=0;i<cbs2.length;i++){
          var n=parseInt(cbs2[i].name);if(isNaN(n))continue;
          if(cbs2[i].disabled)taken.push(n);else free.push(n);
        }
      }
      var sel=document.getElementById("combo-coche-ida");
      var label=sel&&sel.selectedIndex>=0?sel.options[sel.selectedIndex].text:"";
      return{free:free,taken:taken,total:free.length+taken.length,label:label,
             isDoubleDecker:isDoubleDecker,floors:seatTables.map(function(s){return s.id;})};
    })()`)) as any;

    if (!seatData) {
      console.error("Could not load seat map");
      process.exit(1);
    }

    // 4. Screenshot - capture entire seat area (both floors if double decker)
    const bounds = (await page.evaluate(`(function(){
      var tables=document.querySelectorAll("table");
      var seatTables=[];
      for(var ti=0;ti<tables.length;ti++){
        var t=tables[ti];
        if(t.id&&t.id.indexOf("matriz-de-asientos")!==-1&&t.id.indexOf("-ida")!==-1){
          var cbs=t.querySelectorAll("input[type=checkbox]");
          var cnt=0;
          for(var ci=0;ci<cbs.length;ci++){if(!isNaN(parseInt(cbs[ci].name)))cnt++;}
          if(cnt>0&&t.style.display!=="none") seatTables.push(t);
        }
      }
      if(seatTables.length===0)return null;
      // Get bounding box that encompasses all seat tables + headers
      var minX=9999,minY=9999,maxX=0,maxY=0;
      for(var i=0;i<seatTables.length;i++){
        var r=seatTables[i].getBoundingClientRect();
        if(r.x<minX)minX=r.x;
        if(r.y<minY)minY=r.y;
        if(r.right>maxX)maxX=r.right;
        if(r.bottom>maxY)maxY=r.bottom;
      }
      // Include headers above the tables
      var headers=document.querySelectorAll("h2, h3, h4");
      for(var hi=0;hi<headers.length;hi++){
        var hr=headers[hi].getBoundingClientRect();
        var text=headers[hi].textContent||"";
        if((text.indexOf("ASIENTOS")!==-1||text.indexOf("PISO")!==-1||text.indexOf("SEGUNDO")!==-1)&&hr.y<minY){
          if(hr.y<minY)minY=hr.y;
          if(hr.right>maxX)maxX=hr.right;
        }
      }
      return{x:minX,y:minY,width:maxX-minX,height:maxY-minY};
    })()`)) as { x: number; y: number; width: number; height: number } | null;

    const outFile = `${outDir}/cot-seats-${date}-${time.replace(":", "")}.png`;

    if (bounds && bounds.height > 100) {
      await page.screenshot({
        path: outFile,
        clip: {
          x: Math.max(0, bounds.x - 30),
          y: Math.max(0, bounds.y - 15),
          width: Math.min(bounds.width + 60, 1280),
          height: bounds.height + 40,
        },
      });
    } else {
      await page.screenshot({ path: outFile, fullPage: true });
    }

    // 5. Output JSON to stdout
    const output = {
      from: origin.name,
      to: dest.name,
      date,
      time,
      coach: seatData.label,
      totalSeats: seatData.total,
      freeCount: seatData.free.length,
      takenCount: seatData.taken.length,
      freeSeats: seatData.free,
      takenSeats: seatData.taken,
      screenshot: outFile,
    };

    console.log(JSON.stringify(output));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
