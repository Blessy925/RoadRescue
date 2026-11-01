const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const tls = require('node:tls');
const { promisify } = require('node:util');
require('dotenv').config();
const nodemailer = require('nodemailer');

const ROOT = __dirname;
const scrypt = promisify(crypto.scrypt);
const DATA_DIRECTORY = path.join(ROOT, 'data');
const DATABASE_FILE = process.env.ROADRESCUE_DATABASE || path.join(DATA_DIRECTORY, 'roadrescue.sqlite');
const HOSPITALS_FILE = process.env.HOSPITALS_FILE || path.join(DATA_DIRECTORY, 'hospitals.json');
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIRECTORY, 'users.json');
const ALERTS_FILE = process.env.ALERTS_FILE || path.join(DATA_DIRECTORY, 'alerts.json');
const AMBULANCES_FILE = process.env.AMBULANCES_FILE || path.join(DATA_DIRECTORY, 'ambulances.json');
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const systemCaCertificates = typeof tls.getCACertificates === 'function'
  ? tls.getCACertificates('system')
  : [];
const pendingRegistrationOtps = new Map();
const userSessions = new Map();
const hospitalSessions = new Map();
const registrationOtpSecret = crypto.randomBytes(32);
let database;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

async function sendRegistrationOtpEmail(email, otp) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASS;
  const sender = process.env.SMTP_FROM;
  if (!smtpHost || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535
    || !smtpUser || !smtpPassword || !sender) {
    throw Object.assign(new Error('Email verification is not configured. Set the SMTP settings in your .env file.'), { statusCode: 503 });
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPassword },
    tls: { ca: [...tls.rootCertificates, ...systemCaCertificates] }
  });
  await transporter.sendMail({
    from: sender,
    to: email,
    subject: 'Your RoadRescue verification code',
    text: `Your RoadRescue verification code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your RoadRescue verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes.</p>`
  });
}

async function readJsonFile(filePath, fallbackValue = []) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsedValue = JSON.parse(content);
    return parsedValue ?? fallbackValue;
  } catch (error) {
    if (error.code === 'ENOENT') return fallbackValue;
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  const temporaryFile = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryFile, filePath);
}

function readCollection(name) {
  const row = database.prepare('SELECT value FROM app_data WHERE name = ?').get(name);
  return row ? JSON.parse(row.value) : [];
}

