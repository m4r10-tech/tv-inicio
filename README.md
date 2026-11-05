# tv-inicio

Pantalla de inicio y panel de control web para una Samsung con **Tizen 4** (2018), como módulo de
[TizenBrew](https://github.com/reisxd/TizenBrew). No se instala nada en la tele: TizenBrew descarga el módulo
de jsDelivr al abrirlo, así que no ocupa espacio.

## Qué hace

- **Pantalla de inicio**: fondos de paisajes (Suiza, Noruega, Canadá), hora y fecha en el centro, accesos a
  YouTube, Netflix, Prime Video, TV, Jellyfin y Navegador, lista completa de apps, fuentes HDMI y ajustes arriba
  a la derecha. Modo noche por defecto y botón para pasar a día. Cursor libre con el botón rojo del mando.
- **YouTube sin anuncios**: el acceso de YouTube abre [TizenTube](https://github.com/reisxd/TizenTube) a través
  de TizenBrew (anuncios fuera, SponsorBlock). Al salir de YouTube se vuelve a Inicio.
- **Panel web** en `http://<ip-de-la-tele>:8090/gestion` (con usuario y contraseña): apagar, mando completo,
  abrir apps y fuentes, temporizador de apagado (con o sin aviso en la tele), control parental (bloquear apps y
  fuentes), modo día/noche, espacio libre de la tele y diagnóstico.

## Instalación

1. Tener TizenBrew instalado y el modo desarrollador con *Host PC IP* `127.0.0.1`.
2. En TizenBrew: *Gestor de módulos → Añadir módulo GitHub* → `m4r10-tech/tv-inicio@main`.
3. En TizenBrew: *Ajustes → Ajustes de AutoLaunch* → **Inicio**.
4. Abrir `http://<ip-de-la-tele>:8090/login` y elegir la contraseña del panel (solo la primera vez).
5. La primera vez que se use el mando desde Inicio o el panel, la tele pide permiso para «Inicio TV»: aceptar.

## Cómo funciona

| Pieza | Dónde corre | Qué usa |
|---|---|---|
| `app/` | Navegador de TizenBrew | Servicio local (`127.0.0.1:8090/local/*`) y WebSocket de TizenBrew (`127.0.0.1:8081`) para abrir TizenTube |
| `service/service.js` | Servicio de TizenBrew (Node 4.4.3, en un `vm`) | Solo módulos nativos de Node. API de Tizen (`tizen.application`, `tizen.systeminfo`) y API remota de la tele (`wss://127.0.0.1:8002`) |
| `panel/index.html` | Navegador del móvil o del PC | Lo sirve el servicio; habla con `/api/*` |

Lo que se guarda en la tele: `/home/owner/share/tv-inicio.json` (permisos 600) con el hash de la contraseña
(PBKDF2), las sesiones (hash), el token de la API remota y los ajustes. Nada sale de la tele salvo la descarga
del propio módulo y de la letra (jsDelivr).

Límites conocidos (sin root): el botón *Home* del mando sigue abriendo el menú de Samsung; el bloqueo de fuentes
HDMI solo se respeta desde Inicio y el panel; encender la tele no se puede desde el panel (está en la propia
tele): hay que usar el mando o Wake-on-LAN.

## Licencias

Código: MIT ([LICENSE](LICENSE)). Fondos: Wikimedia Commons, cada uno con su licencia
([app/fondos/CREDITOS.md](app/fondos/CREDITOS.md)). Letra: IBM Plex Sans (SIL OFL), servida por jsDelivr/Fontsource.
