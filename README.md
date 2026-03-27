# bondi-scraper

Scraper y automatización de compra de pasajes de bus en [COT](https://www.cot.com.uy/) (Compañía Oriental de Transporte, Uruguay).

Automatiza el flujo completo: búsqueda de horarios → selección de asiento → datos del pasajero → pago con tarjeta.

## Requisitos

- Node.js 20+
- Chrome/Chromium (Puppeteer lo descarga automáticamente)

## Instalación

```bash
git clone https://github.com/diegomarvid/bondi-scraper.git
cd bondi-scraper
npm install
```

Crear `src/passenger.json` con tus datos (no se sube a git):

```json
{
  "nombre": "Tu Nombre",
  "apellido": "Tu Apellido",
  "tipoDocumento": "CI",
  "documento": "12345678",
  "telefono": "099123456",
  "email": "tu@email.com"
}
```

## Uso

### Buscar horarios

```bash
# Maldonado → Tres Cruces (mañana por defecto)
npm run scrape

# Con opciones
npx tsx src/scrape.ts --from maldonado --to tres-cruces --date 2026-04-01

# Al revés
npm run scrape:mvd-maldonado
```

Aliases de estaciones: `maldonado`, `tres-cruces`, `mvd`, `montevideo`, `pde`, `punta-del-este`, `piriapolis`, `rocha`, `colonia`, `chuy`

### Ver asientos de un bondi

```bash
# Devuelve JSON + screenshot del mapa de asientos
npx tsx src/seats.ts --date 2026-03-31 --time 18:30

# Otro origen/destino
npx tsx src/seats.ts --from mvd --to maldonado --date 2026-03-31 --time 17:00
```

Output: JSON a stdout con `freeSeats`, `takenSeats`, `totalSeats`, `screenshot` (path al PNG).

Funciona con bondis de 1 piso (46 asientos) y doble piso (64 asientos).

### Preview de compra (dry-run)

```bash
# Busca el directísimo, muestra asientos, no compra
npx tsx src/buy.ts --from maldonado --to mvd --type directisimo --time 18:30 --dry-run
```

### Comprar pasaje

```bash
npx tsx src/buy.ts \
  --from maldonado --to mvd \
  --date 2026-04-01 \
  --type directisimo \
  --time 18:30 \
  --seat 26 \
  --card 4XXXXXXXXXXXXXXX \
  --expiry 12/28 \
  --cvv 123 \
  --brand visa
```

Opciones de `--brand`: `visa`, `master`, `oca`, `cabal`, `anda`

Opciones de `--type`: `directisimo`, `directo`, `turno`

## Arquitectura

```
src/
├── cot-client.ts   # Cliente Puppeteer con todos los pasos automatizados
├── scrape.ts       # CLI para buscar horarios
├── seats.ts        # CLI para ver asientos + screenshot
├── buy.ts          # CLI para compra completa
└── passenger.json  # Datos del pasajero (gitignored)
```

`CotScraper` en `cot-client.ts` expone:

| Método | Paso |
|--------|------|
| `searchTrips()` | Buscar horarios disponibles |
| `selectTrip()` | Clickear COMPRAR en un servicio |
| `getSeatMap()` | Ver asientos libres/ocupados |
| `selectSeat()` | Seleccionar asiento y avanzar |
| `fillPassengerData()` | Llenar datos del pasajero |
| `confirmPurchase()` | Confirmar y abrir pasarela de pago |
| `fillCardAndPay()` | Llenar tarjeta y procesar pago |
| `buyTicket()` | Flujo completo encadenado |

## Tipos de servicio COT

- **Turno**: Servicio de línea regular, para en todas las paradas.
- **Turno Plus**: Servicio regular que puede convertirse en directo según demanda.
- **Directo**: Más rápido, solo ascenso en algunas paradas del origen.
- **Directísimo**: El más rápido, solo ascenso en terminal de origen. Suelen ser doble piso (64 asientos).

## Estaciones principales

| Alias | Nombre | Código |
|-------|--------|--------|
| `maldonado` | Maldonado terminal | 124 |
| `tres-cruces` / `mvd` | Montevideo terminal tres cruces | 101 |
| `pde` | Punta del este terminal | 125 |
| `piriapolis` | Piriapolis terminal | 113 |
| `rocha` | Rocha terminal | 157 |
| `colonia` | Colonia terminal | 138 |
| `chuy` | Chuy terminal | 173 |