function writeCollection(name, value) {
  database.prepare(`
    INSERT INTO app_data (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(name, JSON.stringify(value));
}

function withDatabaseTransaction(operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex, ...extra] = storedHash.split(':');
  if (extra.length || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) return false;
  const expectedHash = Buffer.from(hashHex, 'hex');
  const actualHash = await scrypt(password, Buffer.from(saltHex, 'hex'), expectedHash.length);
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

async function readHospitals() {
  return readCollection('hospitals');
}

async function writeHospitals(hospitals) {
  writeCollection('hospitals', hospitals);
}

async function readUsers() {
  return readCollection('users');
}

async function writeUsers(users) {
  writeCollection('users', users);
}

async function readAlerts() {
  return readCollection('alerts');
}

async function writeAlerts(alerts) {
  writeCollection('alerts', alerts);
}

async function readAmbulances() {
  return readCollection('ambulances');
}

async function writeAmbulances(ambulances) {
  writeCollection('ambulances', ambulances);
}

const STANDARD_HOSPITAL_FLEET = [
  { vanNumber: 'Van 12', driverName: 'Ramesh', phone: '+91 98765 43210' },
  { vanNumber: 'Van 18', driverName: 'Suresh', phone: '+91 98123 45678' },
  { vanNumber: 'Van 25', driverName: 'Karthik', phone: '+91 98761 23456' }
];

function createHospitalAmbulances(hospitalId, startIndex = 0) {
  return STANDARD_HOSPITAL_FLEET.slice(startIndex).map((details) => ({
    id: crypto.randomUUID(),
    ...details,
    status: 'ready',
    hospitalId,
  }));
}

function normalizeHospitalFleet(ambulances, hospitalId) {
  const fleet = ambulances.filter((ambulance) => ambulance.hospitalId === hospitalId);
  const assigned = fleet.filter((ambulance) => ambulance.status === 'assigned');
  const available = fleet.filter((ambulance) => ambulance.status !== 'assigned');
  const selected = [...assigned, ...available].slice(0, STANDARD_HOSPITAL_FLEET.length);
  const selectedIds = new Set(selected.map((ambulance) => ambulance.id));

  for (let index = ambulances.length - 1; index >= 0; index--) {
    const ambulance = ambulances[index];
    if (ambulance.hospitalId === hospitalId && ambulance.status !== 'assigned' && !selectedIds.has(ambulance.id)) {
      ambulances.splice(index, 1);
    }
  }

  if (selected.length < STANDARD_HOSPITAL_FLEET.length) {
    const additions = createHospitalAmbulances(hospitalId, selected.length);
    ambulances.push(...additions);
    selected.push(...additions);
  }

  selected.forEach((ambulance, index) => {
    Object.assign(ambulance, STANDARD_HOSPITAL_FLEET[index]);
    if (ambulance.status === 'assigned') return;
    ambulance.status = 'ready';
    delete ambulance.assignedAlertId;
    delete ambulance.assignedAt;
    delete ambulance.assignedHospitalId;
    delete ambulance.latitude;
    delete ambulance.longitude;
    delete ambulance.locationUpdatedAt;
  });

  return selected;
}

function ensureHospitalAmbulances(hospitalId) {
  return withDatabaseTransaction(() => {
    const ambulances = readCollection('ambulances');
    if (hospitalId === 'demo-hospital') {
      for (const ambulance of ambulances) {
        if (!ambulance.hospitalId && !ambulance.assignedHospitalId) {
          ambulance.hospitalId = hospitalId;
        }
      }
    }

    const hospitalFleet = normalizeHospitalFleet(ambulances, hospitalId);
    writeCollection('ambulances', ambulances);
    return hospitalFleet;
  });
}

async function initializeDatabase() {
  await fs.mkdir(path.dirname(DATABASE_FILE), { recursive: true });
  database = new DatabaseSync(DATABASE_FILE);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_data (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const collections = [
    ['hospitals', HOSPITALS_FILE],
    ['users', USERS_FILE],
    ['alerts', ALERTS_FILE],
    ['ambulances', AMBULANCES_FILE]
  ];
  const insert = database.prepare('INSERT OR IGNORE INTO app_data (name, value) VALUES (?, ?)');
  for (const [name, filePath] of collections) {
    const existing = database.prepare('SELECT 1 FROM app_data WHERE name = ?').get(name);
    if (!existing) {
      insert.run(name, JSON.stringify(await readJsonFile(filePath, [])));
    }
  }
}

async function seedDemoData() {
  const defaultHospital = {
    id: 'demo-hospital',
    name: 'City Hospital',
    email: 'demo@hospital.com',
    password: 'demo123',
    address: 'Near the main city emergency corridor',
    latitude: 12.9716,
    longitude: 77.5948,
    active: true,
    registeredAt: new Date().toISOString()
  };

  const defaultAmbulances = createHospitalAmbulances(defaultHospital.id);

  const hospitals = await readHospitals();
  if (!hospitals.some((hospital) => hospital.email?.toLowerCase() === defaultHospital.email)) {
    hospitals.unshift(defaultHospital);
  }
  for (const hospital of hospitals) {
    hospital.email = typeof hospital.email === 'string' && hospital.email.trim()
      ? hospital.email.trim().toLowerCase()
      : `hospital-${hospital.id || crypto.randomUUID()}@demo.local`;
    if (typeof hospital.passwordHash !== 'string') {
      hospital.passwordHash = await hashPassword(
        typeof hospital.password === 'string' && hospital.password ? hospital.password : 'demo123'
      );
    }
    delete hospital.password;
    if (!['pending', 'approved', 'rejected'].includes(hospital.status)) {
      hospital.status = hospital.id === 'demo-hospital' && hospital.active !== false
        ? 'approved'
        : 'pending';
    }
    hospital.active = hospital.status === 'approved';
    if (!hasValidCoordinates(hospital.latitude, hospital.longitude)) {
      hospital.latitude = 12.9716;
      hospital.longitude = 77.5948;
    } else {
      hospital.latitude = Number(hospital.latitude);
      hospital.longitude = Number(hospital.longitude);
    }
  }
  await writeHospitals(hospitals);
  try {
    await fs.access(HOSPITALS_FILE);
    await writeJsonFile(HOSPITALS_FILE, hospitals.map(publicHospital));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const ambulances = await readAmbulances();
  if (ambulances.length === 0) ambulances.push(...defaultAmbulances);
  for (const ambulance of ambulances) {
    if (!ambulance.hospitalId && !ambulance.assignedHospitalId) {
      ambulance.hospitalId = defaultHospital.id;
    }
    if (ambulance.status === 'assigned') ambulance.status = 'ready';
    delete ambulance.assignedAlertId;
    delete ambulance.assignedAt;
    delete ambulance.assignedHospitalId;
  }
  for (const hospital of hospitals) normalizeHospitalFleet(ambulances, hospital.id);

  await Promise.all([writeAmbulances(ambulances), writeAlerts([])]);
}

function publicHospital(hospital) {
  const { password, passwordHash, ...publicDetails } = hospital;
  return publicDetails;
}

function getHospitalSession(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = hospitalSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    hospitalSessions.delete(token);
    return null;
  }
  const hospital = readCollection('hospitals').find((entry) => (
    entry.id === session.hospitalId
    && entry.status === 'approved'
    && entry.active === true
  ));
  if (!hospital) {
    hospitalSessions.delete(token);
    return null;
  }
  return { ...session, hospital };
}

function getUserSession(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = userSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    userSessions.delete(token);
    return null;
  }
  const user = readCollection('users').find((entry) => entry.id === session.userId);
  if (!user) {
    userSessions.delete(token);
    return null;
  }
  return { ...session, user };
}

function createUserSession(user) {
  const accessToken = crypto.randomBytes(32).toString('hex');
  userSessions.set(accessToken, {
    userId: user.id,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  });
  return accessToken;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function isAdminRequest(request) {
  const expectedToken = process.env.HOSPITAL_ADMIN_TOKEN;
  const suppliedToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!expectedToken || !suppliedToken) return false;
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function distanceInKm(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function hasValidCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lng) && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (apiKey && apiKey !== 'YOUR_GOOGLE_MAPS_API_KEY') {
    try {
      const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      geocodeUrl.searchParams.set('address', address);
      geocodeUrl.searchParams.set('key', apiKey);

      const response = await fetch(geocodeUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'OK' && Array.isArray(data.results) && data.results.length > 0) {
          const { lat, lng } = data.results[0].geometry.location;
          return {
            latitude: Number(lat),
            longitude: Number(lng),
            displayName: data.results[0].formatted_address,
            approximate: false
          };
        }
      }
    } catch (error) {
      console.error('Google address lookup failed; trying OpenStreetMap:', error.message);
    }
  }

  const addressParts = address.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
  const localityParts = addressParts.filter((part) => !/\b(plot|opposite|opp\.?|near|mandal|enclave|colony|market|street|road|door|flat)\b|^\d/i.test(part));
  const fallbackQuery = [localityParts[0], localityParts.at(-1)]
    .filter(Boolean)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join(', ');
  const candidates = [...new Set([address, fallbackQuery]
    .filter((candidate) => candidate.length >= 3)
    .map((candidate) => /india/i.test(candidate) ? candidate : `${candidate}, India`))];

  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    const geocodeUrl = new URL('https://nominatim.openstreetmap.org/search');
    geocodeUrl.searchParams.set('format', 'jsonv2');
    geocodeUrl.searchParams.set('q', candidate);
    geocodeUrl.searchParams.set('limit', '1');
    geocodeUrl.searchParams.set('countrycodes', 'in');

    try {
      const response = await fetch(geocodeUrl, {
        headers: { 'User-Agent': 'RoadRescue/1.0 (hospital address lookup)', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) {
        console.error(`OpenStreetMap address lookup failed with HTTP ${response.status}.`);
        continue;
      }
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const latitude = Number(data[0].lat);
        const longitude = Number(data[0].lon);
        if (hasValidCoordinates(latitude, longitude)) {
          return {
            latitude,
            longitude,
            displayName: data[0].display_name,
            approximate: index > 0
          };
        }
      }
    } catch (error) {
      console.error('OpenStreetMap address lookup failed:', error.message);
    }
  }

  throw new Error('Could not find this address or locality. Enter a Google Maps link or coordinates, or try a nearby area and set the exact map pin.');
}

const reverseGeocodeCache = new Map();
async function reverseGeocodeCoordinates(latitude, longitude) {
  const cacheKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  if (reverseGeocodeCache.has(cacheKey)) return reverseGeocodeCache.get(cacheKey);

  const reverseUrl = new URL('https://nominatim.openstreetmap.org/reverse');
  reverseUrl.searchParams.set('format', 'jsonv2');
  reverseUrl.searchParams.set('lat', String(latitude));
  reverseUrl.searchParams.set('lon', String(longitude));
  reverseUrl.searchParams.set('zoom', '18');

  try {
    const response = await fetch(reverseUrl, {
      headers: { 'User-Agent': 'RoadRescue/1.0 (emergency address lookup)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
      console.error(`OpenStreetMap reverse lookup failed with HTTP ${response.status}.`);
      return null;
    }
    const data = await response.json();
    const addressParts = data.address && typeof data.address === 'object' ? data.address : {};
    const street = [addressParts.house_number, addressParts.road].filter(Boolean).join(' ').trim();
    const selectedParts = [
      street,
      addressParts.neighbourhood || addressParts.suburb || addressParts.quarter,
      addressParts.state_district || addressParts.county || addressParts.city_district || addressParts.district,
      addressParts.postcode
    ].filter((part) => typeof part === 'string' && part.trim());
    const address = [...new Map(selectedParts.map((part) => [part.trim().toLowerCase(), part.trim()])).values()].join(', ')
      || (typeof data.display_name === 'string' ? data.display_name.trim() : '');
    if (address) reverseGeocodeCache.set(cacheKey, address);
    return address || null;
  } catch (error) {
    console.error('OpenStreetMap reverse lookup failed:', error.message);
    return null;
  }
}

async function serveStaticFile(requestPath, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL path.' });
    return;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }
  const privateDirectory = path.resolve(DATA_DIRECTORY);
  const privateRelativePath = path.relative(privateDirectory, filePath);
  if (!privateRelativePath || (privateRelativePath !== '..'
    && !privateRelativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(privateRelativePath))) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': content.length
    });
    response.end(content);
  } catch (error) {
    sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'Not found.' : 'Could not read file.' });
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const { pathname, searchParams } = requestUrl;

  if (request.method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true, timestamp: new Date().toISOString() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/demo/reset-dispatch') {
    if (!process.env.HOSPITAL_ADMIN_TOKEN) {
      sendJson(response, 503, { error: 'Dispatch reset is disabled until HOSPITAL_ADMIN_TOKEN is configured.' });
      return;
    }
    if (!isAdminRequest(request)) {
      sendJson(response, 401, { error: 'A valid hospital administrator token is required.' });
      return;
    }
    const ambulances = await readAmbulances();
    for (const ambulance of ambulances) {
      ambulance.status = 'ready';
      delete ambulance.assignedAlertId;
      delete ambulance.assignedAt;
      delete ambulance.assignedHospitalId;
    }
    await Promise.all([writeAlerts([]), writeAmbulances(ambulances)]);
    sendJson(response, 200, { reset: true, ambulanceCount: ambulances.length });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/request-otp') {
    const body = await readJsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      sendJson(response, 400, { error: 'Provide a valid email address.' });
      return;
    }

    const users = await readUsers();
    if (users.some((user) => typeof user.email === 'string' && user.email.toLowerCase() === email)) {
      sendJson(response, 409, { error: 'An account with this email already exists. Please sign in.' });
      return;
    }

    for (const [pendingEmail, pending] of pendingRegistrationOtps) {
      if (pending.expiresAt <= Date.now()) pendingRegistrationOtps.delete(pendingEmail);
    }
    const existingOtp = pendingRegistrationOtps.get(email);
    if (existingOtp && Date.now() - existingOtp.sentAt < 60_000) {
      sendJson(response, 429, {
        error: 'A verification code was just sent. Please enter the code already sent to your email.',
        codeAlreadySent: true
      });
      return;
    }

    const otp = crypto.randomInt(0, 10_000).toString().padStart(4, '0');
    try {
      await sendRegistrationOtpEmail(email, otp);
    } catch (error) {
      console.error('Could not send registration verification code:', error);
      sendJson(response, error.statusCode || 502, {
        error: error.statusCode === 503
          ? error.message
          : 'The verification email could not be sent. Check the address and try again later.'
      });
      return;
    }

    const otpHash = crypto.createHmac('sha256', registrationOtpSecret)
      .update(`${email}:${otp}`)
      .digest();
    pendingRegistrationOtps.set(email, {
      otpHash,
      expiresAt: Date.now() + 10 * 60_000,
      sentAt: Date.now(),
      attempts: 0,
      verified: false
    });
    sendJson(response, 200, { message: 'A 4-digit verification code was sent to your email.' });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/verify-otp') {
    const body = await readJsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const otp = typeof body.otp === 'string' ? body.otp : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{4}$/.test(otp)) {
      sendJson(response, 400, { error: 'Enter a valid email address and 4-digit verification code.' });
      return;
    }

    const pending = pendingRegistrationOtps.get(email);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingRegistrationOtps.delete(email);
      sendJson(response, 400, { error: 'Your verification code has expired. Request a new code.' });
      return;
    }
    const submittedHash = crypto.createHmac('sha256', registrationOtpSecret)
      .update(`${email}:${otp}`)
      .digest();
    if (!crypto.timingSafeEqual(pending.otpHash, submittedHash)) {
      pending.attempts += 1;
      if (pending.attempts >= 5) {
        pendingRegistrationOtps.delete(email);
        sendJson(response, 429, { error: 'Too many incorrect codes. Request a new verification code.' });
        return;
      }
      sendJson(response, 400, { error: `That code is incorrect. ${5 - pending.attempts} attempts remaining.` });
      return;
    }

    if (!pending.verified) {
      pending.registrationToken = crypto.randomBytes(32).toString('hex');
      pending.registrationTokenHash = crypto.createHmac('sha256', registrationOtpSecret)
        .update(`${email}:${pending.registrationToken}`)
        .digest();
      pending.verified = true;
    }
    sendJson(response, 200, { verified: true, registrationToken: pending.registrationToken });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/complete-registration') {
    const body = await readJsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const registrationToken = typeof body.registrationToken === 'string' ? body.registrationToken : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      sendJson(response, 400, { error: 'Provide a valid email address.' });
      return;
    }
    if (password.length < 8 || password.length > 1024) {
      sendJson(response, 400, { error: 'Password must be at least 8 characters long.' });
      return;
    }

    const pending = pendingRegistrationOtps.get(email);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingRegistrationOtps.delete(email);
      sendJson(response, 403, { error: 'Verify your email address before creating a password.' });
      return;
    }
    if (!pending.verified || !/^[a-f0-9]{64}$/i.test(registrationToken)) {
      sendJson(response, 403, { error: 'Verify your email address before creating a password.' });
      return;
    }
    const submittedTokenHash = crypto.createHmac('sha256', registrationOtpSecret)
      .update(`${email}:${registrationToken}`)
      .digest();
    if (!crypto.timingSafeEqual(pending.registrationTokenHash, submittedTokenHash)) {
      sendJson(response, 403, { error: 'Email verification has expired. Verify your email again.' });
      return;
    }
    const users = await readUsers();
    if (users.some((user) => typeof user.email === 'string' && user.email.toLowerCase() === email)) {
      pendingRegistrationOtps.delete(email);
      sendJson(response, 409, { error: 'An account with this email already exists. Please sign in.' });
      return;
    }

    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      name: email.slice(0, email.indexOf('@')),
      emailVerified: true,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await writeUsers(users);
    pendingRegistrationOtps.delete(email);
    sendJson(response, 201, { message: 'Your account has been created. You can now sign in.' });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      sendJson(response, 400, { error: 'Email and password are required.' });
      return;
    }

    const users = await readUsers();
    const matchingUser = users.find((user) => user.email.toLowerCase() === email);
    const passwordMatches = matchingUser && (
      typeof matchingUser.passwordHash === 'string'
        ? await verifyPassword(password, matchingUser.passwordHash)
        : matchingUser.password === password
    );
    if (!passwordMatches) {
      sendJson(response, 401, { error: 'Invalid email or password.' });
      return;
    }
    if (matchingUser.emailVerificationRequired === true && matchingUser.emailVerified !== true) {
      sendJson(response, 403, { error: 'Complete email verification before signing in.' });
      return;
    }

    sendJson(response, 200, {
      user: {
        id: matchingUser.id,
        email: matchingUser.email,
        name: matchingUser.name || 'RoadRescue User'
      },
      accessToken: createUserSession(matchingUser)
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/google') {
    const body = await readJsonBody(request);
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
    if (!accessToken || accessToken.length > 4096) {
      sendJson(response, 400, { error: 'A valid Google access token is required.' });
      return;
    }

    let profileResponse;
    try {
      profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    } catch {
      sendJson(response, 502, { error: 'Google sign-in could not be verified. Please try again.' });
      return;
    }
    if (!profileResponse.ok) {
      sendJson(response, 401, { error: 'Google sign-in token is invalid or expired. Please try again.' });
      return;
    }

    const profile = await profileResponse.json();
    const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (!profile.sub || !email || profile.email_verified !== true) {
      sendJson(response, 401, { error: 'Google did not return a verified email address.' });
      return;
    }

    const users = await readUsers();
    let user = users.find((entry) => entry.email.toLowerCase() === email);
    if (!user) {
      user = {
        id: `google-${profile.sub}`,
        email,
        name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : email,
        provider: 'google',
        googleSubject: profile.sub,
        emailVerified: true,
        createdAt: new Date().toISOString()
      };
      users.push(user);
    } else {
      user.googleSubject = profile.sub;
      user.provider = user.provider || 'google';
      user.emailVerified = true;
      delete user.verificationTokenHash;
      delete user.verificationExpiresAt;
    }
    await writeUsers(users);

    sendJson(response, 200, {
      user: { id: user.id, email: user.email, name: user.name || 'RoadRescue User' },
      accessToken: createUserSession(user)
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/alerts') {
    const session = getUserSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Sign in before submitting an emergency request.' });
      return;
    }
    const body = await readJsonBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const age = body.age;
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const location = typeof body.location === 'string' ? body.location.trim() : address;
    const photo = typeof body.photo === 'string' ? body.photo : '';
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);

    if (!name || !address) {
      sendJson(response, 400, { error: 'Name and address are required for an emergency alert.' });
      return;
    }

    if (!hasValidCoordinates(latitude, longitude)) {
      sendJson(response, 400, { error: 'Share your current location before submitting an emergency request.' });
      return;
    }

    const ageValue = age === undefined || age === null || age === '' ? 'N/A' : String(age);
    const result = withDatabaseTransaction(() => {
      const alerts = readCollection('alerts');
      const now = Date.now();
      const duplicateAlert = alerts.find((existingAlert) => {
        const ageMs = now - Date.parse(existingAlert.createdAt);
        if (!['waiting', 'pending', 'new', 'accepted'].includes(existingAlert.status)
          || ageMs < 0 || ageMs > 5 * 60 * 1000) return false;
        if (existingAlert.userId !== session.user.id) return false;
        if (typeof existingAlert.name !== 'string'
          || existingAlert.name.trim().toLowerCase() !== name.toLowerCase()
          || String(existingAlert.age) !== ageValue) return false;
        return Math.round(Number(existingAlert.latitude) * 1000) === Math.round(latitude * 1000)
          && Math.round(Number(existingAlert.longitude) * 1000) === Math.round(longitude * 1000);
      });
      if (duplicateAlert) return { alert: duplicateAlert, duplicate: true };

      const alert = {
        id: crypto.randomUUID(),
        userId: session.user.id,
        name,
        age: ageValue,
        address,
        location,
        photo,
        latitude,
        longitude,
        priority: 'critical',
        status: 'waiting',
        createdAt: new Date(now).toISOString()
      };
      alerts.unshift(alert);
      writeCollection('alerts', alerts);
      return { alert };
    });
    sendJson(response, result.duplicate ? 200 : 201, result);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/alerts') {
    const session = getHospitalSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Hospital sign-in is required.' });
      return;
    }
    const alerts = (await readAlerts()).filter((alert) => distanceInKm(
      session.hospital.latitude,
      session.hospital.longitude,
      alert.latitude,
      alert.longitude
    ) <= 20);
    sendJson(response, 200, { alerts });
    return;
  }

  const alertStatusMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/status$/);
  if (request.method === 'GET' && alertStatusMatch) {
    const session = getUserSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Sign in to view your emergency request.' });
      return;
    }
    const alertId = decodeURIComponent(alertStatusMatch[1]);
    const alerts = await readAlerts();
    const alert = alerts.find((entry) => entry.id === alertId);
    if (!alert || alert.userId !== session.user.id) {
      sendJson(response, 404, { error: 'Alert not found.' });
      return;
    }

    const hospitals = await readHospitals();
    const ambulances = await readAmbulances();
    const acceptedHospital = hospitals.find((hospital) => hospital.id === alert.acceptedByHospital);
    const assignedAmbulance = ambulances.find((ambulance) => ambulance.id === alert.assignedAmbulanceId);
    sendJson(response, 200, {
      alert: {
        id: alert.id,
        status: alert.status,
        hospitalId: acceptedHospital?.id || null,
        hospitalName: acceptedHospital?.name || null,
        hospitalLocation: acceptedHospital ? {
          latitude: acceptedHospital.latitude,
          longitude: acceptedHospital.longitude
        } : null,
        ambulance: assignedAmbulance ? {
          vanNumber: assignedAmbulance.vanNumber,
          driverName: assignedAmbulance.driverName,
          phone: assignedAmbulance.phone
        } : null,
        updatedAt: alert.updatedAt || alert.createdAt
      }
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/ambulances') {
    const session = getHospitalSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Hospital sign-in is required.' });
      return;
    }
    const ambulances = ensureHospitalAmbulances(session.hospitalId);
    sendJson(response, 200, { ambulances });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/ambulances/assign') {
    const body = await readJsonBody(request);
    const alertId = typeof body.alertId === 'string' ? body.alertId : '';
    const ambulanceId = typeof body.ambulanceId === 'string' ? body.ambulanceId : '';
    const session = getHospitalSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Hospital sign-in is required.' });
      return;
    }
    const hospitalId = session.hospitalId;
    if (!alertId || !ambulanceId) {
      sendJson(response, 400, { error: 'alertId and ambulanceId are required.' });
      return;
    }

    const result = withDatabaseTransaction(() => {
      const ambulances = readCollection('ambulances');
      const ambulance = ambulances.find((entry) => entry.id === ambulanceId);
      if (!ambulance) {
        return { statusCode: 404, error: 'Ambulance not found.' };
      }
      if (ambulance.hospitalId !== hospitalId) {
        return { statusCode: 403, error: 'This ambulance is not allocated to your hospital.' };
      }
      if (ambulance.status !== 'ready') {
        return {
          statusCode: 409,
          error: ambulance.status === 'setup'
            ? 'Add driver details before assigning this ambulance.'
            : 'This ambulance is not available.'
        };
      }

      const alerts = readCollection('alerts');
      const alert = alerts.find((entry) => entry.id === alertId);
      if (!alert || alert.status !== 'accepted' || alert.acceptedByHospital !== hospitalId) {
        return { statusCode: 409, error: 'Accept this request before assigning an ambulance.' };
      }

      ambulance.status = 'assigned';
      ambulance.assignedAlertId = alertId;
      ambulance.assignedAt = new Date().toISOString();
      ambulance.assignedHospitalId = hospitalId;
      alert.status = 'dispatched';
      alert.assignedAmbulanceId = ambulanceId;
      alert.updatedAt = new Date().toISOString();
      writeCollection('ambulances', ambulances);
      writeCollection('alerts', alerts);
      return { ambulance, alert };
    });
    if (result.statusCode) {
      sendJson(response, result.statusCode, { error: result.error });
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/dispatch/requests') {
    const hospitalId = searchParams.get('hospitalId');
    const session = getHospitalSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Hospital sign-in is required.' });
      return;
    }
    if (hospitalId !== session.hospitalId) {
      sendJson(response, 403, { error: 'You can only view requests routed to your hospital.' });
      return;
    }
    const hospitals = await readHospitals();
    const activeHospitals = hospitals.filter((entry) => (
      entry.status === 'approved' && entry.active === true && hasValidCoordinates(entry.latitude, entry.longitude)
    ));
    const hospital = activeHospitals.find((entry) => entry.id === hospitalId);
    if (!hospital) {
      sendJson(response, 400, { error: 'A valid hospitalId is required.' });
      return;
    }
    const alerts = await readAlerts();
    const nearbyAlerts = alerts
      .filter((alert) => ['waiting', 'pending', 'new', 'accepted'].includes(alert.status))
      .map((alert) => {
        const distanceKm = distanceInKm(hospital.latitude, hospital.longitude, alert.latitude, alert.longitude);
        if (alert.status === 'accepted') {
          return alert.acceptedByHospital === hospitalId ? { ...alert, distanceKm } : null;
        }
        const passedHospitalIds = alert.passedHospitalIds || [];
        return distanceKm <= 20 && !passedHospitalIds.includes(hospitalId)
          ? { ...alert, distanceKm }
          : null;
      })
      .filter(Boolean)
      .sort((first, second) => first.distanceKm - second.distanceKm);
    sendJson(response, 200, { alerts: nearbyAlerts });
    return;
  }

  if (request.method === 'POST' && pathname.startsWith('/api/dispatch/')) {
    const actionMatch = pathname.match(/^\/api\/dispatch\/([^/]+)\/(accept|pass)$/);
    if (!actionMatch) {
      sendJson(response, 400, { error: 'Invalid dispatch action.' });
      return;
    }
    const [, alertId, action] = actionMatch;
    const session = getHospitalSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'Hospital sign-in is required.' });
      return;
    }
    const hospitalId = session.hospitalId;
    const result = withDatabaseTransaction(() => {
      const hospitals = readCollection('hospitals');
      const hospital = hospitals.find((entry) => (
        entry.id === hospitalId
        && entry.status === 'approved'
        && entry.active === true
        && hasValidCoordinates(entry.latitude, entry.longitude)
      ));
      if (!hospital) return { statusCode: 400, error: 'A valid hospitalId is required.' };

      const alerts = readCollection('alerts');
      const targetAlert = alerts.find((entry) => entry.id === alertId);
      if (!targetAlert) return { statusCode: 404, error: 'Alert not found.' };
      const passedHospitalIds = targetAlert.passedHospitalIds || [];
      if (distanceInKm(hospital.latitude, hospital.longitude, targetAlert.latitude, targetAlert.longitude) > 20
        || passedHospitalIds.includes(hospitalId)) {
        return { statusCode: 409, error: 'This request is only available to approved hospitals within 20 km.' };
      }
      if (!['waiting', 'pending', 'new'].includes(targetAlert.status)) {
        return {
          statusCode: 409,
          error: action === 'accept' ? 'This request is no longer available.' : 'Only pending requests can be passed.'
        };
      }

      if (action === 'accept') {
        targetAlert.status = 'accepted';
        targetAlert.acceptedByHospital = hospitalId;
      } else {
        targetAlert.status = 'pending';
        targetAlert.passedHospitalIds = [...new Set([...passedHospitalIds, hospitalId])];
      }
      targetAlert.updatedAt = new Date().toISOString();
      writeCollection('alerts', alerts);
      return { alert: targetAlert };
    });
    if (result.statusCode) {
      sendJson(response, result.statusCode, { error: result.error });
      return;
    }
    sendJson(response, 200, result);
  }

  if (request.method === 'GET' && pathname === '/api/hospitals/nearby') {
    const latitude = Number(searchParams.get('lat'));
    const longitude = Number(searchParams.get('lng'));
    const requestedRadius = Number(searchParams.get('radiusKm') || 20);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(requestedRadius) || requestedRadius <= 0) {
      sendJson(response, 400, { error: 'Provide valid lat, lng, and positive radiusKm query parameters.' });
      return;
    }

    const radiusKm = Math.min(requestedRadius, 50);
    const hospitals = await readHospitals();
    const nearby = hospitals
      .filter((hospital) => hospital.status === 'approved'
        && hospital.active === true
        && hasValidCoordinates(hospital.latitude, hospital.longitude))
      .map((hospital) => ({
        id: hospital.id,
        name: hospital.name,
        latitude: hospital.latitude,
        longitude: hospital.longitude,
        address: hospital.address,
        distanceKm: distanceInKm(latitude, longitude, hospital.latitude, hospital.longitude)
      }))
      .filter((hospital) => hospital.distanceKm <= radiusKm)
      .sort((hospitalA, hospitalB) => hospitalA.distanceKm - hospitalB.distanceKm);

    sendJson(response, 200, { radiusKm, count: nearby.length, hospitals: nearby });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/geocode') {
    const address = searchParams.get('address')?.trim() || '';
    if (!address || address.length > 500) {
      sendJson(response, 400, { error: 'Provide an address of 1 to 500 characters.' });
      return;
    }
    try {
      sendJson(response, 200, { location: await geocodeAddress(address) });
    } catch (error) {
      sendJson(response, 422, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && pathname === '/api/reverse-geocode') {
    const latitude = Number(searchParams.get('lat'));
    const longitude = Number(searchParams.get('lng'));
    if (!hasValidCoordinates(latitude, longitude)) {
      sendJson(response, 400, { error: 'Provide valid latitude and longitude coordinates.' });
      return;
    }
    sendJson(response, 200, { address: await reverseGeocodeCoordinates(latitude, longitude) });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/admin/hospitals') {
    if (!process.env.HOSPITAL_ADMIN_TOKEN) {
      sendJson(response, 503, { error: 'Hospital management is disabled until HOSPITAL_ADMIN_TOKEN is configured.' });
      return;
    }
    if (!isAdminRequest(request)) {
      sendJson(response, 401, { error: 'A valid hospital administrator token is required.' });
      return;
    }
    const hospitals = await readHospitals();
    const requestedStatus = searchParams.get('status');
    const filteredHospitals = requestedStatus
      ? hospitals.filter((hospital) => hospital.status === requestedStatus)
      : hospitals;
    sendJson(response, 200, { hospitals: filteredHospitals.map(publicHospital) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/hospitals') {
    const body = await readJsonBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const latitudeValue = body.latitude;
    const longitudeValue = body.longitude;
    let latitude = typeof latitudeValue === 'number' || (typeof latitudeValue === 'string' && latitudeValue.trim())
      ? Number(latitudeValue)
      : Number.NaN;
    let longitude = typeof longitudeValue === 'number' || (typeof longitudeValue === 'string' && longitudeValue.trim())
      ? Number(longitudeValue)
      : Number.NaN;
    if (!name || name.length > 120 || !address || address.length > 240) {
      sendJson(response, 400, { error: 'Provide a hospital name and a valid address.' });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      sendJson(response, 400, { error: 'Provide a valid hospital email address.' });
      return;
    }
    if (password.length < 8 || password.length > 1024) {
      sendJson(response, 400, { error: 'Password must be at least 8 characters long.' });
      return;
    }

    if (!hasValidCoordinates(latitude, longitude)) {
      try {
        const resolvedCoordinates = await geocodeAddress(address);
        if (resolvedCoordinates.approximate) {
          sendJson(response, 422, {
            error: 'We found the nearby area, but not the exact hospital pin. Use “Find address on map” and click the hospital entrance to confirm its coordinates.'
          });
          return;
        }
        latitude = resolvedCoordinates.latitude;
        longitude = resolvedCoordinates.longitude;
      } catch {
        sendJson(response, 422, { error: 'Could not locate this hospital address. Add a clearer city, state, and postal code, then try again.' });
        return;
      }
    }

    const hospital = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: await hashPassword(password),
      address,
      latitude,
      longitude,
      status: 'approved',
      active: true,
      registeredAt: new Date().toISOString()
    };
    const created = withDatabaseTransaction(() => {
      const hospitals = readCollection('hospitals');
      if (hospitals.some((entry) => entry.email && entry.email.toLowerCase() === email)) return false;
      hospitals.push(hospital);
      writeCollection('hospitals', hospitals);
      const ambulances = readCollection('ambulances');
      ambulances.push(...createHospitalAmbulances(hospital.id));
      writeCollection('ambulances', ambulances);
      return true;
    });
    if (!created) {
      sendJson(response, 409, { error: 'A hospital with this email is already registered.' });
      return;
    }
    sendJson(response, 201, {
      hospital: publicHospital(hospital),
      message: 'Registration complete. You can sign in now.'
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/hospitals/login') {
    const body = await readJsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      sendJson(response, 400, { error: 'Hospital email and password are required.' });
      return;
    }

    const hospitals = await readHospitals();
    const hospital = hospitals.find((entry) => entry.email && entry.email.toLowerCase() === email);
    const passwordMatches = hospital && typeof hospital.passwordHash === 'string'
      && await verifyPassword(password, hospital.passwordHash);
    if (!passwordMatches) {
      sendJson(response, 401, { error: 'Hospital credentials are invalid.' });
      return;
    }
    if (hospital.status !== 'approved' || hospital.active !== true) {
      sendJson(response, 403, { error: 'Registration under review.' });
      return;
    }

    const accessToken = crypto.randomBytes(32).toString('hex');
    hospitalSessions.set(accessToken, {
      hospitalId: hospital.id,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000
    });
    sendJson(response, 200, {
      hospital: {
        id: hospital.id,
        name: hospital.name,
        email: hospital.email,
        address: hospital.address,
        latitude: hospital.latitude,
        longitude: hospital.longitude,
        status: hospital.status
      },
      accessToken
    });
    return;
  }

  if (request.method === 'PATCH' && pathname.startsWith('/api/hospitals/')) {
    if (!process.env.HOSPITAL_ADMIN_TOKEN) {
      sendJson(response, 503, { error: 'Hospital management is disabled until HOSPITAL_ADMIN_TOKEN is configured.' });
      return;
    }
    if (!isAdminRequest(request)) {
      sendJson(response, 401, { error: 'A valid hospital administrator token is required.' });
      return;
    }

    const hospitalId = decodeURIComponent(pathname.slice('/api/hospitals/'.length));
    if (!hospitalId || hospitalId.includes('/')) {
      sendJson(response, 400, { error: 'A valid hospital ID is required.' });
      return;
    }
    const body = await readJsonBody(request);
    const status = typeof body.status === 'string'
      ? body.status
      : typeof body.active === 'boolean'
        ? body.active ? 'approved' : 'pending'
        : '';
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      sendJson(response, 400, { error: 'Provide status as pending, approved, or rejected.' });
      return;
    }
    const hospitals = await readHospitals();
    const hospital = hospitals.find((entry) => entry.id === hospitalId);
    if (!hospital) {
      sendJson(response, 404, { error: 'Registered hospital not found.' });
      return;
    }
    hospital.status = status;
    hospital.active = status === 'approved';
    await writeHospitals(hospitals);
    sendJson(response, 200, { hospital: publicHospital(hospital) });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API endpoint not found.' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  await serveStaticFile(pathname, response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal server error.' });
    } else {
      response.destroy(error);
    }
  });
});

initializeDatabase().then(seedDemoData).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`RoadRescue is running at http://${HOST}:${PORT}`);
    console.log(`SQLite database: ${DATABASE_FILE}`);
    console.log('Hospital accounts require administrator approval before sign-in or dispatch.');
  });
}).catch((error) => {
  console.error('Could not initialize RoadRescue database:', error);
  process.exit(1);
});
