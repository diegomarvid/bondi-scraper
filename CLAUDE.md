# CLAUDE.md - bondi-scraper

## Qué es este repo

Scraper de la página de COT (cot.com.uy) para buscar horarios de bus, ver disponibilidad de asientos y comprar pasajes de forma automatizada. Usa Puppeteer (headless Chrome) porque el backend de COT requiere un browser real para las llamadas al web service de turnos.

## Cómo correr

```bash
npm install
npx tsx src/scrape.ts --from maldonado --to mvd         # buscar horarios
npx tsx src/seats.ts --date 2026-04-01 --time 18:30     # ver asientos + screenshot
npx tsx src/buy.ts --dry-run --type directisimo         # preview sin comprar
```

Los datos del pasajero van en `src/passenger.json` (gitignored).

## Navegando la página de COT con browser automation

### Flujo de la web

La web de COT es una app PHP con jQuery que usa sesiones server-side. El flujo de compra tiene 4 páginas:

1. **`/` (index)** — Formulario de búsqueda con dropdowns de origen/destino
2. **`/paso-1.php`** — Lista de turnos disponibles (cargados via AJAX)
3. **`/paso-2.php`** — Selección de asientos (mapa visual con checkboxes)
4. **`/paso-3.php`** — Datos del pasajero + resumen + pasarela de pago externa

### Paso 1: Búsqueda (index → paso-1)

- Los dropdowns tienen IDs `#origen` y `#destino`. Los valores son códigos numéricos (ej: Maldonado = "124", Tres Cruces = "101").
- Al cambiar el origen con jQuery `$(origen).trigger('change')`, el dropdown de destino se actualiza dinámicamente. **Hay que esperar ~1 segundo** antes de setear el destino.
- La fecha es un `input[name="fecha_ida"]` tipo date, formato `YYYY-MM-DD`.
- El botón Buscar es un `input[type=text]` con clase `btn btn-primary` y valor "Buscar". NO es un button ni un submit — tiene event handlers de jQuery.
- La función JS `botonBuscar()` es la que realmente hace la búsqueda: POSTea a `views_interfaces/cb_paso1.class.php` con `action=guardar_datos` y luego redirige a `paso-1.php`.

### Paso 2: Lista de turnos (paso-1)

- Los turnos NO están en el HTML estático — se cargan via AJAX después de que la página carga.
- El JS de la página llama `cargarDatos()` (que POSTea `action=cargar_datos`) y luego `obtenerTurnos()` (que POSTea `action=obtener_turnos`).
- **Importante**: `obtener_turnos` llama a un web service externo que NO funciona con fetch/curl directo — requiere el contexto del browser (probablemente valida cookies o headers específicos de la sesión PHP). Intentar replicar las llamadas HTTP puras da `error_ws`.
- Hay que esperar ~3 segundos después del `networkidle` para que los turnos carguen.
- Los turnos aparecen en `#lista-turnos-ida` como `<tr>` con `<td>` para cada columna. Cada fila tiene un link `<a>` con "Comprar $ NNN".
- Bondis de doble piso tienen un icono `img[src*="icono_doble_piso2.svg"]` con `display: none` o `display: ;` (visible).

### Paso 3: Selección de asientos (paso-2)

- Los asientos son checkboxes dentro de tablas con IDs como `matriz-de-asientos-piso1-coche-{N}-ida`.
- `disabled` = ocupado, habilitado = libre.
- Bondis simples: 1 tabla con 46 asientos (12 filas de 4 + 1 fila de 2).
- Bondis doble piso: 2 tablas visibles — piso 1 (~16 asientos) y piso 2 (~48 asientos), total 64.
- Para avanzar: llamar `enviarAsientos()` via JS (el botón "Siguiente" tiene id `btn_siguiente-ida` con jQuery click handler).
- Hay un timer de ~5 minutos. Si se vence, la sesión expira y redirige a error.php.

### Paso 4: Datos del pasajero (paso-3)

- Campos: `nombre_1`, `apellido_1`, `ci_1`, `telefono_1`, `email_1`.
- E-ticket: dropdown `envio_eticket` con opciones "email", etc.
- Botón "SIGUIENTE" tiene id `btConfirmarCompra` — abre un modal de resumen.
- En el modal, el botón "Confirmar" tiene id `pasarela-btn` — llama `confirmar_reserva()` que redirige a la pasarela de pago de Fiserv (caratgateway.fiservapp.com).

### Paso 5: Pago (pasarela externa)

- La pasarela es de Fiserv (Carat Gateway). URL: `caratgateway.fiservapp.com/ui/services/payments/requestUniquePayment`
- Las tarjetas son labels con clases como `.card-visa_fiserv`, `.card-master`, `.card-oca`, `.card-cabal`, `.card-anda`.
- También hay opción de pago por banco: `.bank-bbva`, `.bank-brou`, `.bank-itau`, `.bank-santander`, `.bank-scotiabank`, `.bank-heritage`.
- Después de llenar tarjeta y dar CONTINUAR, pide CVV en una segunda pantalla.
- Si el pago falla, redirige a `cot.com.uy/confirmacionPago.php` o `error.php`.

## Tips para browser automation

- Usar `page.evaluate` con strings (no arrow functions) para evitar problemas de transpilación de tsx/esbuild con `__name is not defined`.
- Usar `(function(){ ... })()` en vez de `(() => { ... })()` dentro de evaluate strings.
- El viewport de 1280x1800 es suficiente para capturar bondis doble piso sin cortar.
- Siempre esperar `networkidle` + un delay extra de 2-3s después de cada navegación — la web carga contenido por AJAX.
- Los IDs de las tablas de asientos incluyen el número de coche, que cambia por turno. Buscar por patrón `tabla[id*='matriz-de-asientos'][id*='-ida']` en vez de ID exacto.

## Códigos de estación

Están en `STATIONS` en `cot-client.ts`. Los más importantes:
- Montevideo Tres Cruces: 101
- Maldonado: 124
- Punta del Este: 125
- San Carlos: 123
- Piriápolis: 113
- Rocha: 157
- Colonia: 138
