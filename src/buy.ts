import { readFileSync } from "fs";
import { CotScraper, STATIONS, type PassengerData, type CardData, type Trip } from "./cot-client.js";

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

function parseArgs() {
  const args = process.argv.slice(2);
  let from = "maldonado";
  let to = "tres-cruces";
  let date: string | undefined;
  let time: string | undefined;
  let type: string | undefined;
  let seat: number | undefined;
  let cardNumber: string | undefined;
  let cardExpiry: string | undefined;
  let cardCvv: string | undefined;
  let cardBrand: string = "visa";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--from": from = args[++i]; break;
      case "--to": to = args[++i]; break;
      case "--date": date = args[++i]; break;
      case "--time": time = args[++i]; break;
      case "--type": type = args[++i]; break;
      case "--seat": seat = parseInt(args[++i]); break;
      case "--card": cardNumber = args[++i]; break;
      case "--expiry": cardExpiry = args[++i]; break;
      case "--cvv": cardCvv = args[++i]; break;
      case "--brand": cardBrand = args[++i]; break;
      case "--dry-run": dryRun = true; break;
      case "--help":
        console.log(`
Usage: npx tsx src/buy.ts [options]

Options:
  --from <station>       Origin (default: maldonado)
  --to <station>         Destination (default: tres-cruces)
  --date <YYYY-MM-DD>    Travel date (default: tomorrow)
  --time <HH:MM>         Preferred departure time (picks closest)
  --type <type>          Service type filter: directisimo, directo, turno
  --seat <n>             Preferred seat number
  --card <number>        Card number
  --expiry <MM/YY>       Card expiry
  --cvv <cvv>            Card CVV
  --brand <brand>        Card brand: visa, master, oca, cabal, anda (default: visa)
  --dry-run              Stop before payment (show seats only)
`);
        process.exit(0);
    }
  }

  return { from, to, date, time, type, seat, cardNumber, cardExpiry, cardCvv, cardBrand, dryRun };
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
    // Build trip filter
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
      // Dry run: search + show seats for the matching trip
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

    // Full purchase
    if (!opts.cardNumber || !opts.cardExpiry || !opts.cardCvv) {
      console.error("Error: --card, --expiry, and --cvv are required for purchase.");
      console.error("Use --dry-run to preview without buying.");
      process.exit(1);
    }

    const [expMonth, expYear] = opts.cardExpiry.split("/");

    const card: CardData = {
      brand: opts.cardBrand as CardData["brand"],
      number: opts.cardNumber,
      expiryMonth: expMonth,
      expiryYear: expYear,
      cvv: opts.cardCvv,
      holderName: passenger.nombre,
      holderLastName: passenger.apellido,
      phone: passenger.telefono,
      email: passenger.email,
    };

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
