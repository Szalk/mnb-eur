const CONFIG = {
    headerRow: 5,
    currencyFilter: 'EUR',
    columns: {
        invoiceNum:       'Számla száma',
        issueDate:        'Számla kelte',
        performanceDate:  'Teljesítés dátuma',
        currency:         'Számla pénzneme',
        eurAmount:        'Számla nettó összege a számla pénznemében',
        hufAmount:        'Számla nettó összege forintban',
        eurRate:          'Alkalmazott árfolyam',
        transactionType:  'Ügylettípus'
    },
    columnIndexes: {
        invoiceNum:-1, issueDate:-1, performanceDate:-1, currency:-1,
        eurAmount:-1, hufAmount:-1, eurRate:-1, transactionType:-1
    },
    searchDays: 30
};

let dataTable   = null;
let processedData  = [];
let rawExcelData   = null;
let selectedFile   = null;

const uploadArea = document.getElementById('uploadArea');
const fileInput  = document.getElementById('fileInput');
const tableBody  = document.getElementById('tableBody');

// ─── Transaction type constants ───────────────────────────────────────────────
const TRANSACTION_TYPES = {
    KB:        'kb',
    ELEG:      'eleg',
    FORDÍTOTT: 'fordított',
    IDOSZAKOS: 'idoszakos',
    EGYEB:     'egyeb'
};

function detectTransactionType(cellValue) {
    if (!cellValue) return TRANSACTION_TYPES.EGYEB;
    const v = cellValue.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (v.includes('kozosseg') || /\bkb\b/.test(v))                                   return TRANSACTION_TYPES.KB;
    if (v.includes('eloleg'))                                                           return TRANSACTION_TYPES.ELEG;
    if (v.includes('fordito'))                                                          return TRANSACTION_TYPES.FORDÍTOTT;
    if (v.includes('idoszak') || v.includes('folyamatos'))                              return TRANSACTION_TYPES.IDOSZAKOS;
    return TRANSACTION_TYPES.EGYEB;
}

// Returns { targetDate, ruleName, ruleDesc }
function resolveTargetDate(txType, issueDateStr, perfDateStr) {
    const eff = perfDateStr || issueDateStr;
    switch (txType) {
        case TRANSACTION_TYPES.KB:
            return { targetDate: issueDateStr, ruleName: 'Közösségen belüli termékbeszerzés', ruleDesc: 'kiállítás napja' };
        case TRANSACTION_TYPES.ELEG:
            return { targetDate: issueDateStr, ruleName: 'Előleg', ruleDesc: 'jóváírás/kézhezvétel napja' };
        case TRANSACTION_TYPES.FORDÍTOTT: {
            const fifteenth = dayjs(eff).add(1, 'month').date(15).format('YYYY-MM-DD');
            const target = issueDateStr < fifteenth ? issueDateStr : fifteenth;
            return { targetDate: target, ruleName: 'Fordított adózás', ruleDesc: 'kiállítás napja (legkorábbi elérhető)' };
        }
        case TRANSACTION_TYPES.IDOSZAKOS:
            return { targetDate: issueDateStr, ruleName: 'Időszakos elszámolás', ruleDesc: 'kiállítás napja' };
        default:
            return { targetDate: eff, ruleName: 'Egyéb eset', ruleDesc: 'teljesítés napja' };
    }
}

