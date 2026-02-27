const CONFIG = {
    headerRow: 5,
    currencyFilter: 'EUR',
    columns: {
        invoiceNum: 'Számla száma',
        issueDate: 'Számla kelte',
        performanceDate: 'Teljesítés dátuma',
        currency: 'Számla pénzneme',
        eurAmount: 'Számla nettó összege a számla pénznemében',
        hufAmount: 'Számla nettó összege forintban',
        eurRate: 'Alkalmazott árfolyam'
    },
    columnIndexes: { invoiceNum:-1, issueDate:-1, performanceDate:-1, currency:-1, eurAmount:-1, hufAmount:-1, eurRate:-1 },
    ratePolicy: 'performance',
    searchDays: 30
};

let dataTable = null;
let processedData = [];
let rawExcelData = null;
let selectedFile = null;

const uploadArea = document.getElementById('uploadArea');
const fileInput  = document.getElementById('fileInput');
const tableBody  = document.getElementById('tableBody');

function loadConfig() {
    CONFIG.columns.invoiceNum     = document.getElementById('configInvoiceNum').value;
    CONFIG.columns.issueDate      = document.getElementById('configDate').value;
    CONFIG.columns.performanceDate= document.getElementById('configPerformanceDate').value;
    CONFIG.columns.currency       = document.getElementById('configCurrency').value;
    CONFIG.columns.eurAmount      = document.getElementById('configEurAmount').value;
    CONFIG.columns.hufAmount      = document.getElementById('configHufAmount').value;
    CONFIG.columns.eurRate        = document.getElementById('configEurRate').value;
    CONFIG.headerRow = parseInt(document.getElementById('configHeaderRow').value) - 1;
    const sel = document.querySelector('input[name="ratePolicy"]:checked');
    if (sel) {
        CONFIG.ratePolicy = sel.value;
        const desc = {
            performance: 'Teljesítés dátuma szerint (ÁFA törvény)',
            issue: 'Kiállítás dátuma szerint (kivételes esetek)',
            auto: 'Automatikus összehasonlítás'
        };
        document.getElementById('policyDescription').innerText = desc[sel.value] || '';
    }
}

function findColumnIndexes(headerRow) {
    const indexes = {};
    for (const [key, columnName] of Object.entries(CONFIG.columns)) {
        indexes[key] = headerRow.findIndex(cell =>
            cell != null && cell.toString().trim().toLowerCase() === columnName.toString().trim().toLowerCase()
        );
    }
    return indexes;
}

function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const cleaned = value.replace(/[^\d.,\-]/g,'').replace(',','.').replace(/\.(?=.*\.)/g,'');
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
    }
    return null;
}

function formatDateForDisplay(v) {
    if (!v) return '-';
    if (typeof v === 'number') return new Date((v - 25569) * 86400000).toLocaleDateString('hu-HU');
    return v.toString();
}

function areDatesEqual(d1, d2) {
    return !!d1 && !!d2 && formatDate(d1) === formatDate(d2);
}

// ─── Enhanced matching ───────────────────────────────────────────────────────
// Checks: exact on performance date → exact on issue date → ±30-day window from both.
// Returns null if no match found within 30 days.
function findBestRateMatch(invoiceRate, issueDateStr, perfDateStr) {
    if (!invoiceRate) return null;
    const TOL = 0.01;

    const datesToCheck = [];
    if (perfDateStr) datesToCheck.push([perfDateStr, 'teljesítés']);
    if (issueDateStr && issueDateStr !== perfDateStr) datesToCheck.push([issueDateStr, 'kiállítás']);
    if (!datesToCheck.length && issueDateStr) datesToCheck.push([issueDateStr, 'kiállítás']);

    // 1. Exact match
    for (const [date, type] of datesToCheck) {
        const r = getMnbRate(date, RATE_TYPE.CURRENT_DAY);
        if (r && r.rate !== null && Math.abs(r.rate - invoiceRate) < TOL) {
            return { matchType:'exact', anchorType:type, anchorDate:date,
                     sourceDate:r.appliedDate, sourceRate:r.rate, dayOffset:0, generated:r.generated };
        }
    }

    // 2. ±30-day window from both anchor dates
    const candidates = [];
    for (const [date, type] of datesToCheck) {
        const results = findRateInWindow(date, invoiceRate, 30);
        if (results) results.forEach(r => candidates.push({ ...r, anchorType:type, anchorDate:date }));
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => a.dayDiff - b.dayDiff || (a.anchorType === 'teljesítés' ? -1 : 1));
    const best = candidates[0];
    return {
        matchType: 'window',
        anchorType: best.anchorType,
        anchorDate: best.anchorDate,
        sourceDate: best.date,
        sourceRate: best.rate,
        dayOffset: best.direction === 'backward' ? -best.dayDiff : best.dayDiff,
        generated: best.generated
    };
}

