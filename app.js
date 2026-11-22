const fields = Object.fromEntries([
  'file-input', 'preview-image', 'preview-placeholder', 'photo-credit',
  'forecast-form', 'photo-date', 'latitude', 'longitude', 'photo-metadata-status',
  'run-button', 'form-error', 'result', 'result-date', 'risk-number', 'risk-rank',
  'weather-through', 'weather-values', 'forecast-grid', 'reveal-button',
  'observation', 'observation-text', 'map-selected-label', 'risk-gauge', 'dataset-summary',
  'model-select', 'shortlist', 'capture-summary', 'model-metrics',
  'calibration-figure', 'calibration-image',
  'present-button', 'benchmark-summary', 'benchmark-system', 'benchmark-verification',
  'benchmark-reference', 'benchmark-batched', 'benchmark-parallel', 'benchmark-parallel-row',
  'benchmark-cuda', 'benchmark-file', 'benchmark-file-status',
  'browse-photos', 'photo-library-dialog', 'photo-library-close', 'photo-library-search',
  'photo-library-count', 'photo-library-grid', 'photo-library-more',
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
const sampleButtons = [...document.querySelectorAll('[data-sample]')];
const libraryPageSize = 24;
const resourcePrefix = document.querySelector('meta[name="resource-prefix"]')?.content ?? '';
let photoObjectUrl;
let photoVersion = 0;
let requestVersion = 0;
let activeForecast;
let typicalWeather;
let libraryRequest;
let libraryPhotos;
let shownLibraryPhotos = libraryPageSize;
let showingImportedBenchmark = false;

async function loadJson(path) {
  const response = await fetch(`${resourcePrefix}${path}`);
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
  document.body.classList.remove('has-forecast');
  setBusy(false);
  fields.result.hidden = true;
  fields['observation'].hidden = true;
  fields['observation-text'].textContent = '';
  fields['capture-summary'].textContent = '';
  showError();
}

function setPhoto(url, { alt, credit, source, fallback, uploaded = false }) {
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
    if (fallback && preview.getAttribute('src') !== fallback) {
      preview.src = fallback;
      return;
    }
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
  const bundled = photoSamples.has(sample.id);
  setPhoto(bundled ? `${resourcePrefix}assets/${image}.jpg` : sample.url, {
    alt: `${sample.site ?? 'Tonzi Ranch'} landscape from ${formatDate(sample.photoDate)}`,
    credit: sample.credit,
    source: sample.source,
    fallback: sample.thumbnail,
  });
  fields['photo-metadata-status'].textContent = '';
}

function paintPhotoLibrary() {
  const terms = fields['photo-library-search'].value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = libraryPhotos.filter(photo => {
    const searchable = `${photo.site} ${photo.photoDate} ${formatDate(photo.photoDate)}`.toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const visible = matches.slice(0, shownLibraryPhotos);
  const fragment = document.createDocumentFragment();
  for (const photo of visible) {
    const button = document.createElement('button');
    const image = document.createElement('img');
    const site = document.createElement('strong');
    const date = document.createElement('span');
    button.type = 'button';
    button.className = 'library-photo';
    button.dataset.photoId = photo.id;
    image.src = photo.thumbnail;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    site.textContent = photo.site;
    date.textContent = formatDate(photo.photoDate);
    button.append(image, site, date);
    fragment.append(button);
  }
  fields['photo-library-grid'].replaceChildren(fragment);
  fields['photo-library-count'].textContent = matches.length
    ? `Showing ${visible.length} of ${matches.length} photos`
    : 'No photos match that search.';
  fields['photo-library-more'].hidden = visible.length === matches.length;
}

async function openPhotoLibrary() {
  fields['photo-library-dialog'].showModal();
  fields['photo-library-search'].focus();
  if (libraryPhotos) return;
  fields['photo-library-count'].textContent = 'Loading archive photos…';
  try {
    libraryRequest ??= loadJson('data/photo-library.json');
    libraryPhotos = await libraryRequest;
    paintPhotoLibrary();
  } catch {
    libraryRequest = undefined;
    fields['photo-library-count'].textContent = 'Could not load the archive. Close it and try again.';
  }
}

function captureDateFromExif(value) {
  if (typeof value === 'string') return value.match(/^\d{4}[:\-]\d{2}[:\-]\d{2}/)?.[0].replaceAll(':', '-');
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return undefined;
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
}

async function readPhotoDetails(file) {
  const version = photoVersion;
  const exif = window.exifr;
  if (exif) {
    const [location, info] = await Promise.allSettled([
      exif.gps(file), exif.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false }),
    ]);
    if (version !== photoVersion) return;
    const date = captureDateFromExif(info.value?.DateTimeOriginal ?? info.value?.CreateDate);
    if (date && !fields['photo-date'].value) fields['photo-date'].value = date;
    if (!fields.latitude.value && Number.isFinite(location.value?.latitude)) fields.latitude.value = location.value.latitude;
    if (!fields.longitude.value && Number.isFinite(location.value?.longitude)) fields.longitude.value = location.value.longitude;
  }
  const form = fields['forecast-form'];
  const details = ['photo-date', 'latitude', 'longitude'];
  const missing = details.find(id => !fields[id].value || !fields[id].validity.valid);
  if (missing) {
    fields['photo-metadata-status'].textContent = 'Confirm the photo’s date and location to run the historical prediction.';
    fields[missing].focus();
    return;
  }
  if (form.checkValidity()) {
    fields['photo-metadata-status'].textContent = 'Date and location are ready. You can adjust either before predicting again.';
    await runForecast();
  }
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
  const { day, scores, ranks, selectedCell, revealed } = activeForecast;
  for (const tile of fields['forecast-grid'].children) {
    const cell = Number(tile.dataset.cell);
    const risk = scores[cell];
    const selected = cell === selectedCell;
    const reported = revealed && day.n[cell] > 0;
    tile.title = `${describeCell(cell)} · ${formatRisk(risk)} estimated risk${revealed ? ` · ${day.n[cell]} reports` : ''}`;
    tile.setAttribute('aria-label', tile.title);
    tile.setAttribute('aria-pressed', String(selected));
    tile.classList.toggle('selected', selected);
    tile.classList.toggle('top-ten', ranks[cell] <= 10);
    tile.classList.toggle('reported', reported);
    tile.style.setProperty('--heat', String(risk));
    tile.style.setProperty('--cell-color', heatColor(risk));
    tile.tabIndex = selected ? 0 : -1;
  }
}

function renderWeather(row, normals) {
  const columns = [
    ['Max temperature', '°C'],
    ['Min humidity', '%'],
    ['Mean wind', ' m/s'],
    ['Rain', ' mm'],
  ];
  fields['weather-values'].replaceChildren(...columns.map(([label, unit], index) => {
    const pair = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = `${weatherFormat.format(row[index])}${unit}`;
    pair.append(term, definition);
    if (normals) {
      const usual = document.createElement('small');
      usual.className = 'typical';
      usual.textContent = `Typical ${weatherFormat.format(normals[index])}${unit}`;
      definition.append(' ', usual);
    }
    return pair;
  }));
}

function paintShortlist() {
  const { order, scores } = activeForecast;
  const items = order.slice(0, 10).map((cell, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const rank = document.createElement('span');
    const location = document.createElement('span');
    const risk = document.createElement('strong');
    button.type = 'button';
    button.className = 'shortlist-cell';
    button.dataset.cell = cell;
    rank.className = 'shortlist-rank';
    rank.textContent = index + 1;
    location.className = 'shortlist-location';
    location.textContent = describeCell(cell);
    risk.className = 'shortlist-risk';
    risk.textContent = formatRisk(scores[cell]);
    button.append(rank, location, risk);
    item.append(button);
    return item;
  });
  fields.shortlist.replaceChildren(...items);
}

function applyModel() {
  const { day } = activeForecast;
  const scores = fields['model-select'].value === 'seasonal' ? day.b : day.p;
  const order = scores.map((_, cell) => cell);
  order.sort((a, b) => scores[b] - scores[a] || a - b);
  const ranks = new Array(cellCount);
  order.forEach((cell, index) => { ranks[cell] = index + 1; });
  Object.assign(activeForecast, { scores, order, ranks });
  paintShortlist();
}

function renderForecast() {
  const { day, scores, order, selectedCell, targetDate, ranks, revealed } = activeForecast;
  const probability = scores[selectedCell];
  const selectedCount = day.n[selectedCell];
  const cellsWithReports = day.n.filter(count => count > 0).length;
  const weatherThrough = dateOffset(targetDate, -2);
  fields.result.hidden = false;
  document.body.classList.add('has-forecast');
  fields['result-date'].textContent = formatDate(targetDate);
  fields['risk-number'].textContent = formatRisk(probability);
  fields['risk-rank'].textContent = `Rank ${ranks[selectedCell]} of ${cellCount} cells`;
  fields['weather-through'].textContent = formatDate(weatherThrough);
  if (fields['map-selected-label']) fields['map-selected-label'].textContent = describeCell(selectedCell);
  fields['risk-gauge']?.style.setProperty('--progress', `${probability * 100}%`);
  const monthIndex = Number(weatherThrough.slice(5, 7)) - 1;
  renderWeather(day.w[selectedCell], typicalWeather?.months[monthIndex]?.[selectedCell]);
  refreshMap();
  for (const button of fields.shortlist.querySelectorAll('.shortlist-cell')) {
    const selected = Number(button.dataset.cell) === selectedCell;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('selected', selected);
  }

  fields['reveal-button'].disabled = false;
  fields['reveal-button'].textContent = revealed ? 'Hide recorded outcome' : 'Reveal recorded outcome';
  fields['reveal-button'].setAttribute('aria-expanded', String(revealed));
  fields.observation.hidden = !revealed;
  fields['observation-text'].textContent = revealed
    ? `${selectedCount === 0 ? 'No new wildfire discoveries were reported' : `${selectedCount} new wildfire ${selectedCount === 1 ? 'discovery was' : 'discoveries were'} reported`} in this cell. ${cellsWithReports} of ${cellCount} grid cells had at least one report.`
    : '';
  if (revealed) {
    const captured = order.slice(0, 10).filter(cell => day.n[cell] > 0).length;
    fields['capture-summary'].textContent = `${captured} of ${cellsWithReports} reporting cells in the top ten · ${cellsWithReports - captured} outside it`;
  } else {
    fields['capture-summary'].textContent = '';
  }
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
    if (!day || day.p.length !== cellCount || day.b?.length !== cellCount) {
      throw new Error('No complete forecast is available for this date.');
    }
    activeForecast = { day, selectedCell, targetDate, revealed: false };
    applyModel();
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

fields['browse-photos'].addEventListener('click', openPhotoLibrary);
fields['photo-library-close'].addEventListener('click', () => fields['photo-library-dialog'].close());
fields['photo-library-search'].addEventListener('input', () => {
  if (!libraryPhotos) return;
  shownLibraryPhotos = libraryPageSize;
  paintPhotoLibrary();
});
fields['photo-library-more'].addEventListener('click', () => {
  shownLibraryPhotos += libraryPageSize;
  paintPhotoLibrary();
});
fields['photo-library-grid'].addEventListener('click', event => {
  const card = event.target.closest('.library-photo');
  if (!card || !libraryPhotos) return;
  const photo = libraryPhotos.find(item => item.id === card.dataset.photoId);
  if (!photo) return;
  fields['photo-library-dialog'].close();
  selectSample(photo);
  runForecast();
});

for (const button of sampleButtons) {
  button.disabled = true;
  button.addEventListener('click', () => {
    const sample = photoSamples.get(button.dataset.sample);
    if (!sample) return;
    fields['model-select'].value = 'weather';
    selectSample(sample);
    runForecast();
  });
}

fields['file-input'].addEventListener('change', () => {
  const file = fields['file-input'].files[0];
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    showError('Choose an image file.');
    return;
  }
  invalidateForecast();
  for (const id of ['photo-date', 'latitude', 'longitude']) fields[id].value = '';
  setPhoto(URL.createObjectURL(file), {
    alt: `Uploaded photo: ${file.name}`,
    credit: 'Photo preview stays on this device',
    uploaded: true,
  });
  fields['photo-metadata-status'].textContent = 'Reading photo details…';
  readPhotoDetails(file);
});

fields['reveal-button'].addEventListener('click', () => {
  if (!activeForecast) return;
  activeForecast.revealed = !activeForecast.revealed;
  renderForecast();
});

fields['model-select'].addEventListener('change', () => {
  if (!activeForecast) return;
  applyModel();
  renderForecast();
});

fields.shortlist.addEventListener('click', event => {
  const button = event.target.closest('.shortlist-cell');
  if (!button || !activeForecast) return;
  activeForecast.selectedCell = Number(button.dataset.cell);
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

function setPresentation(enabled) {
  document.body.classList.toggle('presentation-mode', enabled);
  fields['present-button'].textContent = enabled ? 'Exit presentation' : 'Present';
  fields['present-button'].setAttribute('aria-pressed', String(enabled));
}

fields['present-button'].addEventListener('click', () => {
  setPresentation(!document.body.classList.contains('presentation-mode'));
});

document.addEventListener('keydown', event => {
  if (!document.body.classList.contains('presentation-mode') || event.altKey || event.ctrlKey || event.metaKey) return;
  if (fields['photo-library-dialog'].open) return;
  if (event.key === 'Escape') {
    setPresentation(false);
    fields['present-button'].focus();
    return;
  }
  if (event.target.closest?.('input, select, textarea, [contenteditable]')) return;
  switch (event.key.toLowerCase()) {
    case '1': sampleButtons[0]?.click(); break;
    case '2': sampleButtons[1]?.click(); break;
    case 'r': fields['reveal-button'].click(); break;
    default: return;
  }
  event.preventDefault();
});

function renderEvaluation(metrics) {
  const percent = count => `${(count / metrics.positives * 100).toFixed(1)}%`;
  fields['dataset-summary'].textContent = `The same ${metrics.testDays} days in 2023–24 contain ${metrics.positives.toLocaleString('en-GB')} cell-days with reports.`;
  const models = [
    { name: 'Location and month', topTen: metrics.baselineTopTen, averagePrecision: metrics.baselineAveragePrecision, brierScore: metrics.baselineBrierScore },
    { name: 'Weather analogue', topTen: metrics.weatherTopTen, averagePrecision: metrics.weatherAveragePrecision, brierScore: metrics.weatherBrierScore },
  ];
  if (metrics.challenger) models.push(metrics.challenger);
  fields['model-metrics'].replaceChildren(...models.map(model => {
    const row = document.createElement('tr');
    const modelName = document.createElement('th');
    modelName.scope = 'row';
    modelName.textContent = model.name;
    row.append(modelName);
    for (const value of [model.topTen.toLocaleString('en-GB'), percent(model.topTen), model.averagePrecision.toFixed(4), model.brierScore.toFixed(4)]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  if (metrics.challenger) {
    const image = fields['calibration-image'];
    image.onload = () => { fields['calibration-figure'].hidden = false; };
    image.src = `${resourcePrefix}data/calibration.png`;
  }
}

function renderBenchmark(benchmark) {
  const seconds = value => `${value.toFixed(3)} s`;
  const relative = value => value >= 1
    ? `${value.toFixed(2)}× faster than direct CPU`
    : `${(1 / value).toFixed(2)}× the direct CPU time`;
  fields['benchmark-summary'].textContent = `The same ${benchmark.comparisons.toLocaleString('en-GB')} comparisons on ${benchmark.days} replay days. Times are medians of ${benchmark.repeats} measured runs after a warm-up.`;
  fields['benchmark-reference'].textContent = seconds(benchmark.referenceSeconds);
  fields['benchmark-batched'].textContent = `${seconds(benchmark.batchedSeconds)} · ${relative(benchmark.referenceSeconds / benchmark.batchedSeconds)}`;
  let agreement = benchmark.referenceTopTenAgreementDays;
  fields['benchmark-parallel-row'].hidden = !(benchmark.parallelSeconds > 0);
  if (benchmark.parallelSeconds > 0) {
    fields['benchmark-parallel'].textContent = `${seconds(benchmark.parallelSeconds)} · ${relative(benchmark.referenceSeconds / benchmark.parallelSeconds)}`;
    agreement = Math.min(agreement, benchmark.parallelTopTenAgreementDays);
  }
  fields['benchmark-verification'].textContent = `CPU methods agreed on the top ten on ${agreement} of ${benchmark.days} days. The largest probability difference was ${benchmark.maxAbsoluteError.toExponential(2)}.`;
  fields['benchmark-system'].textContent = `${benchmark.cpu} · ${benchmark.workers} CPU workers · ${benchmark.blasThreadsPerWorker} BLAS thread per worker`;
  if (benchmark.cuda) {
    fields['benchmark-cuda'].textContent = `${benchmark.cuda.device} · ${seconds(benchmark.cuda.kernelSeconds)} kernel · ${seconds(benchmark.cuda.transferInclusiveSeconds)} with transfers · ${benchmark.cuda.kernelSpeedup.toFixed(2)}× fastest CPU · ${benchmark.cuda.topTenAgreementDays} of ${benchmark.days} top-ten sets matched`;
  } else {
    fields['benchmark-cuda'].textContent = 'Measurement pending';
  }
}

function isBenchmarkReport(report) {
  if (!report || report.comparisons !== 127650144 || report.days !== 731 || typeof report.cpu !== 'string') return false;
  const positive = value => Number.isFinite(value) && value > 0;
  const validDays = value => Number.isInteger(value) && value >= 0 && value <= report.days;
  if (![report.referenceSeconds, report.batchedSeconds, report.repeats, report.workers, report.blasThreadsPerWorker].every(positive) ||
      !Number.isFinite(report.maxAbsoluteError) || report.maxAbsoluteError < 0 || !validDays(report.referenceTopTenAgreementDays)) return false;
  if (report.parallelSeconds !== undefined && (!positive(report.parallelSeconds) || !validDays(report.parallelTopTenAgreementDays))) return false;
  const cuda = report.cuda;
  return !cuda || (typeof cuda.device === 'string' && validDays(cuda.topTenAgreementDays) &&
    [cuda.kernelSeconds, cuda.transferInclusiveSeconds, cuda.kernelSpeedup].every(positive));
}

fields['benchmark-file'].addEventListener('change', async () => {
  const input = fields['benchmark-file'];
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error('The result file is too large.');
    const report = JSON.parse(await file.text());
    if (!isBenchmarkReport(report)) throw new Error('Use the JSON produced by the full wildfire benchmark.');
    showingImportedBenchmark = true;
    renderBenchmark(report);
    fields['benchmark-file-status'].textContent = 'Showing benchmark results from this file in your browser.';
  } catch (error) {
    fields['benchmark-file-status'].textContent = error instanceof SyntaxError ? 'Choose a valid benchmark JSON file.' : error.message;
  } finally {
    input.value = '';
  }
});

async function start() {
  showError();
  paintMap();
  loadJson('data/metrics.json').then(renderEvaluation).catch(() => {});
  loadJson('data/benchmark.json').then(report => {
    if (!showingImportedBenchmark) renderBenchmark(report);
  }).catch(() => {});
  loadJson('data/typical-weather.json').then(data => {
    typicalWeather = data;
    if (activeForecast) renderForecast();
  }).catch(() => {});

  try {
    const samples = await loadJson('data/photos.json');
    for (const sample of samples) {
      photoSamples.set(sample.id, sample);
    }
    for (const button of sampleButtons) {
      button.disabled = !photoSamples.has(button.dataset.sample);
    }
    if (samples.length && requestVersion === 0 && photoVersion === 0) {
      const firstDemo = photoSamples.get('tonzi-2023-07-04') ?? samples[0];
      selectSample(firstDemo);
      await runForecast();
    }
  } catch {
    if (!photoVersion && !requestVersion) showError('The sample photos could not be loaded. You can still enter a location and date.');
  }
}

start();