// ─── Core matching (dual-rate + tx-type routing) ──────────────────────────────
// Phase 1: exact on resolved target date (T + T-1).
// Phase 2: exact on secondary date (T + T-1).
// Phase 3: ±30-day window from both anchors.
// Legal category is determined by anchorType of the winning match:
//   anchorType='teljesítés' + exact  →  'helyes'
//   any other match found            →  'kérdéses'
//   no match                         →  'nincs'
function findBestRateMatch(invoiceRate, issueDateStr, perfDateStr, txType) {
    if (!invoiceRate) return null;
    const TOL = 0.01;

    const effectivePerfDate = perfDateStr || issueDateStr;
    const { targetDate, ruleName, ruleDesc } = resolveTargetDate(
        txType || TRANSACTION_TYPES.EGYEB, issueDateStr, effectivePerfDate
    );

    const targetAnchorType    = targetDate === effectivePerfDate ? 'teljesítés' : 'kiállítás';
    const secondaryDate       = (targetDate === effectivePerfDate && issueDateStr !== effectivePerfDate)
                                    ? issueDateStr
                                    : (targetDate !== effectivePerfDate ? effectivePerfDate : null);
    const secondaryAnchorType = secondaryDate === effectivePerfDate ? 'teljesítés' : 'kiállítás';

    // MNB dual-rate: both T and T-1 are valid per publication mechanics
    const checkDual = (dateStr, anchorType) => {
        if (!dateStr) return null;
        const rT = getMnbRate(dateStr, RATE_TYPE.CURRENT_DAY);
        if (rT && rT.rate !== null && Math.abs(rT.rate - invoiceRate) < TOL) {
            return { matchType:'exact', anchorType, anchorDate:dateStr,
                     sourceDate:rT.appliedDate, sourceRate:rT.rate,
                     dayOffset:0, generated:rT.generated,
                     rateVersion:'current', ruleName, ruleDesc, targetDate };
        }
        const rT1 = getMnbRate(dateStr, RATE_TYPE.PREVIOUS_DAY);
        if (rT1 && rT1.rate !== null && Math.abs(rT1.rate - invoiceRate) < TOL) {
            return { matchType:'exact', anchorType, anchorDate:dateStr,
                     sourceDate:rT1.appliedDate, sourceRate:rT1.rate,
                     dayOffset:0, generated:rT1.generated,
                     rateVersion:'previous', ruleName, ruleDesc, targetDate };
        }
        return null;
    };

    const m1 = checkDual(targetDate, targetAnchorType);
    if (m1) return m1;

    if (secondaryDate) {
        const m2 = checkDual(secondaryDate, secondaryAnchorType);
        if (m2) return m2;
    }

    const candidates = [];
    const windowDates = [[targetDate, targetAnchorType]];
    if (secondaryDate) windowDates.push([secondaryDate, secondaryAnchorType]);
    for (const [date, type] of windowDates) {
        const results = findRateInWindow(date, invoiceRate, 30);
        if (results) results.forEach(r => candidates.push({ ...r, anchorType:type, anchorDate:date }));
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => a.dayDiff - b.dayDiff || (a.anchorType === 'teljesítés' ? -1 : 1));
    const best = candidates[0];
    return {
        matchType:'window', anchorType:best.anchorType, anchorDate:best.anchorDate,
        sourceDate:best.date, sourceRate:best.rate,
        dayOffset: best.direction === 'backward' ? -best.dayDiff : best.dayDiff,
        generated:best.generated, rateVersion:'window',
        ruleName, ruleDesc, targetDate
    };
}

// ─── Strict 3-category legal classifier ──────────────────────────────────────
// 'helyes'   → exact match on Fulfillment Date (T or T-1) only.
// 'kérdéses' → match found on any other date (issue date, ±window).
// 'nincs'    → no match whatsoever.
function buildLegalFeedback(bestMatch) {
    if (!bestMatch) {
        return {
            category:  'nincs',
            iconClass: 'bi-x-circle-fill text-danger',
            badgeHtml: '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>Nincs egyezés</span>',
            text:      'Az alkalmazott árfolyam valószínűleg nem felel meg a jogszabályi előírásoknak.'
        };
    }

    const onFulfillment = bestMatch.matchType === 'exact' && bestMatch.anchorType === 'teljesítés';

    if (onFulfillment) {
        const prevNote = bestMatch.rateVersion === 'previous' ? ' / MNB előző napi' : '';
        return {
            category:  'helyes',
            iconClass: 'bi-check-circle-fill text-success',
            badgeHtml: `<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Teljesítés napja${bestMatch.rateVersion === 'previous' ? ' <small>(T−1)</small>' : ''}</span>`,
            text:      `Az alkalmazott árfolyam helyes. Alapja: ${bestMatch.ruleName} szerinti dátum (${bestMatch.targetDate}${prevNote}).`
        };
    }

    // Match exists but NOT on fulfillment date → kérdéses
    const prevNote = bestMatch.rateVersion === 'previous' ? ' (T−1)' : '';
    let where = '';
    if (bestMatch.matchType === 'exact' && bestMatch.anchorType === 'kiállítás') {
        where = `Kiállítás napja${prevNote}`;
    } else {
        const sign = bestMatch.dayOffset > 0 ? '+' : '';
        where = `${sign}${bestMatch.dayOffset}n (${bestMatch.anchorType})`;
    }
    return {
        category:  'kérdéses',
        iconClass: 'bi-exclamation-triangle-fill text-warning',
        badgeHtml: `<span class="badge bg-warning text-dark"><i class="bi bi-exclamation-triangle me-1"></i>${where}</span>`,
        text:      'Az alkalmazott árfolyam valószínűleg nem felel meg a jogszabályi előírásoknak.'
    };
}

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
    CONFIG.columns.invoiceNum      = document.getElementById('configInvoiceNum').value;
    CONFIG.columns.issueDate       = document.getElementById('configDate').value;
    CONFIG.columns.performanceDate = document.getElementById('configPerformanceDate').value;
    CONFIG.columns.currency        = document.getElementById('configCurrency').value;
    CONFIG.columns.eurAmount       = document.getElementById('configEurAmount').value;
    CONFIG.columns.hufAmount       = document.getElementById('configHufAmount').value;
    CONFIG.columns.eurRate         = document.getElementById('configEurRate').value;
    const txEl = document.getElementById('configTransactionType');
    if (txEl) CONFIG.columns.transactionType = txEl.value;
    CONFIG.headerRow = parseInt(document.getElementById('configHeaderRow').value) - 1;
}

