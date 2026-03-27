import puppeteer, { type Browser, type Page } from "puppeteer";

// Station name -> code mapping (extracted from cot.com.uy)
export const STATIONS: Record<string, string> = {
  "Aeropuerto carrasco": "150",
  "Aeropuerto laguna del sauce": "118",
  "Ag balneario valizas": "185",
  "Aguas dulces": "186",
  "Barra maldonado": "146",
  "Castillos agencia": "166",
  "Chuy terminal": "173",
  "Colonia suiza": "135",
  "Colonia terminal": "138",
  "Colonia valdense": "136",
  "Ecilda paullier": "134",
  "Jaureguiberry r.ib km 80": "105",
  "Jose ignacio est ancap": "149",
  "Juan lacaze": "137",
  "La coronilla agencia": "171",
  "La paloma terminal": "162",
  "La pedrera terminal": "163",
  "Laguna garzon": "194",
  "Libertad": "132",
  "Maldonado terminal": "124",
  "Manantiales": "147",
  "Montevideo terminal tres cruces": "101",
  "Pan de azucar terminal": "112",
  "Pando agencia": "176",
  "Piriapolis terminal": "113",
  "Portezuelo agencia": "121",
  "Punta colorada": "114",
  "Punta del diablo terminal": "187",
  "Punta del este terminal": "125",
  "Punta negra": "116",
  "Rocha terminal": "157",
  "Rosario": "131",
  "San carlos terminal": "123",
};

export interface Trip {
  departure: string;
  arrival: string;
  destinationFinal: string;
  serviceType: string;
  duration: string;
  route: string;
  price: number;
  rowIndex: number;
}

export interface SeatMap {
  coachId: string;
  coachLabel: string;
  totalSeats: number;
  freeSeats: number[];
  takenSeats: number[];
  layout: string[]; // visual rows: "X1 O2 _ X3 X4"
}

export interface PassengerData {
  nombre: string;
  apellido: string;
  documento: string;
  telefono: string;
  email: string;
}

export interface CardData {
  brand: "visa" | "master" | "oca" | "cabal" | "anda";
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  holderName: string;
  holderLastName: string;
  phone: string;
  email: string;
}

export interface SearchParams {
  originCode: string;
  originName: string;
  destinationCode: string;
  destinationName: string;
  date: string; // YYYY-MM-DD
  passengers?: number;
}

export type PurchaseResult =
  | { success: true; message: string }
  | { success: false; error: string };