// ─── Data processing ─────────────────────────────────────────────────────────
function processExcelData(data, headerRowIndex) {
    if (!data || data.length <= headerRowIndex) return [];

    CONFIG.columnIndexes = findColumnIndexes(data[headerRowIndex]);
    const ci = CONFIG.columnIndexes;
    const processed = [];

    for (let i = headerRowIndex + 1; i < data.length; i++) {
        const row = data[i];
        if (!row || row.every(c => c === undefined || c === null || c === '')) continue;

        // Currency filter (EUR only)
        if (ci.currency !== -1) {
            const cur = row[ci.currency];
            if (!cur || cur.toString().trim().toUpperCase() !== 'EUR') continue;
        }

        const excelEurRate = ci.eurRate !== -1 ? parseNumber(row[ci.eurRate]) : null;
        if (excelEurRate === null || excelEurRate === undefined) continue;

        const invoiceNum       = ci.invoiceNum !== -1 ? (row[ci.invoiceNum] || '') : '';
        const issueDateValue   = ci.issueDate !== -1  ? row[ci.issueDate]         : null;
        const perfDateValue    = ci.performanceDate !== -1 ? row[ci.performanceDate] : null;
        const eurAmount        = ci.eurAmount !== -1  ? parseNumber(row[ci.eurAmount]) : null;
        const hufAmount        = ci.hufAmount !== -1  ? parseNumber(row[ci.hufAmount]) : null;

        const issueDateStr = formatDate(issueDateValue);
        if (!issueDateStr || eurAmount === null) continue;

        const perfDateStr = formatDate(perfDateValue) || issueDateStr;

        // Always fetch MNB rates for both reference dates (display columns)
        const mnbPerfResult  = getMnbRate(perfDateStr, RATE_TYPE.CURRENT_DAY);
        const mnbIssueResult = (issueDateStr !== perfDateStr)
            ? getMnbRate(issueDateStr, RATE_TYPE.CURRENT_DAY)
            : mnbPerfResult;
        const mnbPerfRate  = mnbPerfResult  ? mnbPerfResult.rate  : null;
        const mnbIssueRate = mnbIssueResult ? mnbIssueResult.rate : null;

        // Enhanced 3-phase matching
        const bestMatch       = findBestRateMatch(excelEurRate, issueDateStr, perfDateStr !== issueDateStr ? perfDateStr : null);
        const matchingRate    = bestMatch ? bestMatch.sourceRate  : null;
        const matchingDate    = bestMatch ? bestMatch.sourceDate  : null;
        const matchingGenerated = bestMatch ? bestMatch.generated : false;
        const dayDifference   = bestMatch ? bestMatch.dayOffset   : null;

        const calculatedHuf = (eurAmount && matchingRate) ? Math.round(eurAmount * matchingRate) : null;

        let difference = null, differencePercent = null, diffClass = '';
        if (hufAmount !== null && calculatedHuf !== null) {
            difference = hufAmount - calculatedHuf;
            differencePercent = calculatedHuf !== 0 ? (difference / calculatedHuf * 100) : 0;
            diffClass = Math.abs(difference) < 0.5 ? 'difference-zero'
                       : difference > 0             ? 'difference-positive'
                       :                              'difference-negative';
        }

        processed.push({
            invoiceNum,
            issueDate: issueDateValue,
            issueDateDisplay: formatDateForDisplay(issueDateValue),
            performanceDate: perfDateValue,
            performanceDateDisplay: perfDateValue ? formatDateForDisplay(perfDateValue) : '-',
            eurAmount, hufAmount, excelEurRate,
            mnbPerfRate, mnbIssueRate,
            bestMatch, matchingRate, matchingDate, matchingGenerated, dayDifference,
            calculatedHuf, difference, differencePercent, diffClass
        });
    }
    return processed;
}

