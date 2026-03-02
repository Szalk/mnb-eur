const CONFIG = {
    headerRow: 5,
    currencyFilter: 'EUR',
    columns: {
        invoiceNum:       'Számla száma',
        invoiceOperation: 'Számla művelete',
        issueDate:        'Számla kelte',
        performanceDate:  'Teljesítés dátuma',
        currency:         'Számla pénzneme',
        eurAmount:        'Számla nettó összege a számla pénznemében',
        hufAmount:        'Számla nettó összege forintban',
        eurRate:          'Alkalmazott árfolyam',
        transactionType:  'Ügylettípus'
    },
    columnIndexes: {
        invoiceNum:-1, invoiceOperation:-1, issueDate:-1, performanceDate:-1, currency:-1,
        eurAmount:-1, hufAmount:-1, eurRate:-1, transactionType:-1
    },
    searchDays: 30
};

let dataTable      = null;
let processedData  = [];
let rawExcelData   = null;
let selectedFile   = null;
let filterProblemOnly = false;

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
    if (v.includes('kozosseg') || /\bkb\b/.test(v))             return TRANSACTION_TYPES.KB;
    if (v.includes('eloleg'))                                    return TRANSACTION_TYPES.ELEG;
    if (v.includes('fordito'))                                   return TRANSACTION_TYPES.FORDÍTOTT;
    if (v.includes('idoszak') || v.includes('folyamatos'))       return TRANSACTION_TYPES.IDOSZAKOS;
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
//              Sub-variant: rate is correct but a calculation difference exists.
// 'kérdéses' → match found on any other date (issue date, ±window).
// 'nincs'    → no match whatsoever.
function buildLegalFeedback(bestMatch, difference = null) {
    if (!bestMatch) {
        return {
            category:  'nincs',
            iconClass: 'bi-x-circle-fill text-danger',
            label:     'Nincs egyezés',
            text:      'Az alkalmazott árfolyam valószínűleg nem felel meg a jogszabályi előírásoknak.'
        };
    }

    const onFulfillment = bestMatch.matchType === 'exact' && bestMatch.anchorType === 'teljesítés';

    if (onFulfillment) {
        const prevNote   = bestMatch.rateVersion === 'previous' ? ' / MNB előző napi' : '';
        const hasCalcDiff = difference !== null && Math.abs(difference) >= 0.01;
        if (hasCalcDiff) {
            return {
                category:  'helyes',
                iconClass: 'bi-check-circle text-success',
                label:     'Jogilag helyes (eltéréssel)',
                text:      `Az árfolyam helyes (${bestMatch.targetDate}${prevNote}), de számítási eltérés van (kerekítési különbség).`
            };
        }
        return {
            category:  'helyes',
            iconClass: 'bi-check-circle-fill text-success',
            label:     'Jogilag helyes',
            text:      `Az alkalmazott árfolyam helyes. Alapja: ${bestMatch.ruleName} szerinti dátum (${bestMatch.targetDate}${prevNote}).`
        };
    }

    return {
        category:  'kérdéses',
        iconClass: 'bi-exclamation-triangle-fill text-warning',
        label:     'Jogilag kérdéses',
        text:      'Az alkalmazott árfolyam valószínűleg nem felel meg a jogszabályi előírásoknak.'
    };
}

// ─── Source badge: descriptive date + nature of match ────────────────────────
// Shows: which date was used (Teljesítés / Kiállítás) AND the nature (azonos nap / előző nap / ±Xn)
function buildSourceBadge(bestMatch) {
    if (!bestMatch) {
        return '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>Nincs egyezés</span>';
    }

    const dateLabel = bestMatch.anchorType === 'teljesítés' ? 'Teljesítés' : 'Kiállítás';
    let natureLabel, cls;

    if (bestMatch.matchType === 'exact') {
        natureLabel = bestMatch.rateVersion === 'previous' ? 'előző nap' : 'azonos nap';
        cls         = bestMatch.anchorType === 'teljesítés' ? 'bg-success' : 'bg-info';
    } else {
        const sign  = bestMatch.dayOffset > 0 ? '+' : '';
        natureLabel = `${sign}${bestMatch.dayOffset}n`;
        cls         = 'bg-warning text-dark';
    }

    return `<span class="badge ${cls}"><i class="bi bi-currency-exchange me-1"></i>${dateLabel} · ${natureLabel}</span>`;
}

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
    CONFIG.columns.invoiceNum      = document.getElementById('configInvoiceNum').value;
    const opEl = document.getElementById('configInvoiceOperation');
    if (opEl) CONFIG.columns.invoiceOperation = opEl.value;
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
// Any EUR/HUF rate > 1000 is unrealistic, so divide by 100.
// isRate=true applies this fix; for amounts (which can exceed 1000) do NOT apply it.
function parseNumber(value, isRate = false) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return (isRate && value > 1000) ? value / 100 : value;
    if (typeof value === 'string') {
        // Normalize: accept both '.' and ',' as decimal separators; strip thousands separators
        const cleaned = value.replace(/[^\d.,\-]/g, '').replace(',', '.').replace(/\.(?=.*\.)/g, '');
        const n = parseFloat(cleaned);
        if (isNaN(n)) return null;
        return (isRate && n > 1000) ? n / 100 : n;
    }
    return null;
}

