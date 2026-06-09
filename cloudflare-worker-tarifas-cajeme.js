const DEFAULT_ORIGIN = 'Antonio Caso #3002, Col. Casa Blanca, Ciudad Obregon, Sonora';
const MAX_KM = 15;

const TARIFFS = [
  { max: 4, fee: 30 },
  { max: 5, fee: 35 },
  { max: 6, fee: 40 },
  { max: 7, fee: 45 },
  { max: 8, fee: 50 },
  { max: 9, fee: 55 },
  { max: 9.9, fee: 60 },
  { max: 10, fee: 65 },
  { max: 11, fee: 70 },
  { max: 12, fee: 75 },
  { max: 13, fee: 80 },
  { max: 14, fee: 85 },
  { max: 15, fee: 90 },
];

const ZONE_EXTRAS = [
  { names: ['villa bonita'], fee: 10, label: 'Villa Bonita' },
  { names: ['esperanza'], fee: 10, label: 'Esperanza' },
  { names: ['cocorit', 'cócorit'], fee: 15, label: 'Cocorit' },
  { names: ['lomas paraiso', 'lomas paraíso'], fee: 5, label: 'Lomas Paraiso' },
  { names: ['santa catalina'], fee: 5, label: 'Santa Catalina' },
  { names: ['unison', 'universidad de sonora'], fee: 5, label: 'Unison' },
  { names: ['providencia'], fee: 5, label: 'Providencia' },
  { names: ['porton', 'portón'], fee: 15, label: 'Porton' },
  { names: ['campo 2', 'campo dos'], fee: 5, label: 'Campo 2' },
  { names: ['constellation', 'costelletion'], fee: 5, label: 'Constellation' },
  { names: ['beltrones'], fee: 10, label: 'Beltrones' },
  { names: ['almaneceres', 'amaneceres'], fee: 10, label: 'Almaneceres' },
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    if (url.pathname !== '/quote' || request.method !== 'POST') {
      return json({ ok: false, message: 'Endpoint no encontrado' }, 404);
    }
    if (!env.GOOGLE_MAPS_API_KEY) {
      return json({ ok: false, message: 'Falta configurar GOOGLE_MAPS_API_KEY en Cloudflare Worker' }, 500);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, message: 'JSON invalido' }, 400); }

    const origin = cleanAddress(body.origin || DEFAULT_ORIGIN);
    const destinationInput = cleanAddress(body.destination || '');
    if (!destinationInput) return json({ ok: false, message: 'Falta direccion destino' }, 400);

    const destination = addCityHint(destinationInput);
    let geocodeText = destination;
    try {
      const geocoded = await geocodeAddress(destination, env.GOOGLE_MAPS_API_KEY);
      if (geocoded && geocoded.formattedAddress) geocodeText = geocoded.formattedAddress;
    } catch (e) {
      // Routes API can geocode address strings internally, so continue.
      console.warn('Geocoding fallback:', e.message);
    }

    const route = await computeRoute(origin, geocodeText, env.GOOGLE_MAPS_API_KEY);
    const distanceMeters = route.distanceMeters;
    const distanceKmRaw = distanceMeters / 1000;
    const distanceKm = Math.round(distanceKmRaw * 10) / 10;

    if (distanceKm > MAX_KM) {
      return json({
        ok: true,
        overLimit: true,
        distanceMeters,
        distanceKm,
        maxKm: MAX_KM,
        fee: null,
        baseFee: null,
        extraFee: 0,
        extraZone: null,
        message: 'Envio por confirmar: supera 15 km',
        resolvedDestination: geocodeText,
      });
    }

    const baseFee = getBaseFee(distanceKm);
    const extra = detectZoneExtra(destinationInput + ' ' + geocodeText);
    const extraFee = extra ? extra.fee : 0;
    const fee = baseFee + extraFee;

    return json({
      ok: true,
      overLimit: false,
      distanceMeters,
      distanceKm,
      baseFee,
      extraFee,
      extraZone: extra ? extra.label : null,
      fee,
      resolvedDestination: geocodeText,
    });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function cleanAddress(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function addCityHint(address) {
  const low = normalize(address);
  if (low.includes('ciudad obregon') || low.includes('cd obregon') || low.includes('cajeme')) return address;
  return `${address}, Ciudad Obregon, Sonora, Mexico`;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBaseFee(km) {
  for (const row of TARIFFS) {
    if (km <= row.max) return row.fee;
  }
  return null;
}

function detectZoneExtra(text) {
  const normalized = normalize(text);
  let match = null;
  for (const zone of ZONE_EXTRAS) {
    if (zone.names.some((name) => normalized.includes(normalize(name)))) {
      if (!match || zone.fee > match.fee) match = zone;
    }
  }
  return match;
}

async function geocodeAddress(address, apiKey) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('region', 'mx');
  url.searchParams.set('key', apiKey);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.status !== 'OK' || !data.results || !data.results[0]) {
    throw new Error(data.error_message || data.status || 'Geocoding sin resultado');
  }
  return { formattedAddress: data.results[0].formatted_address };
}

async function computeRoute(origin, destination, apiKey) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      computeAlternativeRoutes: false,
      languageCode: 'es-MX',
      regionCode: 'mx',
      units: 'METRIC',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.routes || !data.routes[0]) {
    throw new Error((data.error && data.error.message) || 'Routes API sin ruta');
  }
  return data.routes[0];
}