// ─── Audit Dashboard ──────────────────────────────────────────────────────────
function renderDashboard(data) {
    const el = document.getElementById('auditDashboard');
    if (!el) return;

    const total      = data.length;
    const exactPerf  = data.filter(r => r.bestMatch?.matchType === 'exact' && r.bestMatch?.anchorType === 'teljesítés').length;
    const exactIssue = data.filter(r => r.bestMatch?.matchType === 'exact' && r.bestMatch?.anchorType === 'kiállítás').length;
    const window30   = data.filter(r => r.bestMatch?.matchType === 'window').length;
    const noMatch    = data.filter(r => !r.bestMatch).length;
    const overchg    = data.filter(r => r.difference !== null && r.difference >  1).length;
    const underchg   = data.filter(r => r.difference !== null && r.difference < -1).length;

    const statCard = (val, label, bg, textClass = '') => `
        <div class="col">
            <div class="text-center p-3 rounded-3 h-100 d-flex flex-column justify-content-center" style="background:${bg}">
                <div class="fs-2 fw-bold ${textClass}">${val}</div>
                <div class="small mt-1 text-dark fw-medium">${label}</div>
            </div>
        </div>`;

    const discAlert = (overchg + underchg) > 0
        ? `<div class="alert alert-warning mb-0 mt-3 py-2 px-3 d-flex align-items-center gap-3">
               <i class="fas fa-exclamation-triangle fa-lg text-warning"></i>
               <span><strong>${overchg + underchg} számlán árfolyam-eltérés:</strong>
               <span class="ms-3 text-danger fw-bold">▲ ${overchg} túlszámlázott</span>
               <span class="ms-3 text-success fw-bold">▼ ${underchg} alulszámlázott</span></span>
           </div>`
        : `<div class="alert alert-success mb-0 mt-3 py-2 px-3">
               <i class="fas fa-check-circle me-2"></i>Nem található HUF-eltérés az árfolyamokon.
           </div>`;

    el.style.display = '';
    el.innerHTML = `
        <div class="col-12">
            <div class="card shadow-sm border-0">
                <div class="card-body">
                    <h5 class="card-title mb-3">
                        <i class="fas fa-search-dollar me-2 text-primary"></i>Ellenőrzési összefoglaló
                    </h5>
                    <div class="row g-3">
                        ${statCard(total,      'Összes EUR számla',            '#e9ecef')}
                        ${statCard(exactPerf,  'Egyezés:<br>teljesítés napja', '#d1e7dd', 'text-success')}
                        ${statCard(exactIssue, 'Egyezés:<br>kiállítás napja',  '#cff4fc', 'text-info')}
                        ${statCard(window30,   'Közelítő egyezés<br>(±30 nap)','#fff3cd', 'text-warning')}
                        ${statCard(noMatch,    'Nincs egyezés',                '#f8d7da', 'text-danger')}
                    </div>
                    ${discAlert}
                    <div class="mt-2 small text-muted">
                        <i class="fas fa-info-circle me-1"></i>
                        <strong>Legjobb forrásárfolyam</strong> meghatározása: 1. teljesítés napja → 2. kiállítás napja → 3. ±30 napos keresés mindkét dátumtól.
                    </div>
                </div>
            </div>
        </div>`;
}