function findColumnIndexes(headerRow) {
    if (!headerRow) return Object.fromEntries(Object.keys(CONFIG.columns).map(k => [k, -1]));
    const indexes = {};
    for (const [key, columnName] of Object.entries(CONFIG.columns)) {
        indexes[key] = headerRow.findIndex(cell =>
            cell != null && cell.toString().trim().toLowerCase() === columnName.toString().trim().toLowerCase()
        );
    }
    return indexes;
}

// Decimal fix: corrupted exports may omit the decimal point (e.g. "39176" → 391.76).
// Any rate > 1000 is unrealistic for HUF/EUR, so divide by 100.
function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return value > 1000 ? value / 100 : value;
    if (typeof value === 'string') {
        const cleaned = value.replace(/[^\d.,\-]/g, '').replace(',', '.').replace(/\.(?=.*\.)/g, '');
        const n = parseFloat(cleaned);
        if (isNaN(n)) return null;
        return n > 1000 ? n / 100 : n;
    }
    return null;
}

function formatDateForDisplay(v) {
    if (!v) return '-';
    if (typeof v === 'number') return new Date((v - 25569) * 86400000).toLocaleDateString('hu-HU');
    return v.toString();
}

// ─── Data processing ──────────────────────────────────────────────────────────
// Header fallback: if the configured header row has no recognized columns,
// automatically retries with row 0 before giving up.
function processExcelData(data, headerRowIndex) {
    if (!data || !data.length) return [];

    // Try configured row; fall back to row 0 if critical columns not found
    let actualHeaderRow = headerRowIndex;
    CONFIG.columnIndexes = findColumnIndexes(data[headerRowIndex]);
    const critical = ['issueDate', 'eurRate'];
    const hasCritical = ci => critical.some(k => ci[k] !== -1);

    if (!hasCritical(CONFIG.columnIndexes) && headerRowIndex !== 0 && data.length > 0) {
        const fallback = findColumnIndexes(data[0]);
        if (hasCritical(fallback)) {
            CONFIG.columnIndexes = fallback;
            actualHeaderRow = 0;
            console.warn(`Fejléc nem a(z) ${headerRowIndex + 1}. sorban – visszaesés az 1. sorra.`);
        }
    }

    const ci = CONFIG.columnIndexes;
    const processed = [];

    for (let i = actualHeaderRow + 1; i < data.length; i++) {
        const row = data[i];
        if (!row || row.every(c => c === undefined || c === null || c === '')) continue;

        if (ci.currency !== -1) {
            const cur = row[ci.currency];
            if (!cur || cur.toString().trim().toUpperCase() !== 'EUR') continue;
        }

        // parseNumber already applies the >1000 ÷100 fix
        const excelEurRate = ci.eurRate !== -1 ? parseNumber(row[ci.eurRate]) : null;
        if (excelEurRate === null) continue;

        const invoiceNum     = ci.invoiceNum !== -1 ? (row[ci.invoiceNum] || '') : '';
        const issueDateValue = ci.issueDate !== -1  ? row[ci.issueDate]  : null;
        const perfDateValue  = ci.performanceDate !== -1 ? row[ci.performanceDate] : null;
        const eurAmount      = ci.eurAmount !== -1  ? parseNumber(row[ci.eurAmount]) : null;
        const hufAmount      = ci.hufAmount !== -1  ? parseNumber(row[ci.hufAmount]) : null;
        const txTypeValue    = ci.transactionType !== -1 ? row[ci.transactionType] : null;

        const issueDateStr = formatDate(issueDateValue);
        if (!issueDateStr || eurAmount === null) continue;

        // Date collision: if issue === perf, they are the same date
        const perfDateStr = formatDate(perfDateValue) || issueDateStr;

        // MNB reference rates for display columns
        const mnbPerfResult  = getMnbRate(perfDateStr, RATE_TYPE.CURRENT_DAY);
        const mnbIssueResult = issueDateStr !== perfDateStr
            ? getMnbRate(issueDateStr, RATE_TYPE.CURRENT_DAY)
            : mnbPerfResult;
        const mnbPerfRate  = mnbPerfResult  ? mnbPerfResult.rate  : null;
        const mnbIssueRate = mnbIssueResult ? mnbIssueResult.rate : null;

        const txType    = detectTransactionType(txTypeValue);
        const bestMatch = findBestRateMatch(excelEurRate, issueDateStr, perfDateStr, txType);

        const legalFeedback     = buildLegalFeedback(bestMatch);
        const matchingRate      = bestMatch ? bestMatch.sourceRate  : null;
        const matchingDate      = bestMatch ? bestMatch.sourceDate  : null;
        const matchingGenerated = bestMatch ? bestMatch.generated   : false;
        const dayDifference     = bestMatch ? bestMatch.dayOffset   : null;

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
            txType, txTypeValue,
            bestMatch, matchingRate, matchingDate, matchingGenerated, dayDifference,
            legalFeedback,
            calculatedHuf, difference, differencePercent, diffClass
        });
    }
    return processed;
}

