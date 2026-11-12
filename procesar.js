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
  // v237: primero entra en modo ligero (no baja archivos) y pregunta si algo cambió desde el último cálculo; solo si hay algo nuevo
  // (o una versión de la app sin revisar) vuelve a abrirla completa. Así casi no gasta tráfico de Supabase en las horas sin cambios.
  const sep = o.url.indexOf('?') >= 0 ? '&' : '?';
  await page.goto(o.url + sep + 'robot=ligero', { waitUntil: 'networkidle2', timeout: 120000 });
  const est = () => page.evaluate(() => window.gsrRobot ? window.gsrRobot.estado() : null).catch(() => null);
  // Entrar (si la sesión no sigue abierta)
  for (let i = 0; i < 30; i++) { const e = await est(); if (e && e.usuario) break;
    if (await page.$('#inEmail')) { await page.evaluate((u, c) => { const a = document.getElementById('inEmail'), b = document.getElementById('inPass'); a.value = u; b.value = c; a.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnEntrar').click(); }, o.usuario, o.clave); log('Entrando…'); await espera(5000);
      const msg = await page.$eval('.entrar-msg', x => x.textContent).catch(() => ''); if (msg) return { ok: false, error: 'No pudo entrar: ' + msg }; }
    else await espera(2000); }
  let e = await est(); if (!e || !e.usuario) return { ok: false, error: 'No pudo entrar (¿cambió la contraseña o la dirección?)' };
  if (!e.admin) return { ok: false, error: 'La cuenta del procesador no tiene permiso de administrador' };
  const H = await page.evaluate(() => window.gsrRobot && window.gsrRobot.hayNuevo ? window.gsrRobot.hayNuevo() : { nuevo: true, motivos: ['versión anterior de la app'] }).catch(() => ({ nuevo: true, motivos: ['no pude preguntar'] }));
  const ver = await page.evaluate(() => window.gsrRobot && window.gsrRobot.version ? window.gsrRobot.version() : '').catch(() => ''), probada = await page.evaluate(() => window.gsrRobot && window.gsrRobot.probada ? window.gsrRobot.probada() : '').catch(() => '');
  const probar = !!ver && ver !== probada && !o.sinPrueba;
  if (!H.nuevo && !probar) return { ok: true, sinCambios: true, archivos: 0 };
  log((H.nuevo ? 'Hay algo nuevo (' + H.motivos.join(', ') + ')' : 'Sin cambios en los archivos') + (probar ? '; versión nueva de la app (' + ver + ')' : '') + '. Abriendo la app completa…');
  await page.goto(o.url, { waitUntil: 'networkidle2', timeout: 120000 });
  for (let i = 0; i < 30; i++) { e = await est(); if (e && e.usuario) break; await espera(2000); }
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
  // v222: revisión de lo que no cuadra (la app la guarda en la nube y la manda a los administradores a las 9:00); aquí solo cuántos puntos
  const rev = await page.evaluate(() => window.gsrRobot && window.gsrRobot.revisar ? window.gsrRobot.revisar() : null).catch(() => null);
  // v237: si el cálculo de esta corrida falló, la corrida sale en rojo y dice en palabras dónde (la app también lo deja en la nube para los avisos)
  const fallo = await page.evaluate(t => window.gsrRobot && window.gsrRobot.errorCalculo ? window.gsrRobot.errorCalculo(t) : '', t0).catch(() => '');
  // v237: versión nueva de la app: abre cada pestaña de cada módulo y anota si alguna tiene errores
  let prueba = null; if (probar) prueba = await probarVersion(page, ver);
  if (e && e.error) return { ok: false, error: 'OneDrive: ' + e.error, archivos: e.archivos, prueba };
  if (fallo) return { ok: false, error: fallo, archivos: e ? e.archivos : 0, prueba };
  return { ok: true, archivos: e ? e.archivos : 0, puntos: rev ? rev.puntos : null, prueba };
}

// Revisa una versión nueva: cada pestaña de cada módulo, anotando los errores de la página (sin datos de la empresa: solo la pestaña y el error técnico)
async function probarVersion(page, ver) { const errores = [], oir = er => errores.push(String(er && er.message || er).slice(0, 160)); page.on('pageerror', oir);
  const rutas = await page.evaluate(() => window.gsrRobot && window.gsrRobot.rutas ? window.gsrRobot.rutas() : []).catch(() => []), malas = [];
  // v238: en tamaño teléfono, además de los errores de código, la revisión visual (tablas aplastadas, texto roto, cosas que se salen de la pantalla)
  const vp = page.viewport(); await page.setViewport({ width: 390, height: 844 }).catch(() => null);
  // v247: la revisión de pestañas tiene su propio tope (5 minutos) para no pasarse del límite de la corrida; si no alcanza, lo dice
  const tTope = Date.now() + 5 * 60000; let hechas = 0;
  for (const r of rutas) { if (Date.now() > tTope) break; hechas++; const n0 = errores.length; await page.evaluate(v => window.gsrRobot.ir(v), r).catch(() => null); await espera(1200);
    const vis = await page.evaluate(() => window.gsrRobot.pantalla ? window.gsrRobot.pantalla() : []).catch(() => []);
    if (errores.length > n0) malas.push({ ruta: r, error: errores[errores.length - 1] }); else if (vis.length) malas.push({ ruta: r, error: vis.join('; ') }); }
  if (vp) await page.setViewport(vp).catch(() => null);
  page.off('pageerror', oir); const res = { version: ver, ok: !malas.length, revisadas: hechas, de: rutas.length, errores: malas.slice(0, 20) };
  await page.evaluate(x => window.gsrRobot.guardarPrueba(x), res).catch(() => null);
  log('Versión ' + ver + ': ' + hechas + (hechas < rutas.length ? ' de ' + rutas.length : '') + ' pestañas revisadas' + (hechas < rutas.length ? ' (se acabó el tiempo de la revisión)' : '') + ', ' + (malas.length ? malas.length + ' con error: ' + malas.slice(0, 5).map(m => m.ruta).join(', ') : 'sin errores'));
  return res; }

async function main() {
  const url = process.env.GSR_URL, usuario = process.env.GSR_USUARIO, clave = process.env.GSR_CLAVE;
  if (!url || !usuario || !clave) { console.error('Faltan los secretos GSR_URL, GSR_USUARIO o GSR_CLAVE'); process.exit(1); }
  // v222: si falla por algo pasajero (la app tardó, OneDrive no respondió), lo intenta una vez más antes de avisar
  // v247: el segundo intento solo si el primero falló pronto (dos intentos largos se pasaban de los 30 minutos de la corrida y GitHub la cancelaba sin avisar)
  const t00 = Date.now(); let r; for (let intento = 1; intento <= 2; intento++) { const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try { const p = await b.newPage(); await p.emulateTimezone('America/Mexico_City'); await p.setViewport({ width: 1280, height: 900 });
      p.on('dialog', d => d.dismiss().catch(() => null)); r = await procesar(p, { url, usuario, clave }); }
    catch (er) { r = { ok: false, error: String(er && er.message || er).slice(0, 200) }; }
    finally { await b.close().catch(() => null); }
    if (r.ok || /contraseña|permiso|Faltan/.test(r.error || '') || intento === 2 || Date.now() - t00 > 8 * 60000) break;
    log('Falló (' + r.error + '); se intenta otra vez en 30 segundos…'); await espera(30000); }
  if (r.ok && r.sinCambios) { log('Sin cambios desde el último cálculo: no se bajó nada.'); process.exit(0); }
  if (r.ok) { log('Listo: datos al día (' + r.archivos + ' archivos vigentes' + (r.puntos != null ? '; revisión: ' + r.puntos + ' punto(s) por revisar, el detalle lo ve el administrador en la app' : '') + ').'); process.exit(0); }
  console.error('Falló: ' + r.error); process.exit(1);
}
if (require.main === module) main();
module.exports = { procesar };