// ─── Table rendering ──────────────────────────────────────────────────────────
function renderTable(data) {
    tableBody.innerHTML = '';

    if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="14" class="text-center">Nincs megjeleníthető adat</td></tr>';
        return;
    }

    renderDashboard(data);

    let positiveDiff = 0, negativeDiff = 0, generatedCount = 0;
    let matchPerfExact = 0, matchIssueExact = 0, matchWindow = 0, matchNone = 0;

    const fmt    = (n, d=0) => n == null ? '-' : new Intl.NumberFormat('hu-HU', {minimumFractionDigits:d, maximumFractionDigits:d}).format(n);
    const fmtPct = n => n == null ? '-' : new Intl.NumberFormat('hu-HU', {minimumFractionDigits:2, maximumFractionDigits:2}).format(n) + '%';

    data.forEach(row => {
        const tr = document.createElement('tr');
        if (row.diffClass) tr.className = row.diffClass;
        if (row.matchingGenerated) { tr.classList.add('generated-rate'); generatedCount++; }

        const bm = row.bestMatch;
        let matchBadge = '';
        let discrepancyClass = '';

        if (!bm) {
            matchBadge = '<span class="badge bg-danger">Nincs egyezés</span>';
            matchNone++;
        } else if (bm.matchType === 'exact' && bm.anchorType === 'teljesítés') {
            matchBadge = `<span class="badge bg-success"><i class="fas fa-check me-1"></i>Teljesítés napja</span>`;
            matchPerfExact++;
        } else if (bm.matchType === 'exact' && bm.anchorType === 'kiállítás') {
            matchBadge = `<span class="badge bg-info"><i class="fas fa-check me-1"></i>Kiállítás napja</span>`;
            matchIssueExact++;
        } else {
            const sign = bm.dayOffset > 0 ? '+' : '';
            matchBadge = `<span class="badge bg-warning text-dark"><i class="fas fa-search me-1"></i>${sign}${bm.dayOffset}n (${bm.anchorType})</span>`;
            matchWindow++;
        }

        if (row.difference !== null) {
            if (row.difference >  1) positiveDiff++;
            if (row.difference < -1) negativeDiff++;
        }

        // Source date cell: show date + day offset hint
        let srcDateHtml = '-';
        if (row.matchingDate) {
            const offsetHtml = (row.dayDifference !== null && row.dayDifference !== 0)
                ? ` <small class="text-muted">(${row.dayDifference > 0 ? '+' : ''}${row.dayDifference}n)</small>`
                : '';
            srcDateHtml = row.matchingDate + offsetHtml;
        }

        // Matching rate cell: bold, mark generated with asterisk
        const matchRateHtml = row.matchingRate
            ? `<strong>${fmt(row.matchingRate, 2)}</strong>${row.matchingGenerated ? '<sup class="text-danger ms-1" title="Hétvégi generált árfolyam">*</sup>' : ''}`
            : '<span class="text-danger">—</span>';

        // Invoice rate: highlight if differs from best match
        const rateDeviation = (row.matchingRate && row.excelEurRate)
            ? Math.abs(row.excelEurRate - row.matchingRate)
            : null;
        const invoiceRateClass = (rateDeviation !== null && rateDeviation >= 0.01) ? 'text-danger' : '';

        tr.innerHTML = `
            <td>${row.invoiceNum || '-'}</td>
            <td class="text-center">${matchBadge}</td>
            <td>${row.issueDateDisplay}</td>
            <td>${row.performanceDateDisplay}</td>
            <td class="text-end">${fmt(row.eurAmount, 2)}</td>
            <td class="text-end">${fmt(row.hufAmount, 0)}</td>
            <td class="text-end fw-semibold ${invoiceRateClass}">${fmt(row.excelEurRate, 2)}</td>
            <td class="text-end text-muted">${fmt(row.mnbPerfRate, 2)}</td>
            <td class="text-end text-muted">${fmt(row.mnbIssueRate, 2)}</td>
            <td class="text-end">${matchRateHtml}</td>
            <td class="text-nowrap">${srcDateHtml}</td>
            <td class="text-end">${fmt(row.calculatedHuf, 0)}</td>
            <td class="text-end fw-semibold">${fmt(row.difference, 0)}</td>
            <td class="text-end">${fmtPct(row.differencePercent)}</td>`;

        tableBody.appendChild(tr);
    });

    // Summary info bar
    const existingInfo = document.querySelector('.generated-info');
    if (existingInfo) existingInfo.remove();

    const info = document.createElement('div');
    info.className = 'alert alert-secondary mt-2 py-2 generated-info';
    info.innerHTML = `
        <div class="row text-center small">
            <div class="col fw-bold">Összes: ${data.length}</div>
            <div class="col text-success">✓ Teljesítés: ${matchPerfExact}</div>
            <div class="col text-info">✓ Kiállítás: ${matchIssueExact}</div>
            <div class="col text-warning">~ ±30 nap: ${matchWindow}</div>
            <div class="col text-danger">✗ Nincs: ${matchNone}</div>
            <div class="col">▲ ${positiveDiff} | ▼ ${negativeDiff} eltérés</div>
        </div>`;

    const tc = document.querySelector('.table-container');
    if (tc) tc.insertBefore(info, tc.firstChild);

    if (dataTable) dataTable.destroy();
    dataTable = $('#dataTable').DataTable({
        language: { url: 'https://cdn.datatables.net/plug-ins/1.13.6/i18n/hu.json' },
        dom: 'Bfrtip',
        buttons: [
            { extend: 'csv',       text: 'CSV letöltés',   className: 'btn btn-secondary', bom: true },
            { extend: 'excelHtml5',text: 'Excel letöltés', className: 'btn btn-success',
              title: 'Adattábla exportálása', exportOptions: { columns: ':visible' } }
        ],
        pageLength: 25,
        order: [[13, 'desc']],
        columnDefs: [
            { type: 'num',     targets: [4,5,6,7,8,11,12] },
            { type: 'num-fmt', targets: [13] },
            { type: 'string',  targets: [0,1,2,3,9,10] }
        ],
        destroy: true,
        retrieve: true,
        scrollX: true,
        responsive: false
    });
}