// ─── Audit Dashboard ──────────────────────────────────────────────────────────
function renderDashboard(data) {
    const el = document.getElementById('auditDashboard');
    if (!el) return;

    const total    = data.length;
    const helyes   = data.filter(r => r.legalFeedback.category === 'helyes').length;
    const kerdezes = data.filter(r => r.legalFeedback.category === 'kérdéses').length;
    const nincs    = data.filter(r => r.legalFeedback.category === 'nincs').length;
    const prevDay  = data.filter(r => r.bestMatch?.rateVersion === 'previous').length;
    const overchg  = data.filter(r => r.difference !== null && r.difference >  1).length;
    const underchg = data.filter(r => r.difference !== null && r.difference < -1).length;

    const statCard = (val, label, bg, textClass = '') => `
        <div class="col">
            <div class="text-center p-3 rounded-3 h-100 d-flex flex-column justify-content-center" style="background:${bg}">
                <div class="fs-2 fw-bold ${textClass}">${val}</div>
                <div class="small mt-1 text-dark fw-medium">${label}</div>
            </div>
        </div>`;

    const discAlert = (overchg + underchg) > 0
        ? `<div class="alert alert-warning mb-0 mt-3 py-2 px-3 d-flex align-items-center gap-3">
               <i class="bi bi-exclamation-triangle-fill fs-5 text-warning"></i>
               <span><strong>${overchg + underchg} számlán HUF-eltérés:</strong>
               <span class="ms-3 text-danger fw-bold">▲ ${overchg} túlszámlázott</span>
               <span class="ms-3 text-success fw-bold">▼ ${underchg} alulszámlázott</span></span>
           </div>`
        : `<div class="alert alert-success mb-0 mt-3 py-2 px-3">
               <i class="bi bi-check-circle-fill me-2"></i>Nem található HUF-eltérés az árfolyamokon.
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
                        ${statCard(total,    'Összes EUR számla',                     '#e9ecef')}
                        ${statCard(helyes,   'Jogilag helyes<br>(teljesítés T/T−1)',  '#d1e7dd', 'text-success')}
                        ${statCard(kerdezes, 'Jogilag kérdéses<br>(egyéb dátum)',     '#fff3cd', 'text-warning')}
                        ${statCard(nincs,    'Nincs egyezés',                        '#f8d7da', 'text-danger')}
                        ${statCard(prevDay,  'MNB előző napi<br>egyezés (T−1)',       '#cff4fc', 'text-info')}
                    </div>
                    ${discAlert}
                    <div class="mt-2 small text-muted">
                        <i class="bi bi-info-circle me-1"></i>
                        <strong>Jogilag helyes</strong> = árfolyam egyezik a teljesítés napján érvényes MNB-árfolyammal (T vagy T−1).
                        Bármely más dátumra eső egyezés <strong>kérdéses</strong> és kézi felülvizsgálatot igényel.
                    </div>
                </div>
            </div>
        </div>`;
}

