# Learnings: Cómo funciona la web de COT (cot.com.uy)

## Arquitectura general

La web de COT es una aplicación PHP clásica con jQuery en el frontend. Usa sesiones PHP (`PHPSESSID`) para mantener el estado del proceso de compra. Todo el estado de búsqueda (origen, destino, fecha, pasajeros) se guarda en la sesión del servidor.

El backend se comunica con un web service externo (probablemente SOAP) para obtener los turnos disponibles y la información de asientos. Este WS es el componente más frágil del sistema.

## El endpoint central: `cb_paso1.class.php`

Toda la lógica del paso 1 pasa por `views_interfaces/cb_paso1.class.php` con diferentes `action`:

| Action | Qué hace |
|--------|----------|
| `guardar_datos` | Guarda los parámetros de búsqueda en la sesión PHP |
| `cargar_datos` | Recupera los parámetros guardados (devuelve JSON) |
| `obtener_turnos` | Consulta el WS externo y devuelve los turnos disponibles |

### Parámetros de `guardar_datos`

```
origen_codigo=124
destino_codigo=101
radio-tipo=ida
pasajes_name=1
fecha_ida=2026-03-28
fecha_vuelta=
action=guardar_datos
radio=ida
origen_nombre=Maldonado terminal
destino_nombre=Montevideo terminal tres cruces
Desde=124
Hasta=101
f_vuelta_name=
f_ida_name=2026-03-28
compra_paso2_valor=ida
```

### Respuesta de `cargar_datos`

```json
{
  "radio": "ida",
  "f_ida_name": "2026-03-28",
  "f_vuelta_name": "",
  "Desde": "124",
  "Hasta": "101",
  "pasajes_name": "1",
  "origen_nombre": "Maldonado terminal",
  "destino_nombre": "Montevideo terminal tres cruces",
  "compra_paso2_valor": "ida"
}
```

### Respuesta de `obtener_turnos`

```json
{
  "turnos": [
    {
      "linea": "393454",
      "hora_salida": "05:00",
      "hora_llegada": "06:55",
      "fecha_llegada": "28/03/2026",
      "destino_final": "MONTEVIDEO TERMINAL TRES CRUCES",
      "cant_pasajeros": 46,
      "es_ida": true,
      "admite_reserva": true,
      "coche": 1,
      "pasa_por": "X MALDONADO",
      "tipo_servicio_nombre": "TURNO",
      "linea_codigo": "02",
      "origen_pasajero": "124",
      "destino_pasajero": "101",
      "duracion": "01:55",
      "tipo_coche": "simple",
      "precioBase": 409.09,
      "precioBase_iva_inc": 450
    }
  ]
}
```

Campos importantes del JSON de turnos:
- `tipo_coche`: `"simple"` (46 asientos) o `"doble"` (64 asientos, doble piso)
- `tipo_servicio_nombre`: `"TURNO"`, `"TURNO PLUS"`, `"DIRECTO"`, `"DIRECTISIMO"`
- `precioBase_iva_inc`: Precio final con IVA incluido
- `cant_pasajeros`: Capacidad total del coche
- `pasa_por`: Ruta que sigue (ej: "X MALDONADO", "X PIRIAPOLIS")
- `coche`: Número de coche (usado en los IDs de las tablas de asientos)

## Por qué NO funciona con HTTP puro (curl/fetch)

Intenté replicar el flujo con fetch de Node.js:
1. GET `/` → obtener PHPSESSID ✅
2. POST `cb_paso1.class.php` con `action=guardar_datos` → 200 OK, body vacío ✅
3. POST `cb_paso1.class.php` con `action=cargar_datos` → devuelve JSON correcto ✅
4. POST `cb_paso1.class.php` con `action=obtener_turnos` → **`error_ws`** ❌

La llamada a `obtener_turnos` falla consistentemente con `error_ws` cuando se hace desde fetch/curl, incluso con las mismas cookies, headers y user-agent. Probé:
- Diferentes valores de `sentido` (`true`, `1`, `"ida"`)
- Agregar delays entre llamadas
- Visitar `paso-1.php` antes de llamar
- Diferentes headers (`X-Requested-With`, `Referer`, etc.)

Nada funcionó. El WS externo probablemente valida algo del contexto del browser que no se puede replicar (TLS fingerprint, JS challenge, o algún token generado por el reCAPTCHA v3 que se carga en la página).

**Conclusión**: Puppeteer (headless Chrome) es necesario. No se puede hacer con HTTP puro.

## Estructura del formulario de búsqueda

```html
<form id="form_paso_1">
  <select id="origen" name="origen_codigo">
    <option value="124">Maldonado terminal</option>
    <!-- ... -->
  </select>
  <select id="destino" name="destino_codigo">
    <!-- Se actualiza dinámicamente al cambiar origen -->
  </select>
  <select id="pasajes" name="pasajes_name">
    <option value="1">1</option>
    <!-- hasta 5 -->
  </select>
  <input type="radio" name="radio-tipo" value="ida">
  <input type="radio" name="radio-tipo" value="ida-y-vuelta">
  <input type="date" name="fecha_ida">
  <input type="date" name="fecha_vuelta">
  <input type="text" id="btn_buscar" class="btn btn-primary" value="Buscar">
</form>
```

