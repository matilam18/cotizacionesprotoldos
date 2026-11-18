# Cotizador ProToldos

Cotizador web privado de ProToldos. Se entra con nombre y un código de 4 números. Permite crear cotizaciones con IVA y descuento, generar el PDF con logo e imagen referencial del proyecto, guardarlas y buscarlas por empresa.

- `public/`: la interfaz (`index.html`, `app.js`, `app.css`, logo y librerías de PDF).
- `src/worker.js`: el servidor (login, base de datos y PDFs). Usa **Neon** (Postgres) por HTTP.
- `wrangler.jsonc`: configuración para Cloudflare Workers.
- Las tablas se crean solas en Neon la primera vez, si no existen.
- De cada cotización se guarda el PDF y sus datos de texto. Las imágenes no se guardan aparte.

## Publicar en Cloudflare (Workers, conectado a este repo)

1. **Workers & Pages → Create → Import a repository** y elige este repo. El Worker tiene que llamarse **`cotizacionesprotoldos`**, igual que `name` en `wrangler.jsonc`.
2. Deja el comando de deploy por defecto: `npx wrangler deploy`.
3. En el Worker, ve a **Settings → Variables and Secrets** y agrega dos secretos (tipo *Secret*):
   - **`DATABASE_URL`**: la cadena de conexión de Neon (en Neon: **Connect**, copiar la que empieza con `postgresql://`).
   - **`SETUP_KEY`**: una clave inventada. Solo se pide para crear la primera cuenta.
4. Cada push a `main` publica la nueva versión.
5. Abre la URL, crea tu cuenta con la `SETUP_KEY` y completa los datos de la empresa.

## Desarrollo

- `npm install`
- `npm run build`: regenera `public/_worker.js`, que sirve solo para Cloudflare Pages. Workers usa `src/worker.js` directamente.
- `npx wrangler dev --var DATABASE_URL:postgresql://... --var SETUP_KEY:...`

## Seguridad

- El código se guarda con hash (PBKDF2) y la sesión usa una cookie HttpOnly, Secure y SameSite=Strict.
- Después de 5 intentos fallidos, ese nombre queda bloqueado 15 minutos desde la misma IP. Después de 10, queda bloqueado 1 hora desde cualquier IP.
- `public/.assetsignore` evita que `_worker.js` se publique como archivo.
- La página no aparece en buscadores (`noindex` y `robots.txt`).
- No hay claves en este repo: `DATABASE_URL` y `SETUP_KEY` viven como secretos en Cloudflare.
