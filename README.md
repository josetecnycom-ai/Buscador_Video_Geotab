# Solicitud de vídeo para MyGeotab

Add-In de página completa para pedir clips de vídeo desde la base de datos abierta en MyGeotab. Está construido con React, Zenith y la sesión API del usuario activo. No incluye contraseñas ni descarga los vídeos.

## Funciones

- Busca cámaras por matrícula, nombre del activo o serie de cámara.
- Usa la zona horaria del activo y convierte el intervalo local a UTC.
- Limita cada intervalo solicitado a 20 minutos y muestra avisos antes de enviarlo.
- Divide intervalos en clips de hasta 120 segundos.
- Envía tandas de hasta 16 solicitudes pendientes por cámara y consulta los estados de MyGeotab.
- Guarda solicitudes e historial en `localStorage`, separado por base de datos, para reanudar en el mismo navegador.
- No descarga medios. Las grabaciones se abren desde las secciones de vídeo de MyGeotab.

La API de captura solicita medios `VIDEO`; la cámara y MyGeotab determinan las fuentes y el audio disponibles según la configuración activa.

## Desarrollo local

Requiere Node.js 22 o posterior.

```powershell
npm ci
npm run dev
```

El modo local no proporciona por sí mismo la sesión embebida de MyGeotab. Para usar la aplicación completa, instala el Add-In en una base de pruebas o ejecuta la vista con un entorno de Add-In de MyGeotab.

## Publicación

El workflow `.github/workflows/deploy-pages.yml` compila y publica `dist/` en GitHub Pages al actualizar `main`. En el repositorio, configura **Settings → Pages → Build and deployment → Source: GitHub Actions**. La URL configurada en `AddInConfiguration.json` es:

`https://josetecnycom-ai.github.io/Buscador_Video_Geotab/`

## Instalar manualmente en MyGeotab

1. Publica el sitio en GitHub Pages y espera a que termine correctamente el workflow de despliegue.
2. Abre la base de datos deseada en MyGeotab.
3. Ve a **Administration → System → System Settings → Add-Ins → New Add-In**.
4. Copia el contenido de `AddInConfiguration.json` en la pestaña de configuración, guarda y actualiza MyGeotab.
5. Abre la sección de vídeo y selecciona **Solicitar vídeo**.

La posición se establece con `path: "VideoId/"`, según el identificador de menú indicado para la instalación. La cuenta conectada necesita acceso a las cámaras y permiso para solicitar/ver grabaciones.
