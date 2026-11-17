# Cotizador ProToldos

Cotizador web privado de ProToldos. Se entra con nombre y un código de 4 números. Permite crear cotizaciones con IVA y descuento, generar el PDF con logo e imagen referencial del proyecto, guardarlas y buscarlas por empresa.

- `public/` es el sitio completo: `index.html`, `app.js` y `app.css` para la interfaz, y `_worker.js` para el servidor (login, base de datos y PDFs).
- Base de datos: Cloudflare D1. Las tablas se crean solas en el primer uso.
- Se guarda solo el PDF de cada cotización, junto con sus datos de texto. Las imágenes no se guardan aparte.

## Publicar en Cloudflare Pages (desde este repo)

1. **Workers & Pages → Create → Pages → Connect to Git** y elige este repo.
2. Configuración de build:
   - Framework preset: **None**
   - Build command: *(vacío)*
   - Build output directory: **`public`**
3. **Storage & Databases → D1 → Create**: crea una base llamada `cotizador-protoldos`.
4. En el proyecto, ve a **Settings → Bindings → Add → D1 database**. En nombre de variable pon **`DB`** y elige la base que creaste.
5. En **Settings → Variables and secrets**, agrega **`SETUP_KEY`** como secreto (*Secret*), con una clave inventada. Se pide solo para crear la primera cuenta.
6. Vuelve a desplegar (**Deployments → Retry deployment**), porque los bindings se activan desde el siguiente despliegue.
7. Abre la URL, crea tu cuenta con la `SETUP_KEY` y completa los datos de la empresa.

## Seguridad

- El código se guarda con hash (PBKDF2) y la sesión usa una cookie HttpOnly, Secure y SameSite=Strict.
- Después de 5 intentos fallidos, ese nombre queda bloqueado 15 minutos desde la misma IP. Después de 10, queda bloqueado 1 hora desde cualquier IP.
- La página no aparece en buscadores (`noindex` y `robots.txt`).
- No hay claves ni datos en este repo: todo lo sensible vive en Cloudflare (D1 y `SETUP_KEY`).