const BASE_URL = "https://www.cot.com.uy";
const DELAY = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CotScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async init(): Promise<void> {
    this.browser = await puppeteer.launch({ headless: true });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.page) await this.init();
    return this.page!;
  }

  // ──────────────────────────────────────────────
  // STEP 1: Search trips
  // ──────────────────────────────────────────────
  async searchTrips(params: SearchParams): Promise<Trip[]> {
    const page = await this.ensurePage();
    const { originCode, destinationCode, date, passengers = 1 } = params;

    await page.goto(BASE_URL, { waitUntil: "networkidle2" });

    // Set origin and wait for destination dropdown to update
    await page.evaluate(`
      (() => {
        var origen = document.getElementById('origen');
        origen.value = '${originCode}';
        $(origen).trigger('change');
      })()
    `);
    await DELAY(1000);

    // Set destination, date, passengers, and trigger search
    await page.evaluate(`
      (() => {
        document.getElementById('destino').value = '${destinationCode}';
        $(document.getElementById('destino')).trigger('change');
        document.querySelector('input[name="fecha_ida"]').value = '${date}';
        document.getElementById('pasajes').value = '${passengers}';
        document.querySelector('input[value="ida"]').checked = true;
        $('#btn_buscar').attr("disabled", false);
        recordarPagina("index");
        botonBuscar();
      })()
    `);

    // Wait for navigation to paso-1.php
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    await DELAY(3000);

    // Extract trip data
    const trips = (await page.evaluate(`
      (() => {
        var rows = document.querySelectorAll("#lista-turnos-ida tr");
        var results = [];
        for (var ri = 0; ri < rows.length; ri++) {
          var cells = rows[ri].querySelectorAll("td");
          if (cells.length < 2) continue;
          var offset = 0;
          for (var i = 0; i < cells.length; i++) {
            if (/^\\d{2}:\\d{2}$/.test((cells[i].textContent || "").trim())) { offset = i; break; }
          }
          var departure = (cells[offset] ? cells[offset].textContent : "").trim();
          if (!/^\\d{2}:\\d{2}$/.test(departure)) continue;
          var price = 0;
          for (var j = 0; j < cells.length; j++) {
            var m = (cells[j].textContent || "").match(/\\$\\s*(\\d+)/);
            if (m) { price = parseInt(m[1]); break; }
          }
          results.push({
            departure: departure,
            destinationFinal: (cells[offset+1] ? cells[offset+1].textContent : "").trim(),
            arrival: (cells[offset+2] ? cells[offset+2].textContent : "").trim(),
            serviceType: (cells[offset+3] ? cells[offset+3].textContent : "").trim(),
            duration: (cells[offset+4] ? cells[offset+4].textContent : "").trim(),
            route: (cells[offset+5] ? cells[offset+5].textContent : "").trim(),
            price: price,
            rowIndex: ri
          });
        }
        return results;
      })()
    `)) as Trip[];

    return trips;
  }

  // ──────────────────────────────────────────────
  // STEP 2: Select a trip (click COMPRAR)
  // ──────────────────────────────────────────────
  async selectTrip(tripIndex: number): Promise<void> {
    const page = await this.ensurePage();

    const clicked = await page.evaluate(`
      (() => {
        var rows = document.querySelectorAll("#lista-turnos-ida tr");
        var row = rows[${tripIndex}];
        if (!row) return false;
        var link = row.querySelector("a");
        if (link) { link.click(); return true; }
        return false;
      })()
    `);

    if (!clicked) throw new Error(`Could not click trip at index ${tripIndex}`);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    await DELAY(3000);
  }

  // ──────────────────────────────────────────────
  // STEP 3: Get seat map
  // ──────────────────────────────────────────────
  async getSeatMap(): Promise<SeatMap> {
    const page = await this.ensurePage();

    const data = (await page.evaluate(`
      (function() {
        // Find any visible seat table with checkboxes
        var allTables = document.querySelectorAll("table");
        var table = null;
        for (var ti = 0; ti < allTables.length; ti++) {
          if (allTables[ti].id && allTables[ti].id.indexOf("matriz-de-asientos") !== -1 &&
              allTables[ti].id.indexOf("-ida") !== -1 &&
              allTables[ti].querySelectorAll("input[type=checkbox]").length > 0) {
            table = allTables[ti];
            break;
          }
        }
        if (!table) return null;

        var coacheSelect = document.getElementById("combo-coche-ida");
        var coachLabel = "";
        if (coacheSelect && coacheSelect.selectedIndex >= 0) {
          coachLabel = coacheSelect.options[coacheSelect.selectedIndex].text;
        }

        var checkboxes = table.querySelectorAll("input[type=checkbox]");
        var free = [];
        var taken = [];
        for (var i = 0; i < checkboxes.length; i++) {
          var num = parseInt(checkboxes[i].name);
          if (isNaN(num)) continue;
          if (checkboxes[i].disabled) taken.push(num);
          else free.push(num);
        }

        var rows = table.querySelectorAll("tr");
        var layout = [];
        for (var r = 0; r < rows.length; r++) {
          var cells = rows[r].querySelectorAll("td");
          var rowData = [];
          for (var c = 0; c < cells.length; c++) {
            var cb = cells[c].querySelector("input");
            if (cb && cb.name && !isNaN(parseInt(cb.name))) {
              rowData.push(cb.disabled ? "X" + cb.name : "O" + cb.name);
            } else if (cells[c].className === "espacio") {
              rowData.push("_");
            }
          }
          if (rowData.length > 0) layout.push(rowData.join(" "));
        }

        return {
          coachId: table.id,
          coachLabel: coachLabel,
          totalSeats: free.length + taken.length,
          freeSeats: free,
          takenSeats: taken,
          layout: layout
        };
      })()
    `)) as SeatMap | null;

    if (!data) throw new Error("Could not find seat map on page");
    return data;
  }

  // ──────────────────────────────────────────────
  // STEP 4: Select a seat and advance
  // ──────────────────────────────────────────────
  async selectSeat(seatNumber: number): Promise<void> {
    const page = await this.ensurePage();

    const selected = await page.evaluate(`
      (function() {
        var allCbs = document.querySelectorAll("input[type=checkbox]");
        for (var i = 0; i < allCbs.length; i++) {
          if (parseInt(allCbs[i].name) === ${seatNumber} && !allCbs[i].disabled &&
              allCbs[i].id && allCbs[i].id.indexOf("-ida") !== -1) {
            allCbs[i].click();
            return true;
          }
        }
        return false;
      })()
    `);

    if (!selected) throw new Error(`Seat ${seatNumber} not available or not found`);

    await DELAY(500);

    // Click "Siguiente" to advance to paso-3
    await page.evaluate(`
      (() => {
        recordarPagina("paso-2-ida");
        enviarAsientos();
      })()
    `);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    await DELAY(2000);
  }

  // ──────────────────────────────────────────────
  // STEP 5: Fill passenger data
  // ──────────────────────────────────────────────
  async fillPassengerData(passenger: PassengerData): Promise<void> {
    const page = await this.ensurePage();

    await page.evaluate(`
      (() => {
        document.getElementById("nombre_1").value = "${passenger.nombre}";
        document.getElementById("apellido_1").value = "${passenger.apellido}";
        document.getElementById("ci_1").value = "${passenger.documento}";
        document.getElementById("telefono_1").value = "${passenger.telefono}";
        document.getElementById("email_1").value = "${passenger.email}";
        var eticket = document.getElementById("envio_eticket");
        if (eticket) eticket.value = "email";
      })()
    `);
  }

  // ──────────────────────────────────────────────
  // STEP 6: Confirm purchase (opens payment gateway)
  // ──────────────────────────────────────────────
  async confirmPurchase(): Promise<void> {
    const page = await this.ensurePage();

    // Click "SIGUIENTE" to show summary modal
    await page.evaluate(`
      (() => {
        var btn = document.getElementById("btConfirmarCompra");
        if (btn) btn.click();
      })()
    `);

    await DELAY(2000);

    // Click "Confirmar" in modal to go to payment gateway
    await page.evaluate(`
      (() => {
        var btn = document.getElementById("pasarela-btn");
        if (btn) {
          recordarPagina("exit");
          timersOFF();
          confirmar_reserva();
        }
      })()
    `);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => {});
    await DELAY(3000);
  }

  // ──────────────────────────────────────────────
  // STEP 7: Fill card data and pay
  // ──────────────────────────────────────────────
  async fillCardAndPay(card: CardData): Promise<PurchaseResult> {
    const page = await this.ensurePage();

    const url = page.url();
    if (!url.includes("fiservapp.com") && !url.includes("gateway")) {
      return { success: false, error: `Not on payment gateway. Current URL: ${url}` };
    }

    const brandClass: Record<string, string> = {
      visa: ".card-visa_fiserv",
      master: ".card-master",
      oca: ".card-oca",
      cabal: ".card-cabal",
      anda: ".card-anda",
    };

    // Select card brand
    const selector = brandClass[card.brand];
    if (!selector) return { success: false, error: `Unknown card brand: ${card.brand}` };

    await page.evaluate(`
      (() => {
        var el = document.querySelector("${selector}");
        if (el) el.click();
      })()
    `);
    await DELAY(2000);

    // Fill card form
    const fields = await page.evaluate(`
      (() => {
        var cardInput = document.querySelector('input[placeholder*="####"]');
        var mmInput = document.querySelector('input[placeholder="MM"]');
        var aaInput = document.querySelector('input[placeholder="AA"]');
        var nameInput = document.querySelector('input[placeholder*="Nombre"]');
        var lastInput = document.querySelector('input[placeholder*="Apellido"]');
        var phoneInput = document.querySelector('input[placeholder*="celular"]');
        var emailInput = document.querySelector('input[placeholder*="email"]');
        return !!(cardInput && mmInput && aaInput && nameInput && lastInput);
      })()
    `);

    if (!fields) return { success: false, error: "Card form fields not found" };

    // Use puppeteer type() for proper input events on the payment gateway
    const cardInput = await page.$('input[placeholder*="####"]');
    const mmInput = await page.$('input[placeholder="MM"]');
    const aaInput = await page.$('input[placeholder="AA"]');
    const nameInput = await page.$('input[placeholder*="Nombre"]');
    const lastInput = await page.$('input[placeholder*="Apellido"]');
    const phoneInput = await page.$('input[placeholder*="celular"]');
    const emailInput = await page.$('input[placeholder*="email"]');
    const termsCheckbox = await page.$('input[type="checkbox"]');

    if (cardInput) { await cardInput.click({ clickCount: 3 }); await cardInput.type(card.number); }
    if (mmInput) { await mmInput.click({ clickCount: 3 }); await mmInput.type(card.expiryMonth); }
    if (aaInput) { await aaInput.click({ clickCount: 3 }); await aaInput.type(card.expiryYear); }
    if (nameInput) { await nameInput.click({ clickCount: 3 }); await nameInput.type(card.holderName); }
    if (lastInput) { await lastInput.click({ clickCount: 3 }); await lastInput.type(card.holderLastName); }
    if (phoneInput) { await phoneInput.click({ clickCount: 3 }); await phoneInput.type(card.phone); }
    if (emailInput) { await emailInput.click({ clickCount: 3 }); await emailInput.type(card.email); }
    if (termsCheckbox) await termsCheckbox.click();

    await DELAY(1000);

    // Click CONTINUAR
    const continueBtn = await page.$('button:not([disabled])');
    const buttons = await page.$$("button");
    for (const btn of buttons) {
      const text = await btn.evaluate((el) => el.textContent?.trim());
      if (text === "CONTINUAR" || text === "Continuar") {
        await btn.click();
        break;
      }
    }

    await DELAY(3000);

    // Fill CVV on confirmation page
    const cvvInput = await page.$('input[placeholder="###"]');
    if (cvvInput) {
      await cvvInput.click({ clickCount: 3 });
      await cvvInput.type(card.cvv);
      await DELAY(500);

      // Click final Confirmar
      const confirmButtons = await page.$$("button");
      for (const btn of confirmButtons) {
        const text = await btn.evaluate((el) => el.textContent?.trim());
        if (text === "Confirmar" || text === "CONFIRMAR") {
          await btn.click();
          break;
        }
      }

      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
      await DELAY(3000);
    }

    // Check result
    const resultUrl = page.url();
    const bodyText = await page.evaluate(`document.body.innerText.substring(0, 500)`) as string;

    if (bodyText.includes("inconveniente") || bodyText.includes("error")) {
      return { success: false, error: "Payment rejected: " + bodyText.substring(0, 200) };
    }

    if (resultUrl.includes("confirmacion") || bodyText.includes("confirmad")) {
      return { success: true, message: bodyText.substring(0, 300) };
    }

    return { success: false, error: `Unknown result. URL: ${resultUrl}` };
  }

  // ──────────────────────────────────────────────
  // FULL FLOW: search → seat → passenger → pay
  // ──────────────────────────────────────────────
  async buyTicket(opts: {
    search: SearchParams;
    tripFilter?: (trip: Trip) => boolean;
    seatPreference?: number;
    passenger: PassengerData;
    card: CardData;
  }): Promise<PurchaseResult> {
    const { search, tripFilter, seatPreference, passenger, card } = opts;

    // 1. Search
    console.log("[1/7] Searching trips...");
    const trips = await this.searchTrips(search);
    if (trips.length === 0) return { success: false, error: "No trips found" };

    // 2. Pick trip
    const trip = tripFilter ? trips.find(tripFilter) : trips[0];
    if (!trip) return { success: false, error: "No trip matched filter" };
    console.log(`[2/7] Selected: ${trip.departure} ${trip.serviceType} $${trip.price}`);

    // 3. Click COMPRAR
    await this.selectTrip(trip.rowIndex);

    // 4. Get seats & select
    console.log("[3/7] Loading seat map...");
    const seatMap = await this.getSeatMap();
    console.log(`[4/7] ${seatMap.freeSeats.length} seats available: ${seatMap.freeSeats.join(", ")}`);

    const seat = seatPreference && seatMap.freeSeats.includes(seatPreference)
      ? seatPreference
      : seatMap.freeSeats[0];
    if (!seat) return { success: false, error: "No free seats" };

    console.log(`[4/7] Selecting seat ${seat}...`);
    await this.selectSeat(seat);

    // 5. Fill passenger
    console.log("[5/7] Filling passenger data...");
    await this.fillPassengerData(passenger);

    // 6. Confirm → payment gateway
    console.log("[6/7] Confirming purchase...");
    await this.confirmPurchase();

    // 7. Pay
    console.log("[7/7] Processing payment...");
    return this.fillCardAndPay(card);
  }
}