// ─── Table rendering ──────────────────────────────────────────────────────────
function renderTable(data) {
    tableBody.innerHTML = '';

    if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="15" class="text-center">Nincs megjeleníthető adat</td></tr>';
        return;
    }

    renderDashboard(data);

    let positiveDiff = 0, negativeDiff = 0;
    let cntHelyes = 0, cntKerdezes = 0, cntNincs = 0;

    const fmt    = (n, d=0) => n == null ? '-' : new Intl.NumberFormat('hu-HU', {minimumFractionDigits:d, maximumFractionDigits:d}).format(n);
    const fmtPct = n => n == null ? '-' : new Intl.NumberFormat('hu-HU', {minimumFractionDigits:2, maximumFractionDigits:2}).format(n) + '%';

    data.forEach(row => {
        const tr = document.createElement('tr');
        if (row.diffClass) tr.className = row.diffClass;
        if (row.matchingGenerated) tr.classList.add('generated-rate');

        const lf = row.legalFeedback;
        if (lf.category === 'helyes')   cntHelyes++;
        if (lf.category === 'kérdéses') cntKerdezes++;
        if (lf.category === 'nincs')    cntNincs++;

        if (row.difference !== null) {
            if (row.difference >  1) positiveDiff++;
            if (row.difference < -1) negativeDiff++;
        }

        // Source date + signed offset
        let srcDateHtml = '-';
        if (row.matchingDate) {
            const offsetHtml = (row.dayDifference !== null && row.dayDifference !== 0)
                ? ` <small class="text-muted">(${row.dayDifference > 0 ? '+' : ''}${row.dayDifference}n)</small>`
                : '';
            srcDateHtml = row.matchingDate + offsetHtml;
        }

        const matchRateHtml = row.matchingRate
            ? `<strong>${fmt(row.matchingRate, 2)}</strong>${row.matchingGenerated ? '<sup class="text-danger ms-1" title="Hétvégi generált árfolyam">*</sup>' : ''}`
            : '<span class="text-danger">—</span>';

        const rateDeviation = (row.matchingRate && row.excelEurRate) ? Math.abs(row.excelEurRate - row.matchingRate) : null;
        const invoiceRateClass = (rateDeviation !== null && rateDeviation >= 0.01) ? 'text-danger fw-bold' : '';

        const legalHtml = `<i class="bi ${lf.iconClass} me-1"></i><span class="legal-feedback">${lf.text}</span>`;

        tr.innerHTML = `
            <td>${row.invoiceNum || '-'}</td>
            <td class="text-center">${lf.badgeHtml}</td>
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
            <td class="text-end">${fmtPct(row.differencePercent)}</td>
            <td class="small">${legalHtml}</td>`;

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
            <div class="col text-success">✓ Jogilag helyes: ${cntHelyes}</div>
            <div class="col text-warning">⚠ Kérdéses: ${cntKerdezes}</div>
            <div class="col text-danger">✗ Nincs egyezés: ${cntNincs}</div>
            <div class="col">▲ ${positiveDiff} | ▼ ${negativeDiff} HUF-eltérés</div>
        </div>`;

    const tc = document.querySelector('.table-container');
    if (tc) tc.insertBefore(info, tc.firstChild);

    if (dataTable) dataTable.destroy();
    dataTable = $('#dataTable').DataTable({
        language: { url: 'https://cdn.datatables.net/plug-ins/1.13.6/i18n/hu.json' },
        dom: 'Bfrtip',
        buttons: [
            { extend: 'csv',        text: 'CSV letöltés',   className: 'btn btn-secondary', bom: true },
            { extend: 'excelHtml5', text: 'Excel letöltés', className: 'btn btn-success',
              title: 'Adattábla exportálása', exportOptions: { columns: ':visible' } }
        ],
        pageLength: 25,
        order: [[13, 'desc']],
        columnDefs: [
            { type: 'num',     targets: [4,5,6,7,8,9,11,12] },
            { type: 'num-fmt', targets: [13] },
            { type: 'string',  targets: [0,1,2,3,10,14] }
        ],
        destroy:   true,
        retrieve:  true,
        scrollX:   true,
        responsive: false
    });
}

// ─── Event handlers ───────────────────────────────────────────────────────────
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
            rawExcelData  = jsonData;
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

// MNB info (elements may not exist if panel was removed – guard with ?.)
const availEl = document.getElementById('availableRatesCount');
const updateEl = document.getElementById('updateMNB');
if (availEl) availEl.textContent = MNB_RATES.data.length;
if (updateEl) {
    const ts = MNB_RATES.ts;
    updateEl.textContent = `${ts.slice(0,4)}.${ts.slice(4,6)}.${ts.slice(6,8)}. ${ts.slice(8,10)}:${ts.slice(10,12)}`;
}

loadConfig();
console.log('App inicializálva');