function formatDateForDisplay(v) {
    if (!v) return '-';
    if (typeof v === 'number') {
        // Excel serial date → JS Date → YYYY-MM-DD
        const d = new Date(Math.round((v - 25569) * 86400000));
        return d.toISOString().split('T')[0];
    }
    // Already a string: normalize to YYYY-MM-DD via formatDate helper (defined in index.html)
    const normalized = formatDate(v);
    return normalized || v.toString();
}

// ─── Data processing ──────────────────────────────────────────────────────────
// Header fallback: if the configured header row has no recognized columns,
// automatically retries with row 0 before giving up.
function processExcelData(data, headerRowIndex) {
    if (!data || !data.length) return [];

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

        // isRate=true: apply >1000÷100 fix only to the rate column (not to amounts)
        const excelEurRate = ci.eurRate !== -1 ? parseNumber(row[ci.eurRate], true) : null;
        if (excelEurRate === null) continue;

        const invoiceNum      = ci.invoiceNum !== -1 ? (row[ci.invoiceNum] || '') : '';
        const invoiceOperation = ci.invoiceOperation !== -1 ? (row[ci.invoiceOperation] || '') : '';
        const issueDateValue  = ci.issueDate !== -1 ? row[ci.issueDate] : null;
        const perfDateValue   = ci.performanceDate !== -1 ? row[ci.performanceDate] : null;
        const eurAmount       = ci.eurAmount !== -1 ? parseNumber(row[ci.eurAmount]) : null;
        const hufAmount       = ci.hufAmount !== -1 ? parseNumber(row[ci.hufAmount]) : null;
        const txTypeValue     = ci.transactionType !== -1 ? row[ci.transactionType] : null;

        const issueDateStr = formatDate(issueDateValue);
        if (!issueDateStr || eurAmount === null) continue;

        const perfDateStr = formatDate(perfDateValue) || issueDateStr;

        const mnbPerfResult  = getMnbRate(perfDateStr, RATE_TYPE.CURRENT_DAY);
        const mnbIssueResult = issueDateStr !== perfDateStr
            ? getMnbRate(issueDateStr, RATE_TYPE.CURRENT_DAY)
            : mnbPerfResult;
        const mnbPerfRate  = mnbPerfResult  ? mnbPerfResult.rate  : null;
        const mnbIssueRate = mnbIssueResult ? mnbIssueResult.rate : null;

        const txType    = detectTransactionType(txTypeValue);
        const bestMatch = findBestRateMatch(excelEurRate, issueDateStr, perfDateStr, txType);

        const matchingRate      = bestMatch ? bestMatch.sourceRate  : null;
        const matchingDate      = bestMatch ? bestMatch.sourceDate  : null;
        const matchingGenerated = bestMatch ? bestMatch.generated   : false;
        const dayDifference     = bestMatch ? bestMatch.dayOffset   : null;

        // Compute difference BEFORE buildLegalFeedback (needed for new calc-diff condition)
        const calculatedHuf = (eurAmount && matchingRate)
            ? parseFloat((eurAmount * matchingRate).toFixed(2))
            : null;

        let difference = null, differencePercent = null, diffClass = '';
        if (hufAmount !== null && calculatedHuf !== null) {
            difference = parseFloat((hufAmount - calculatedHuf).toFixed(2));

            if (hufAmount !== 0) {
                // Normal case: % relative to the source HUF amount
                differencePercent = parseFloat((difference / hufAmount * 100).toFixed(2));
            } else if (calculatedHuf !== 0) {
                // Source HUF is 0: the full amount is missing.
                // Express as % relative to what the amount should have been (calculatedHuf).
                // e.g. hufAmount=0, calculatedHuf=100 000 → difference=-100 000 → -100%
                differencePercent = parseFloat((difference / calculatedHuf * 100).toFixed(2));
            } else {
                differencePercent = 0; // both 0: no deviation
            }

            diffClass = Math.abs(difference) < 0.5 ? 'difference-zero'
                       : difference > 0             ? 'difference-positive'
                       :                              'difference-negative';
        }

        const legalFeedback = buildLegalFeedback(bestMatch, difference);

        processed.push({
            invoiceNum,
            invoiceOperation,
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
// 15-column layout (0-based index → Excel column letter):
//  0:A Számla sorszám    1:B Számla művelete   2:C Ügylettípus
//  3:D Forrás egyezés    4:E Kiállítás dátuma  5:F Teljesítés dátuma
//  6:G EUR összeg        7:H Alkalmazott árf.  8:I HUF (Excel)
//  9:J Legv. forrás árf. 10:K Forrás dátum    11:L Számított HUF
// 12:M Eltérés (HUF)    13:N Eltérés (%)      14:O Jogi értékelés
const NUM_COLS_IDX  = [6, 7, 8, 9, 11, 12, 13]; // numeric column indexes (0-based)
const NUM_COLS_XLSX = ['G','H','I','J','L','M','N']; // matching Excel column letters

function renderTable(data) {
    tableBody.innerHTML = '';
    filterProblemOnly = false; // reset filter on each new dataset

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
        const lf = row.legalFeedback;

        // Non-helyes rows get a light-red highlight; helyes rows keep the diff-class coloring
        if (lf.category !== 'helyes') {
            tr.classList.add('legal-issue-row');
        } else if (row.diffClass) {
            tr.className = row.diffClass;
        }
        if (row.matchingGenerated) tr.classList.add('generated-rate');
        tr.setAttribute('data-legal-category', lf.category);

        if (lf.category === 'helyes')   cntHelyes++;
        if (lf.category === 'kérdéses') cntKerdezes++;
        if (lf.category === 'nincs')    cntNincs++;

        if (row.difference !== null) {
            if (row.difference >  1) positiveDiff++;
            if (row.difference < -1) negativeDiff++;
        }

        // Forrás dátum: YYYY-MM-DD + signed offset annotation
        let srcDateHtml = '-';
        if (row.matchingDate) {
            const offsetHtml = (row.dayDifference !== null && row.dayDifference !== 0)
                ? ` <small class="text-muted">(${row.dayDifference > 0 ? '+' : ''}${row.dayDifference}n)</small>`
                : '';
            srcDateHtml = row.matchingDate + offsetHtml;
        }

        // Legv. forrás árfolyam cell
        const matchRateHtml = row.matchingRate
            ? `<strong>${fmt(row.matchingRate, 2)}</strong>${row.matchingGenerated ? '<sup class="text-danger ms-1" title="Hétvégi generált árfolyam">*</sup>' : ''}`
            : '<span class="text-danger">—</span>';

        const rateDeviation    = (row.matchingRate && row.excelEurRate) ? Math.abs(row.excelEurRate - row.matchingRate) : null;
        const invoiceRateClass = (rateDeviation !== null && rateDeviation >= 0.01) ? 'text-danger fw-bold' : '';

        const legalHtml = `<i class="bi ${lf.iconClass} me-1"></i><span class="legal-feedback">${lf.text}</span>`;

        // Raw numeric values stored in data-n for reliable export parsing
        tr.innerHTML = `
            <td>${row.invoiceNum || '-'}</td>
            <td>${row.invoiceOperation || '-'}</td>
            <td>${row.txTypeValue || '-'}</td>
            <td class="text-center">${buildSourceBadge(row.bestMatch)}</td>
            <td>${row.issueDateDisplay}</td>
            <td>${row.performanceDateDisplay}</td>
            <td class="text-end" data-n="${row.eurAmount ?? ''}">${fmt(row.eurAmount, 2)}</td>
            <td class="text-end fw-semibold ${invoiceRateClass}" data-n="${row.excelEurRate ?? ''}">${fmt(row.excelEurRate, 2)}</td>
            <td class="text-end" data-n="${row.hufAmount ?? ''}">${fmt(row.hufAmount, 2)}</td>
            <td class="text-end" data-n="${row.matchingRate ?? ''}">${matchRateHtml}</td>
            <td class="text-nowrap">${srcDateHtml}</td>
            <td class="text-end" data-n="${row.calculatedHuf ?? ''}">${fmt(row.calculatedHuf, 2)}</td>
            <td class="text-end fw-semibold" data-n="${row.difference ?? ''}">${fmt(row.difference, 2)}</td>
            <td class="text-end" data-n="${row.differencePercent ?? ''}">${fmtPct(row.differencePercent)}</td>
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
            // Toggle filter: show only non-helyes rows
            {
                text: '<i class="bi bi-funnel-fill me-1"></i>Csak problémás sorok',
                className: 'btn btn-outline-danger',
                action: function(e, dt, node) {
                    filterProblemOnly = !filterProblemOnly;
                    $(node).toggleClass('btn-outline-danger btn-danger active');
                    dt.draw();
                }
            },
            {
                extend: 'csv',
                text: 'CSV letöltés',
                className: 'btn btn-secondary',
                bom: true,
                exportOptions: {
                    columns: ':visible',
                    format: { body: exportBodyFormatter }
                }
            },
            {
                extend: 'excelHtml5',
                text: 'Excel letöltés',
                className: 'btn btn-success',
                title: 'MNB árfolyam ellenőrzés',
                exportOptions: {
                    columns: ':visible',
                    format: { body: exportBodyFormatter }
                },
                // Post-process XLSX: convert raw numeric cells in financial columns to
                // inline strings with comma decimal (e.g. 398.93 → "398,93").
                // This is necessary because DataTables Buttons strips commas when
                // normalizing string values before writing XLSX numeric cells.
                customize: function(xlsx) {
                    const sheet = xlsx.xl.worksheets['sheet1.xml'];
                    $('row', sheet).each(function() {
                        const r = parseInt($(this).attr('r'));
                        if (r <= 1) return; // skip header row
                        NUM_COLS_XLSX.forEach(col => {
                            const cell = $('c[r="' + col + r + '"]', this);
                            if (!cell.length) return;
                            const numVal = parseFloat(cell.find('v').text());
                            if (!isNaN(numVal)) {
                                // Replace numeric cell with inline string "398,93"
                                const strVal = numVal.toFixed(2).replace('.', ',');
                                cell.attr('t', 'inlineStr');
                                cell.html('<is><t>' + strVal + '</t></is>');
                            }
                        });
                    });
                }
            }
        ],
        pageLength: 25,
        order: [[12, 'desc']], // Eltérés (HUF) descending
        columnDefs: [
            { type: 'num',     targets: NUM_COLS_IDX.filter(i => i !== 13) },
            { type: 'num-fmt', targets: [13] },
            { type: 'string',  targets: [0, 1, 2, 3, 4, 5, 10, 14] }
        ],
        destroy:   true,
        retrieve:  true,
        scrollX:   true,
        responsive: false
    });
}

// Export body formatter: returns raw JS numbers for numeric columns so the
// customize callback can convert them to comma-decimal inline strings in XLSX.
// For CSV, the same raw number is written (dot decimal), which is standard.
// Non-numeric columns are returned as plain text (HTML stripped).
function exportBodyFormatter(data, row, column, node) {
    if (NUM_COLS_IDX.includes(column)) {
        // Prefer the raw JS float stored in data-n
        const raw = node ? node.getAttribute('data-n') : null;
        let n = (raw !== null && raw !== '') ? parseFloat(raw) : NaN;
        if (isNaN(n)) {
            // Fallback: strip HTML, parse Hungarian-formatted number
            const text = String(data).replace(/<[^>]+>/g, '').trim();
            if (!text || text === '-' || text === '—') return '';
            n = parseFloat(text.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace('%', ''));
        }
        return isNaN(n) ? '' : n; // raw JS number
    }
    return String(data).replace(/<[^>]+>/g, '').trim();
}

// ─── State reset ──────────────────────────────────────────────────────────────
// Clears all previous-session state so a new upload always starts clean.
function resetState() {
    processedData     = [];
    rawExcelData      = null;
    filterProblemOnly = false;

    if (tableBody) tableBody.innerHTML = '';

    if (dataTable) {
        dataTable.destroy();
        dataTable = null;
    }

    const auditEl = document.getElementById('auditDashboard');
    if (auditEl) auditEl.style.display = 'none';

    const infoBar = document.querySelector('.generated-info');
    if (infoBar) infoBar.remove();
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
        resetState(); // clear previous results immediately on new file selection
    }
});

btnProcess.addEventListener('click', () => {
    if (selectedFile) { loadConfig(); processExcel(selectedFile); }
    else alert('Kérlek, előbb válassz ki egy fájlt!');
});

function processExcel(file) {
    resetState(); // ensure a completely clean start before processing
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
const availEl  = document.getElementById('availableRatesCount');
const updateEl = document.getElementById('updateMNB');
if (availEl)  availEl.textContent = MNB_RATES.data.length;
if (updateEl) {
    const ts = MNB_RATES.ts;
    updateEl.textContent = `${ts.slice(0,4)}.${ts.slice(4,6)}.${ts.slice(6,8)}. ${ts.slice(8,10)}:${ts.slice(10,12)}`;
}

loadConfig();

// Register once: custom search filter toggled by the "Csak problémás sorok" button.
// Uses data-legal-category attribute set on each <tr> in renderTable.
$.fn.dataTable.ext.search.push(function(settings, data, dataIndex) {
    if (!filterProblemOnly || !dataTable) return true;
    const rowNode = dataTable.row(dataIndex).node();
    return rowNode ? rowNode.getAttribute('data-legal-category') !== 'helyes' : true;
});

console.log('App inicializálva');
