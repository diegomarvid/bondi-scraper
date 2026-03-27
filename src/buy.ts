import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CotScraper, STATIONS, type PassengerData, type CardData, type Trip } from "./cot-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function resolveStation(input: string): { name: string; code: string } {
  const lower = input.toLowerCase();
  if (ALIASES[lower]) {
    const name = ALIASES[lower];
    return { name, code: STATIONS[name] };
  }
  for (const [name, code] of Object.entries(STATIONS)) {
    if (name.toLowerCase().includes(lower)) return { name, code };
  }
  throw new Error(`Unknown station: "${input}"`);
}

function loadPassenger(): PassengerData {
  const raw = readFileSync(new URL("./passenger.json", import.meta.url), "utf-8");
  return JSON.parse(raw);
}

function loadCardFromEnv(): Omit<CardData, "cvv"> | null {
  // Try .env file in project root
  const envPath = resolve(__dirname, "../.env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    const env: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
    if (env.CARD_NUMBER) {
      const passenger = loadPassenger();
      return {
        brand: (env.CARD_BRAND || "visa") as CardData["brand"],
        number: env.CARD_NUMBER,
        expiryMonth: env.CARD_EXPIRY?.split("/")[0] || "",
        expiryYear: env.CARD_EXPIRY?.split("/")[1] || "",
        holderName: env.CARD_NAME || passenger.nombre,
        holderLastName: env.CARD_LASTNAME || passenger.apellido,
        phone: env.CARD_PHONE || passenger.telefono,
        email: env.CARD_EMAIL || passenger.email,
      };
    }
  }

  // Try env vars directly
  if (process.env.CARD_NUMBER) {
    const passenger = loadPassenger();
    return {
      brand: (process.env.CARD_BRAND || "visa") as CardData["brand"],
      number: process.env.CARD_NUMBER,
      expiryMonth: process.env.CARD_EXPIRY?.split("/")[0] || "",
      expiryYear: process.env.CARD_EXPIRY?.split("/")[1] || "",
      holderName: process.env.CARD_NAME || passenger.nombre,
      holderLastName: process.env.CARD_LASTNAME || passenger.apellido,
      phone: process.env.CARD_PHONE || passenger.telefono,
      email: process.env.CARD_EMAIL || passenger.email,
    };
  }

  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let from = "maldonado";
  let to = "tres-cruces";
  let date: string | undefined;
  let time: string | undefined;
  let type: string | undefined;
  let seat: number | undefined;
  let cvv: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--from": from = args[++i]; break;
      case "--to": to = args[++i]; break;
      case "--date": date = args[++i]; break;
      case "--time": time = args[++i]; break;
      case "--type": type = args[++i]; break;
      case "--seat": seat = parseInt(args[++i]); break;
      case "--cvv": cvv = args[++i]; break;
      case "--dry-run": dryRun = true; break;
      case "--help":
        console.log(`
Usage: npx tsx src/buy.ts [options]

Card data is read from .env file (CARD_NUMBER, CARD_EXPIRY, CARD_BRAND).
CVV is passed at runtime for security.

Options:
  --from <station>       Origin (default: maldonado)
  --to <station>         Destination (default: tres-cruces)
  --date <YYYY-MM-DD>    Travel date (default: tomorrow)
  --time <HH:MM>         Departure time
  --type <type>          Filter: directisimo, directo, turno
  --seat <n>             Preferred seat number
  --cvv <cvv>            Card CVV (required for purchase)
  --dry-run              Preview only (search + seats, no purchase)

.env file format:
  CARD_BRAND=visa
  CARD_NUMBER=4XXXXXXXXXXXXXXX
  CARD_EXPIRY=12/28
  CARD_NAME=Diego         (optional, defaults to passenger.json)
  CARD_LASTNAME=Marvid    (optional, defaults to passenger.json)
`);
        process.exit(0);
    }
  }

  return { from, to, date, time, type, seat, cvv, dryRun };
}

async function main() {
  const opts = parseArgs();
  const origin = resolveStation(opts.from);
  const destination = resolveStation(opts.to);
  const passenger = loadPassenger();
  const travelDate = opts.date ?? new Date(Date.now() + 86400000).toISOString().split("T")[0];

  console.log(`\nBuying ticket: ${origin.name} → ${destination.name}`);
  console.log(`Date: ${travelDate} | Passenger: ${passenger.nombre} ${passenger.apellido}\n`);

  const scraper = new CotScraper();

  try {
    const tripFilter = (trip: Trip): boolean => {
      if (opts.type) {
        const t = opts.type.toUpperCase();
        if (!trip.serviceType.toUpperCase().includes(t)) return false;
      }
      if (opts.time) {
        return trip.departure === opts.time;
      }
      return true;
    };

    if (opts.dryRun) {
      console.log("[dry-run] Searching trips...");
      const trips = await scraper.searchTrips({
        originCode: origin.code, originName: origin.name,
        destinationCode: destination.code, destinationName: destination.name,
        date: travelDate,
      });

      const matching = trips.filter(tripFilter);
      if (matching.length === 0) {
        console.log("No trips match the filter.");
        return;
      }

      console.log(`Found ${matching.length} matching trips:\n`);
      for (const t of matching) {
        console.log(`  ${t.departure} → ${t.arrival} | ${t.serviceType} | ${t.duration} | $${t.price} | ${t.route}`);
      }

      const pick = matching[0];
      console.log(`\nSelecting first match: ${pick.departure} ${pick.serviceType}`);
      await scraper.selectTrip(pick.rowIndex);

      const seatMap = await scraper.getSeatMap();
      console.log(`\nCoach: ${seatMap.coachLabel}`);
      console.log(`Free seats (${seatMap.freeSeats.length}): ${seatMap.freeSeats.join(", ")}`);
      console.log(`\nSeat map:`);
      for (const row of seatMap.layout) {
        console.log(`  ${row}`);
      }
      console.log("\n[dry-run] Stopping before purchase. Use without --dry-run to buy.");
      return;
    }

    // Load card from .env
    const cardBase = loadCardFromEnv();
    if (!cardBase) {
      console.error("Error: No card data found. Create a .env file with:");
      console.error("  CARD_BRAND=visa");
      console.error("  CARD_NUMBER=4XXXXXXXXXXXXXXX");
      console.error("  CARD_EXPIRY=12/28");
      process.exit(1);
    }

    if (!opts.cvv) {
      console.error("Error: --cvv is required for purchase.");
      console.error("Card data loaded from .env, but CVV must be passed at runtime.");
      process.exit(1);
    }

    const card: CardData = { ...cardBase, cvv: opts.cvv };

    console.log(`Card: ${card.brand.toUpperCase()} ****${card.number.slice(-4)}`);

    const result = await scraper.buyTicket({
      search: {
        originCode: origin.code, originName: origin.name,
        destinationCode: destination.code, destinationName: destination.name,
        date: travelDate,
      },
      tripFilter,
      seatPreference: opts.seat,
      passenger,
      card,
    });

    if (result.success) {
      console.log("\n✅ Purchase successful!");
      console.log(result.message);
    } else {
      console.log("\n❌ Purchase failed:");
      console.log(result.error);
    }
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
