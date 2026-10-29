// GSR360 · Procesador automático. Abre la app publicada como la cuenta robot (permiso de administrador), espera a que baje lo nuevo de
// OneDrive y lo recalcule (lo mismo que pasa cuando el administrador abre la app), fuerza una revisión más y se sale.
// No imprime ni guarda ningún dato de la empresa: solo «listo», cuántos archivos y los errores. La dirección de la app, el usuario y la
// contraseña llegan como secretos de GitHub (GSR_URL, GSR_USUARIO, GSR_CLAVE); nada de eso va en este archivo.
const puppeteer = require('puppeteer-core');
const espera = ms => new Promise(r => setTimeout(r, ms));
const log = t => console.log(new Date().toISOString().slice(11, 19) + ' ' + t);

// page: pestaña ya abierta. o = { url, usuario, clave, maxMin, quieto } → { ok, archivos, error }
async function procesar(page, o) {
  const maxMs = (o.maxMin || 12) * 60000, quieto = o.quieto || 25000, t0 = Date.now();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('gsr_inicio_v96', '1'); } catch (e) { } });
  await page.goto(o.url, { waitUntil: 'networkidle2', timeout: 120000 });
  const est = () => page.evaluate(() => window.gsrRobot ? window.gsrRobot.estado() : null).catch(() => null);
  // Entrar (si la sesión no sigue abierta)
  for (let i = 0; i < 30; i++) { const e = await est(); if (e && e.usuario) break;
    if (await page.$('#inEmail')) { await page.evaluate((u, c) => { const a = document.getElementById('inEmail'), b = document.getElementById('inPass'); a.value = u; b.value = c; a.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnEntrar').click(); }, o.usuario, o.clave); log('Entrando…'); await espera(5000);
      const msg = await page.$eval('.entrar-msg', x => x.textContent).catch(() => ''); if (msg) return { ok: false, error: 'No pudo entrar: ' + msg }; }
    else await espera(2000); }
  let e = await est(); if (!e || !e.usuario) return { ok: false, error: 'No pudo entrar (¿cambió la contraseña o la dirección?)' };
  if (!e.admin) return { ok: false, error: 'La cuenta del procesador no tiene permiso de administrador' };
  log('Dentro. Bajando de la nube y revisando OneDrive…');
  // Esperar a que termine lo que arranca solo al entrar; luego forzar una revisión de OneDrive y esperar otra vez
  const esperarQuieto = async (minimo) => { let desde = 0; const tIni = Date.now();
    while (Date.now() - t0 < maxMs) { e = await est(); const ocupado = !e || e.ocupado; if (ocupado) desde = 0; else if (!desde) desde = Date.now();
      if (Date.now() - tIni > minimo && desde && Date.now() - desde > quieto) return true; await espera(2000); }
    return false; };
  if (!(await esperarQuieto(20000))) return { ok: false, error: 'Se tardó más de ' + (o.maxMin || 12) + ' minutos' };
  await page.evaluate(() => window.gsrRobot.sincronizar()).catch(() => null); log('Revisión de OneDrive forzada…');
  if (!(await esperarQuieto(10000))) return { ok: false, error: 'Se tardó más de ' + (o.maxMin || 12) + ' minutos' };
  // El respaldo en Excel del día se arma 90 segundos después de entrar (una vez al día): darle tiempo
  if (Date.now() - t0 < 120000) await espera(120000 - (Date.now() - t0)); await esperarQuieto(5000);
  e = await est();
  return e && e.error ? { ok: false, error: 'OneDrive: ' + e.error, archivos: e.archivos } : { ok: true, archivos: e ? e.archivos : 0 };
}

async function main() {
  const url = process.env.GSR_URL, usuario = process.env.GSR_USUARIO, clave = process.env.GSR_CLAVE;
  if (!url || !usuario || !clave) { console.error('Faltan los secretos GSR_URL, GSR_USUARIO o GSR_CLAVE'); process.exit(1); }
  const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let r; try { const p = await b.newPage(); await p.emulateTimezone('America/Mexico_City'); await p.setViewport({ width: 1280, height: 900 });
    p.on('dialog', d => d.dismiss().catch(() => null)); r = await procesar(p, { url, usuario, clave }); }
  catch (er) { r = { ok: false, error: String(er && er.message || er).slice(0, 200) }; }
  finally { await b.close().catch(() => null); }
  if (r.ok) { log('Listo: datos al día (' + r.archivos + ' archivos vigentes).'); process.exit(0); }
  console.error('Falló: ' + r.error); process.exit(1);
}
if (require.main === module) main();
module.exports = { procesar };
