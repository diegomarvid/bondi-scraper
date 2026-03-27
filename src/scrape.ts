import { CotScraper, STATIONS } from "./cot-client.js";

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

  // Check aliases
  if (ALIASES[lower]) {
    const name = ALIASES[lower];
    const code = STATIONS[name];
    if (!code) throw new Error(`Station alias "${input}" resolved to "${name}" but code not found`);
    return { name, code };
  }

  // Check station names directly
  for (const [name, code] of Object.entries(STATIONS)) {
    if (name.toLowerCase().includes(lower)) {
      return { name, code };
    }
  }

  throw new Error(
    `Unknown station: "${input}". Available: ${Object.keys(STATIONS).join(", ")}`
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  let from = "Maldonado terminal";
  let to = "Montevideo terminal tres cruces";
  let date: string | undefined;
  let passengers = 1;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--from":
        from = args[++i];
        break;
      case "--to":
        to = args[++i];
        break;
      case "--date":
        date = args[++i];
        break;
      case "--passengers":
        passengers = parseInt(args[++i]);
        break;
      case "--help":
        console.log(`
Usage: npx tsx src/scrape.ts [options]

Options:
  --from <station>       Origin station (default: maldonado)
  --to <station>         Destination station (default: tres-cruces)
  --date <YYYY-MM-DD>    Travel date (default: tomorrow)
  --passengers <n>       Number of passengers (default: 1)

Station aliases: maldonado, tres-cruces, montevideo, mvd, pde, punta-del-este, piriapolis, rocha, colonia, chuy
`);
        process.exit(0);
    }
  }

  return { from, to, date, passengers };
}

async function main() {
  const { from, to, date, passengers } = parseArgs();
  const origin = resolveStation(from);
  const destination = resolveStation(to);

  // Default to tomorrow if no date specified
  const travelDate =
    date ??
    new Date(Date.now() + 86400000).toISOString().split("T")[0];

  console.log(
    `\nSearching COT buses: ${origin.name} -> ${destination.name}`
  );
  console.log(`Date: ${travelDate} | Passengers: ${passengers}\n`);

  const scraper = new CotScraper();
  try {
    const trips = await scraper.searchTrips({
      originCode: origin.code,
      originName: origin.name,
      destinationCode: destination.code,
      destinationName: destination.name,
      date: travelDate,
      passengers,
    });

    if (trips.length === 0) {
      console.log("No trips found for the selected route and date.");
      return;
    }

    // Print table
    console.log(
      "Salida  | Llegada | Tipo         | Duracion | Precio | Ruta"
    );
    console.log("-".repeat(75));

    for (const trip of trips) {
      console.log(
        `${trip.departure.padEnd(7)} | ${trip.arrival.padEnd(7)} | ${trip.serviceType.padEnd(12)} | ${trip.duration.padEnd(8)} | $${String(trip.price).padEnd(5)} | ${trip.route}`
      );
    }

    console.log(`\nTotal: ${trips.length} trips found`);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