El botón "Buscar" es un `input[type=text]` (no button ni submit). La búsqueda se dispara por jQuery click handlers que llaman a `botonBuscar()`.

### Dependencia de dropdowns

Al cambiar el origen, el destino se recarga via jQuery `change` event. Los destinos disponibles cambian según el origen seleccionado. Hay que esperar ~1 segundo entre setear origen y destino.

## Mapa de asientos

### Bondis simples (1 piso, 46 asientos)

```
Tabla: matriz-de-asientos-piso1-coche-{N}-ida

Layout (4 columnas, pasillo en el medio):
  [1]  [2]  |  [3]  [4]     ← frente (volante)
  [5]  [6]  |  [7]  [8]
  ...
  [41] [42] |  [43] [44]
  [45] [46]                  ← fondo (solo 2 asientos)
```

### Bondis doble piso (64 asientos)

Tienen 2 tablas visibles:
- `matriz-de-asientos-piso1-coche-{N}-ida` — Piso inferior, ~16 asientos (49-64)
- `matriz-de-asientos-piso2-coche-{N}-ida` — Piso superior, ~48 asientos (1-48)

Los asientos del piso 2 (superior) van del 1 al 48. Los del piso 1 (inferior) van del 49 al 64. En la web se muestran lado a lado.

### Identificar doble piso desde la lista de turnos

Cada fila de turno tiene un icono `<img id="iconoBusDP" src="img/icono_doble_piso2.svg">`. Si `style.display` no es `"none"`, es doble piso. También el campo `tipo_coche` en el JSON es `"doble"`.

### Checkboxes de asientos

```html
<input type="checkbox" name="26" id="checkbox26-3-ida" disabled="">
<!-- disabled = ocupado, sin disabled = libre -->
```

El ID sigue el patrón: `checkbox{N}-{coche}-ida` donde N es el número de asiento y coche es el número de coche.

## Timers y expiración

- Paso 2 (asientos): Timer de ~3 minutos para seleccionar asiento
- Paso 3 (datos): Timer de ~5 minutos para completar datos y confirmar
- Si el timer expira, redirige a `error.php` con mensaje genérico

Los timers empiezan cuando se carga la página. Para automatización hay que ser rápido — no hacer pausas innecesarias entre paso 2 y paso 3.

## Pasarela de pago (Fiserv Carat Gateway)

- URL: `caratgateway.fiservapp.com/ui/services/payments/requestUniquePayment`
- Es una SPA Angular que corre en el dominio de Fiserv, no de COT
- Monto incluye tasa de servicio adicional al precio base ($450 base → $479 total)
- Flujo:
  1. Seleccionar medio de pago (tarjeta o banco)
  2. Llenar datos de tarjeta + nombre + celular + email + términos
  3. CONTINUAR → pantalla de resumen con CVV
  4. CONFIRMAR → procesamiento
  5. Redirect a `cot.com.uy/confirmacionPago.php`

### Medios de pago disponibles

Tarjetas: Anda, Cabal, Mastercard, OCA, Visa
Bancos: BBVA, Heritage, Itaú, BROU, Santander, Scotiabank

## Precios (marzo 2026)

- Maldonado → Tres Cruces: $450 UYU (todos los servicios, mismo precio)
- Tasa de servicio online: ~$29 UYU adicional (cobrado en pasarela)
- Total en pasarela: $479 UYU

## Rutas comunes desde Maldonado

| Ruta (`pasa_por`) | Significado | Duración aprox |
|---|---|---|
| X MALDONADO | Directa por ruta, para solo en Maldonado | 1h50-2h05 |
| X PIRIAPOLIS | Pasa por Piriápolis | 2h30-2h35 |
| X PAN DE AZUCAR Y SAN CARLOS | Pasa por Pan de Azúcar y San Carlos | 2h25-2h30 |
| X GIANNATTASIO Y PIRIAPOLIS | Pasa por Giannattasio y Piriápolis | 2h20-2h35 |
| x R8 / X RUTA 8 | Va por Ruta 8 (más lento) | 2h40 |
| LAGUNA GARZON | Pasa por Laguna Garzón | 2h05-2h10 |

## Frecuencia de servicios

Maldonado → Tres Cruces: ~42 servicios diarios (5:00 a 23:45)
Tres Cruces → Maldonado: ~54 servicios diarios (4:45 a 23:30)

Directísimos: ~8-9 por día, repartidos cada 1-2 horas
Primer bondi: ~5:00 (Maldonado) / 4:45 (Tres Cruces)
Último bondi: ~23:45 (Maldonado) / 23:30 (Tres Cruces)
