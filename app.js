const fields = Object.fromEntries([
  'file-input', 'preview-image', 'preview-placeholder', 'photo-credit',
  'demo-picker', 'forecast-form', 'photo-date', 'latitude', 'longitude',
  'run-button', 'form-error', 'result', 'result-date', 'risk-number', 'risk-rank',
  'weather-through', 'weather-values', 'forecast-grid', 'reveal-button',
  'observation', 'observation-text', 'map-selected-label', 'risk-gauge', 'dataset-summary',
].map(id => [id, document.getElementById(id)]));

const grid = { south: 38, north: 40, west: -123, east: -120, step: 0.25, rows: 8, columns: 12 };
const cellCount = grid.rows * grid.columns;
const years = new Set(['2023', '2024']);
const dataCache = new Map();
const photoSamples = new Map();
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const weatherFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const initialRunLabel = fields['run-button'].textContent;
let photoObjectUrl;
let photoVersion = 0;
let requestVersion = 0;
let activeForecast;

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}.`);
  return response.json();
}

function replayForYear(year) {
  if (!dataCache.has(year)) {
    dataCache.set(year, loadJson(`data/replay-${year}.json`).catch(error => {
      dataCache.delete(year);
      throw error;
    }));
  }
  return dataCache.get(year);
}

function dateOffset(date, days) {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

function formatDate(date) {
  return dateFormat.format(new Date(`${date}T00:00:00Z`));
}

function formatCoordinate(value, positive, negative) {
  return `${Math.abs(value).toFixed(3)}° ${value >= 0 ? positive : negative}`;
}

function positionOf(cell) {
  const row = Math.floor(cell / grid.columns);
  const column = cell % grid.columns;
  return [grid.south + (row + 0.5) * grid.step, grid.west + (column + 0.5) * grid.step];
}

function cellFor(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < grid.south || lat >= grid.north || lon < grid.west || lon >= grid.east) {
    throw new Error('Enter a location inside the Northern California study area.');
  }
  const row = Math.floor((lat - grid.south) / grid.step);
  const column = Math.floor((lon - grid.west) / grid.step);
  return row * grid.columns + column;
}

function describeCell(cell) {
  const [lat, lon] = positionOf(cell);
  return `Cell ${cell} · ${formatCoordinate(lat, 'N', 'S')}, ${formatCoordinate(lon, 'E', 'W')}`;
}

function showError(message = '') {
  fields['form-error'].textContent = message;
  fields['form-error'].hidden = !message;
}

function setBusy(busy) {
  fields['run-button'].disabled = busy;
  fields['run-button'].textContent = busy ? 'Loading forecast…' : initialRunLabel;
}

function invalidateForecast() {
  ++requestVersion;
  activeForecast = undefined;
  setBusy(false);
  fields.result.hidden = true;
  fields['observation'].hidden = true;
  fields['observation-text'].textContent = '';
  showError();
}

function setPhoto(url, { alt, credit, source, uploaded = false }) {
  if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
  photoObjectUrl = uploaded ? url : undefined;
  const current = ++photoVersion;
  const preview = fields['preview-image'];
  const placeholder = fields['preview-placeholder'];
  preview.alt = alt;
  preview.hidden = false;
  placeholder.hidden = true;
  preview.onerror = () => {
    if (current !== photoVersion) return;
    preview.hidden = true;
    placeholder.hidden = false;
    if (uploaded) showError('This image could not be displayed. Try a JPEG, PNG or WebP photo.');
  };
  preview.src = url;

  const attribution = fields['photo-credit'];
  if (source && attribution.tagName === 'A') {
    attribution.href = source;
    attribution.textContent = credit;
  } else if (source) {
    const link = document.createElement('a');
    link.href = source;
    link.textContent = credit;
    attribution.replaceChildren(link);
  } else {
    attribution.removeAttribute('href');
    attribution.textContent = credit;
  }
}

function selectSample(sample) {
  invalidateForecast();
  fields['file-input'].value = '';
  fields['photo-date'].value = sample.photoDate;
  fields.latitude.value = sample.lat;
  fields.longitude.value = sample.lon;
  const image = sample.id === 'tonzi-2023-07-02' ? 'tonzi' : sample.id;
  setPhoto(`assets/${image}.jpg`, {
    alt: `Tonzi Ranch landscape from ${formatDate(sample.photoDate)}`,
    credit: sample.credit,
    source: sample.source,
  });
}

function heatColor(probability) {
  const heat = Math.min(1, Math.sqrt(probability / 0.45));
  const stops = [[28, 58, 52], [165, 145, 70], [243, 166, 83]];
  const segment = heat <= 0.55 ? 0 : 1;
  const fraction = segment === 0 ? heat / 0.55 : (heat - 0.55) / 0.45;
  const rgb = stops[segment].map((value, channel) =>
    Math.round(value + fraction * (stops[segment + 1][channel] - value)));
  return `rgb(${rgb.join(', ')})`;
}

function formatRisk(probability) {
  if (probability > 0 && probability < 0.001) return '<0.1%';
  return `${(probability * 100).toFixed(1)}%`;
}

function paintMap() {
  const map = fields['forecast-grid'];
  const fragment = document.createDocumentFragment();
  for (let row = grid.rows - 1; row >= 0; row--) {
    for (let column = 0; column < grid.columns; column++) {
      const cell = row * grid.columns + column;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'map-cell';
      tile.dataset.cell = cell;
      tile.tabIndex = -1;
      fragment.append(tile);
    }
  }
  map.replaceChildren(fragment);
}

function refreshMap() {
  const { day, selectedCell, revealed } = activeForecast;
  for (const tile of fields['forecast-grid'].children) {
    const cell = Number(tile.dataset.cell);
    const risk = day.p[cell];
    const selected = cell === selectedCell;
    const reported = revealed && day.n[cell] > 0;
    tile.title = `${describeCell(cell)} · ${formatRisk(risk)} estimated risk${revealed ? ` · ${day.n[cell]} reports` : ''}`;
    tile.setAttribute('aria-label', tile.title);
    tile.setAttribute('aria-pressed', String(selected));
    tile.classList.toggle('selected', selected);
    tile.classList.toggle('reported', reported);
    tile.style.setProperty('--heat', String(risk));
    tile.style.setProperty('--cell-color', heatColor(risk));
    tile.tabIndex = selected ? 0 : -1;
  }
}

function renderWeather(row) {
  const displayed = [
    ['Max temperature', `${weatherFormat.format(row[0])}°C`],
    ['Min humidity', `${weatherFormat.format(row[1])}%`],
    ['Mean wind', `${weatherFormat.format(row[2])} m/s`],
    ['Rain', `${weatherFormat.format(row[3])} mm`],
  ];
  fields['weather-values'].replaceChildren(...displayed.map(([label, value]) => {
    const pair = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value;
    pair.append(term, definition);
    return pair;
  }));
}

function renderForecast() {
  const { day, selectedCell, targetDate, ranks, revealed } = activeForecast;
  const probability = day.p[selectedCell];
  const selectedCount = day.n[selectedCell];
  const cellsWithReports = day.n.filter(count => count > 0).length;
  fields.result.hidden = false;
  fields['result-date'].textContent = formatDate(targetDate);
  fields['risk-number'].textContent = formatRisk(probability);
  fields['risk-rank'].textContent = `Rank ${ranks[selectedCell]} of ${cellCount} cells`;
  fields['weather-through'].textContent = formatDate(dateOffset(targetDate, -2));
  if (fields['map-selected-label']) fields['map-selected-label'].textContent = describeCell(selectedCell);
  fields['risk-gauge']?.style.setProperty('--progress', `${probability * 100}%`);
  renderWeather(day.w[selectedCell]);
  refreshMap();

  fields['reveal-button'].disabled = false;
  fields['reveal-button'].textContent = revealed ? 'Hide recorded outcome' : 'Reveal recorded outcome';
  fields['reveal-button'].setAttribute('aria-expanded', String(revealed));
  fields.observation.hidden = !revealed;
  fields['observation-text'].textContent = revealed
    ? `${selectedCount === 0 ? 'No new wildfire discoveries were reported' : `${selectedCount} new wildfire ${selectedCount === 1 ? 'discovery was' : 'discoveries were'} reported`} in this cell. ${cellsWithReports} of ${cellCount} grid cells had at least one report.`
    : '';
}

async function runForecast() {
  const version = ++requestVersion;
  showError();
  setBusy(true);
  try {
    const photoDate = fields['photo-date'].value;
    if (!photoDate) throw new Error('Enter the date the photo was taken.');
    const targetDate = dateOffset(photoDate, 1);
    const year = targetDate.slice(0, 4);
    if (!years.has(year)) throw new Error('Choose a photo date from 31 December 2022 to 30 December 2024.');
    const selectedCell = cellFor(fields.latitude.valueAsNumber, fields.longitude.valueAsNumber);
    const day = (await replayForYear(year))[targetDate];
    if (version !== requestVersion) return;
    if (!day || day.p.length !== cellCount) throw new Error('No complete forecast is available for this date.');
    const ranking = day.p.map((probability, cell) => ({ probability, cell }));
    ranking.sort((a, b) => b.probability - a.probability || a.cell - b.cell);
    const ranks = new Array(cellCount);
    ranking.forEach(({ cell }, index) => { ranks[cell] = index + 1; });
    activeForecast = { day, selectedCell, targetDate, ranks, revealed: false };
    renderForecast();
  } catch (error) {
    if (version === requestVersion) {
      showError(error.message.startsWith('Could not load') || error instanceof TypeError
        ? 'The replay data could not be loaded. Serve the project folder and try again.'
        : error.message);
    }
  } finally {
    if (version === requestVersion) setBusy(false);
  }
}

fields['forecast-form'].addEventListener('submit', event => {
  event.preventDefault();
  runForecast();
});

for (const id of ['photo-date', 'latitude', 'longitude']) {
  fields[id].addEventListener('input', invalidateForecast);
}

fields['demo-picker'].addEventListener('change', () => {
  const sample = photoSamples.get(fields['demo-picker'].value);
  if (sample) {
    selectSample(sample);
    runForecast();
  }
});

fields['file-input'].addEventListener('change', () => {
  const file = fields['file-input'].files[0];
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    showError('Choose an image file.');
    return;
  }
  const hadSample = photoSamples.has(fields['demo-picker'].value);
  invalidateForecast();
  if (hadSample) {
    for (const id of ['photo-date', 'latitude', 'longitude']) fields[id].value = '';
  }
  fields['demo-picker'].value = '';
  setPhoto(URL.createObjectURL(file), {
    alt: `Uploaded photo: ${file.name}`,
    credit: 'Photo preview stays on this device',
    uploaded: true,
  });
  fields['photo-date'].focus();
});

fields['reveal-button'].addEventListener('click', () => {
  if (!activeForecast) return;
  activeForecast.revealed = !activeForecast.revealed;
  renderForecast();
});

fields['forecast-grid'].addEventListener('click', event => {
  const tile = event.target.closest('.map-cell');
  if (!tile || !activeForecast) return;
  activeForecast.selectedCell = Number(tile.dataset.cell);
  renderForecast();
});

fields['forecast-grid'].addEventListener('keydown', event => {
  if (!activeForecast) return;
  const current = activeForecast.selectedCell;
  const moves = { ArrowUp: grid.columns, ArrowDown: -grid.columns, ArrowLeft: -1, ArrowRight: 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  const column = current % grid.columns;
  if ((event.key === 'ArrowLeft' && column === 0) || (event.key === 'ArrowRight' && column === grid.columns - 1)) return;
  const next = current + moves[event.key];
  if (next < 0 || next >= cellCount) return;
  activeForecast.selectedCell = next;
  renderForecast();
  fields['forecast-grid'].querySelector(`[data-cell="${next}"]`).focus();
});

async function start() {
  showError();
  paintMap();
  if (fields['dataset-summary']) {
    loadJson('data/metrics.json').then(metrics => {
      const percent = count => `${(count / metrics.positives * 100).toFixed(1)}%`;
      fields['dataset-summary'].textContent = `Across ${metrics.testDays} held-out days, the ten highest-risk cells captured ${metrics.weatherTopTen} of ${metrics.positives.toLocaleString('en-GB')} cell-days with reports (${percent(metrics.weatherTopTen)}). Location and month alone captured ${metrics.baselineTopTen} (${percent(metrics.baselineTopTen)}).`;
    }).catch(() => {});
  }

  try {
    const samples = await loadJson('data/photos.json');
    for (const sample of samples) {
      photoSamples.set(sample.id, sample);
      fields['demo-picker'].append(new Option(sample.label, sample.id));
    }
    if (samples.length && requestVersion === 0 && photoVersion === 0) {
      fields['demo-picker'].value = samples[0].id;
      selectSample(samples[0]);
      await runForecast();
    }
  } catch {
    if (!photoVersion && !requestVersion) showError('The sample photos could not be loaded. You can still enter a location and date.');
  }
}

start();