// ─── Event handlers ───────────────────────────────────────────────────────────
document.querySelectorAll('input[name="ratePolicy"]').forEach(radio => {
    radio.addEventListener('change', () => {
        loadConfig();
        if (rawExcelData) {
            processedData = processExcelData(rawExcelData, CONFIG.headerRow);
            if (processedData.length > 0) renderTable(processedData);
        }
    });
});

uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.style.borderColor = '#0d6efd';
    uploadArea.style.backgroundColor = '#e9ecef';
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = '#dee2e6';
    uploadArea.style.backgroundColor = '#f8f9fa';
});

uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.style.borderColor = '#dee2e6';
    uploadArea.style.backgroundColor = '#f8f9fa';
    const files = e.dataTransfer.files;
    if (files.length > 0) { loadConfig(); processExcel(files[0]); }
});

const btnProcess = document.getElementById('btn-process');

fileInput.addEventListener('change', e => {
    if (e.target.files.length > 0) {
        selectedFile = e.target.files[0];
        btnProcess.disabled = false;
    }
});

btnProcess.addEventListener('click', () => {
    if (selectedFile) { loadConfig(); processExcel(selectedFile); }
    else alert('Kérlek, előbb válassz ki egy fájlt!');
});

function processExcel(file) {
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            rawExcelData = jsonData;
            processedData = processExcelData(jsonData, CONFIG.headerRow);
            if (processedData.length > 0) renderTable(processedData);
            else alert('Nincs feldolgozható adat az Excel fájlban!');
        } catch (err) {
            console.error(err);
            alert('Hiba: ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

document.getElementById('availableRatesCount').textContent = MNB_RATES.data.length;
const ts = MNB_RATES.ts;
document.getElementById('updateMNB').textContent =
    `${ts.slice(0,4)}.${ts.slice(4,6)}.${ts.slice(6,8)}. ${ts.slice(8,10)}:${ts.slice(10,12)}`;

loadConfig();
console.log('App inicializálva');
