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
        hufAmount:        'Számla számított nettó összege forintban',
        eurRate:          'Alkalmazott árfolyam',
        transactionType:  'Vevő adószáma'
    },
    columnIndexes: {
        invoiceNum:-1, invoiceOperation:-1, issueDate:-1, performanceDate:-1, currency:-1,
        eurAmount:-1, hufAmount:-1, eurRate:-1, transactionType:-1
    },
    searchDays: 30
};

let dataTable         = null;
let processedData     = [];
let rawExcelData      = null;
let selectedFile      = null;
let filterProblemOnly = false;

const uploadArea         = document.getElementById('uploadArea');
const fileInput          = document.getElementById('fileInput');
const tableBody          = document.getElementById('tableBody');
const fileReadyBar       = document.getElementById('fileReadyBar');
const selectedFileNameEl = document.getElementById('selectedFileName');

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
    if (v.includes('kozosseg') || /\bkb\b/.test(v))       return TRANSACTION_TYPES.KB;
    if (v.includes('eloleg'))                              return TRANSACTION_TYPES.ELEG;
    if (v.includes('fordito'))                             return TRANSACTION_TYPES.FORDÍTOTT;
    if (v.includes('idoszak') || v.includes('folyamatos')) return TRANSACTION_TYPES.IDOSZAKOS;
    return TRANSACTION_TYPES.EGYEB;
}

// ─── Anchor date resolver ─────────────────────────────────────────────────────
// Returns the legally required reference date for each transaction type.
// § 80 VAT Act rules:
//   KB / Periodic  → Invoice Issue Date (kiállítás napja)
//   Advance        → Credit/Receipt Date (jóváírás/kézhezvétel napja = issue date)
//   Reverse Tax    → Earlier of (issue date) or (15th of next month after performance)
//   General        → Performance Date (teljesítés napja)
function resolveTargetDate(txType, issueDateStr, perfDateStr) {
    const eff = perfDateStr || issueDateStr;
    switch (txType) {
        case TRANSACTION_TYPES.KB:
            return { targetDate: issueDateStr,
                     ruleName: 'Közösségen belüli termékbeszerzés',
                     ruleDesc: 'kiállítás napja' };
        case TRANSACTION_TYPES.ELEG:
            return { targetDate: issueDateStr,
                     ruleName: 'Előleg',
                     ruleDesc: 'jóváírás/kézhezvétel napja' };
        case TRANSACTION_TYPES.FORDÍTOTT: {
            const fifteenth = dayjs(eff).add(1, 'month').date(15).format('YYYY-MM-DD');
            const target = issueDateStr < fifteenth ? issueDateStr : fifteenth;
            return { targetDate: target,
                     ruleName: 'Fordított adózás',
                     ruleDesc: 'kiállítás napja (legkorábbi elérhető)' };
        }
        case TRANSACTION_TYPES.IDOSZAKOS:
            return { targetDate: issueDateStr,
                     ruleName: 'Időszakos elszámolás',
                     ruleDesc: 'kiállítás napja' };
        default:
            return { targetDate: eff,
                     ruleName: 'Egyéb eset',
                     ruleDesc: 'teljesítés napja' };
    }
}

// ─── Core matching (dual-rate + tx-type routing) ──────────────────────────────
// § 80 Dual Rate Rule: for any workday, BOTH the current day rate (T) AND the
// previous workday rate (T-1) are legally valid.  We test both before falling
// back to the ±30-day window.
//
// Matching phases:
//   Phase 1 – exact match on the transaction-specific anchor date (T then T-1)
//   Phase 2 – exact match on the secondary date (T then T-1)
//   Phase 3 – closest match within a ±30-day window
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

    // Try current-day then previous-day rate for a given anchor date
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

    // Phase 1 – primary anchor
    const m1 = checkDual(targetDate, targetAnchorType);
    if (m1) return m1;

    // Phase 2 – secondary anchor
    if (secondaryDate) {
        const m2 = checkDual(secondaryDate, secondaryAnchorType);
        if (m2) return m2;
    }

    // Phase 3 – ±30-day window
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

// ─── Legal classifier (§ 80 three-category rule) ─────────────────────────────
// 'helyes'   → exact match on the transaction's CORRECT anchor date (T or T-1).
//              This correctly handles KB/Advance/Periodic (anchor = issue date)
//              as well as the General case (anchor = performance date).
// 'kérdéses' → match found, but on a different date or via window search.
// 'nincs'    → no matching rate found at all.
function buildLegalFeedback(bestMatch, difference = null) {
    if (!bestMatch) {
        return {
            category:  'nincs',
            iconClass: 'bi-x-circle-fill text-danger',
            label:     'Nincs egyezés',
            text:      'Az alkalmazott árfolyam valószínűleg nem felel meg a jogszabályi előírásoknak.'
        };
    }

    // Correct anchor: the invoice rate must match EXACTLY on the transaction-type
    // anchor date (targetDate), whether that is the issue date or performance date.
    const onCorrectAnchor = bestMatch.matchType === 'exact'
                         && bestMatch.anchorDate === bestMatch.targetDate;

    if (onCorrectAnchor) {
        const prevNote    = bestMatch.rateVersion === 'previous' ? ' / MNB előző napi' : '';
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

// ─── Source badge ─────────────────────────────────────────────────────────────
function buildSourceBadge(bestMatch) {
    if (!bestMatch) {
        return '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>Nincs egyezés</span>';
    }
    const dateLabel = bestMatch.anchorType === 'teljesítés' ? 'Teljesítés' : 'Kiállítás';
    let natureLabel, cls;
    if (bestMatch.matchType === 'exact') {
        natureLabel = bestMatch.rateVersion === 'previous' ? 'előző nap' : 'azonos nap';
        cls         = bestMatch.anchorDate === bestMatch.targetDate ? 'bg-success' : 'bg-info';
    } else {
        const sign  = bestMatch.dayOffset > 0 ? '+' : '';
        natureLabel = `${sign}${bestMatch.dayOffset}n`;
        cls         = 'bg-warning text-dark';
    }
    return `<span class="badge ${cls}"><i class="bi bi-currency-exchange me-1"></i>${dateLabel} · ${natureLabel}</span>`;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
// Display: Hungarian locale (space thousands, comma decimal)
const fmtHU = (n, d = 2) => {
    if (n === null || n === undefined) return '–';
    return new Intl.NumberFormat('hu-HU', {
        minimumFractionDigits: d,
        maximumFractionDigits: d
    }).format(n);
};

// Excel export: comma decimal, no thousands separator
const fmtComma = (n, d = 2) => {
    if (n === null || n === undefined) return '–';
    return Number(n).toFixed(d).replace('.', ',');
};

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

function parseNumber(value, isRate = false) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return (isRate && value > 1000) ? value / 100 : value;
    if (typeof value === 'string') {
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
        const d = new Date(Math.round((v - 25569) * 86400000));
        return d.toISOString().split('T')[0];
    }
    const normalized = formatDate(v);
    return normalized || v.toString();
}

// ─── Data processing ──────────────────────────────────────────────────────────
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

        const excelEurRate = ci.eurRate !== -1 ? parseNumber(row[ci.eurRate], true) : null;
        if (excelEurRate === null) continue;

        const invoiceNum       = ci.invoiceNum      !== -1 ? (row[ci.invoiceNum]      || '') : '';
        const invoiceOperation = ci.invoiceOperation !== -1 ? (row[ci.invoiceOperation] || '') : '';
        const issueDateValue   = ci.issueDate       !== -1 ? row[ci.issueDate]        : null;
        const perfDateValue    = ci.performanceDate !== -1 ? row[ci.performanceDate]  : null;
        const eurAmount        = ci.eurAmount       !== -1 ? parseNumber(row[ci.eurAmount])  : null;
        const hufAmount        = ci.hufAmount       !== -1 ? parseNumber(row[ci.hufAmount])  : null;
        const txTypeValue      = ci.transactionType !== -1 ? row[ci.transactionType]  : null;

        const issueDateStr = formatDate(issueDateValue);
        if (!issueDateStr || eurAmount === null) continue;

        const perfDateStr = formatDate(perfDateValue) || issueDateStr;

        const txType    = detectTransactionType(txTypeValue);
        const bestMatch = findBestRateMatch(excelEurRate, issueDateStr, perfDateStr, txType);

        const matchingRate      = bestMatch ? bestMatch.sourceRate  : null;
        const matchingDate      = bestMatch ? bestMatch.sourceDate  : null;
        const matchingGenerated = bestMatch ? bestMatch.generated   : false;
        const dayDifference     = bestMatch ? bestMatch.dayOffset   : null;

        // Difference between applied rate and best-matched rate
        const calculatedHuf = (eurAmount && matchingRate)
            ? parseFloat((eurAmount * matchingRate).toFixed(2))
            : null;

        let difference = null, differencePercent = null, diffClass = '';
        if (hufAmount !== null && calculatedHuf !== null) {
            difference = parseFloat((hufAmount - calculatedHuf).toFixed(2));
            if (hufAmount !== 0) {
                differencePercent = parseFloat((difference / hufAmount * 100).toFixed(2));
            } else if (calculatedHuf !== 0) {
                differencePercent = parseFloat((difference / calculatedHuf * 100).toFixed(2));
            } else {
                differencePercent = 0;
            }
            diffClass = Math.abs(difference) < 0.5 ? 'difference-zero'
                       : difference > 0             ? 'difference-positive'
                       :                              'difference-negative';
        }

        const legalFeedback = buildLegalFeedback(bestMatch, difference);

        // ── Correction analysis fields ─────────────────────────────────────────
        // suggestedRate: the "correct" T-rate for the transaction's anchor date,
        // regardless of what was applied.  Used to show what SHOULD have been used.
        const { targetDate: resolvedTargetDate } = resolveTargetDate(txType, issueDateStr, perfDateStr);
        const suggestedMnbResult = getMnbRate(resolvedTargetDate, RATE_TYPE.CURRENT_DAY);
        const suggestedRate      = suggestedMnbResult?.rate ?? null;
        const correctedHuf       = (eurAmount !== null && suggestedRate !== null)
            ? parseFloat((eurAmount * suggestedRate).toFixed(2))
            : null;
        const correctionDiscrepancy = (hufAmount !== null && correctedHuf !== null)
            ? parseFloat((hufAmount - correctedHuf).toFixed(2))
            : null;

        const mnbPerfResult  = getMnbRate(perfDateStr, RATE_TYPE.CURRENT_DAY);
        const mnbIssueResult = issueDateStr !== perfDateStr
            ? getMnbRate(issueDateStr, RATE_TYPE.CURRENT_DAY)
            : mnbPerfResult;
        const mnbPerfRate  = mnbPerfResult  ? mnbPerfResult.rate  : null;
        const mnbIssueRate = mnbIssueResult ? mnbIssueResult.rate : null;

        processed.push({
            invoiceNum, invoiceOperation,
            issueDate: issueDateValue,
            issueDateDisplay: formatDateForDisplay(issueDateValue),
            performanceDate: perfDateValue,
            performanceDateDisplay: perfDateValue ? formatDateForDisplay(perfDateValue) : '-',
            eurAmount, hufAmount, excelEurRate,
            mnbPerfRate, mnbIssueRate,
            txType, txTypeValue,
            bestMatch, matchingRate, matchingDate, matchingGenerated, dayDifference,
            legalFeedback,
            calculatedHuf, difference, differencePercent, diffClass,
            // Correction analysis
            resolvedTargetDate, suggestedRate, correctedHuf, correctionDiscrepancy
        });
    }
    return processed;
}

// ─── Loading overlay ──────────────────────────────────────────────────────────
function showLoading() {
    const ol = document.getElementById('loadingOverlay');
    if (ol) ol.classList.add('show');
}

function hideLoading() {
    const ol = document.getElementById('loadingOverlay');
    if (ol) ol.classList.remove('show');
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

    const helyesPct = total > 0 ? Math.round(helyes / total * 100) : 0;
    const nincsPct  = total > 0 ? Math.round(nincs  / total * 100) : 0;

    const kpiCard = (icon, iconCls, val, label, detail = '') => `
        <div class="kpi-card">
            <div class="kpi-icon ${iconCls}"><i class="bi ${icon}"></i></div>
            <div class="kpi-body">
                <div class="kpi-label">${label}</div>
                <div class="kpi-value">${val}</div>
                ${detail ? `<div class="kpi-detail">${detail}</div>` : ''}
            </div>
        </div>`;

    const discHtml = (overchg + underchg) > 0
        ? `<div class="disc-alert disc-alert--warning">
               <i class="bi bi-exclamation-triangle-fill flex-shrink-0"></i>
               <span>
                   <strong>${overchg + underchg} számlán HUF-eltérés:</strong>
                   <span class="ms-3 text-danger fw-bold">▲ ${overchg} túlszámlázott</span>
                   <span class="ms-3 text-success fw-bold">▼ ${underchg} alulszámlázott</span>
               </span>
           </div>`
        : `<div class="disc-alert disc-alert--success">
               <i class="bi bi-check-circle-fill flex-shrink-0"></i>
               <span>Nem található számottevő HUF-eltérés az árfolyamokon.</span>
           </div>`;

    el.style.display = '';
    el.innerHTML = `
        <div class="kpi-grid">
            ${kpiCard('bi-receipt',                  'kpi-icon--neutral', total,    'Összes EUR számla')}
            ${kpiCard('bi-check-circle-fill',        'kpi-icon--success', helyes,   'Jogilag helyes',    `${helyesPct}% · T és T−1 egyezés`)}
            ${kpiCard('bi-exclamation-triangle-fill','kpi-icon--warning', kerdezes, 'Jogilag kérdéses',  'egyéb dátumegyezés')}
            ${kpiCard('bi-x-circle-fill',            'kpi-icon--danger',  nincs,    'Nincs egyezés',     `${nincsPct}%`)}
            ${kpiCard('bi-clock-history',            'kpi-icon--info',    prevDay,  'MNB előző napi (T−1)', 'T−1 egyezés')}
        </div>
        ${discHtml}
        <div class="legal-note">
            <i class="bi bi-info-circle flex-shrink-0"></i>
            <span>
                <strong>Jogilag helyes</strong> = az árfolyam egyezik az ügylettípus szerinti helyes
                dátumra érvényes MNB-árfolyammal (T vagy T−1).
                Bármely más dátumra eső egyezés <strong>kérdéses</strong> és kézi felülvizsgálatot igényel.
            </span>
        </div>`;
}

// ─── Financial Correction Analysis Table ─────────────────────────────────────
// Shows rows where the rate is not legally correct OR where a significant HUF
// discrepancy exists versus the correct MNB rate.
function renderCorrectionTable(data) {
    const section   = document.getElementById('correctionSection');
    const container = document.getElementById('correctionTableContainer');
    const badge     = document.getElementById('correctionCount');
    if (!section || !container) return;

    // Include: legally non-compliant OR HUF amount differs by more than 1 HUF
    const rows = data.filter(r =>
        r.legalFeedback.category !== 'helyes' ||
        (r.correctionDiscrepancy !== null && Math.abs(r.correctionDiscrepancy) > 1)
    );

    if (!rows.length) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    if (badge) badge.textContent = rows.length;

    let totalDisc = 0;
    rows.forEach(r => { if (r.correctionDiscrepancy !== null) totalDisc += r.correctionDiscrepancy; });

    const rowsHtml = rows.map(r => {
        const discVal   = r.correctionDiscrepancy;
        const discCls   = discVal === null ? ''
                        : discVal > 0     ? 'text-danger fw-semibold'
                        : discVal < 0     ? 'text-success fw-semibold'
                        :                   'text-muted';
        const legalBadge = r.legalFeedback.category === 'nincs'
            ? '<span class="badge bg-danger">Nincs egyezés</span>'
            : r.legalFeedback.category === 'kérdéses'
                ? '<span class="badge bg-warning text-dark">Kérdéses</span>'
                : '<span class="badge bg-success">Helyes</span>';

        return `<tr>
            <td><span class="fw-medium">${r.invoiceNum || '–'}</span>
                <div class="small mt-1">${legalBadge}</div></td>
            <td class="text-end">${fmtHU(r.eurAmount)}</td>
            <td class="text-end">${fmtHU(r.hufAmount)}</td>
            <td class="text-end fw-semibold text-primary">${fmtHU(r.suggestedRate)}<br>
                <small class="text-muted fw-normal">${r.resolvedTargetDate || '–'}</small></td>
            <td class="text-end">${fmtHU(r.correctedHuf)}</td>
            <td class="text-end ${discCls}">${fmtHU(discVal)}</td>
        </tr>`;
    }).join('');

    const totalCls = totalDisc > 0 ? 'text-danger' : totalDisc < 0 ? 'text-success' : '';

    container.innerHTML = `
        <table class="table table-bordered correction-table">
            <thead>
                <tr>
                    <th>Számla azonosító</th>
                    <th class="text-end" title="Devizás nettó összeg (EUR)">Forrás EUR</th>
                    <th class="text-end" title="HUF összeg a számlán (forrásból)">Számla HUF (forrás)</th>
                    <th class="text-end" title="Jogilag helyes MNB-árfolyam az ügylettípus szerinti dátumra (T)">
                        Javasolt MNB árfolyam</th>
                    <th class="text-end" title="EUR összeg × Javasolt MNB árfolyam">
                        Korrigált HUF összeg</th>
                    <th class="text-end" title="Számla HUF − Korrigált HUF (pozitív = túlszámlázott)">
                        Eltérés (HUF)</th>
                </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot>
                <tr class="correction-total-row">
                    <td colspan="5" class="text-end">
                        <strong>Teljes pénzügyi hatás (HUF):</strong>
                    </td>
                    <td class="text-end ${totalCls}">
                        <strong>${fmtHU(totalDisc)}</strong>
                    </td>
                </tr>
            </tfoot>
        </table>`;
}

// ─── Excel export for correction table ───────────────────────────────────────
function exportCorrectionToExcel() {
    const rows = processedData.filter(r =>
        r.legalFeedback.category !== 'helyes' ||
        (r.correctionDiscrepancy !== null && Math.abs(r.correctionDiscrepancy) > 1)
    );

    if (!rows.length) { alert('Nincs korrekciós adat az exportáláshoz!'); return; }

    const wsData = [[
        'Számla azonosító',
        'Jogi értékelés',
        'Forrás EUR',
        'Számla HUF (forrás)',
        'Javasolt MNB árfolyam',
        'Helyes dátum',
        'Korrigált HUF összeg',
        'Eltérés (HUF)'
    ]];

    let totalDisc = 0;
    rows.forEach(r => {
        const disc = r.correctionDiscrepancy ?? null;
        if (disc !== null) totalDisc += disc;
        wsData.push([
            r.invoiceNum || '',
            r.legalFeedback.label,
            fmtComma(r.eurAmount),
            fmtComma(r.hufAmount),
            fmtComma(r.suggestedRate),
            r.resolvedTargetDate || '',
            fmtComma(r.correctedHuf),
            fmtComma(disc)
        ]);
    });

    // Footer: total impact row
    wsData.push(['ÖSSZESEN', '', '', '', '', '', '', fmtComma(totalDisc)]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
        {wch:28},{wch:22},{wch:14},{wch:22},{wch:22},{wch:14},{wch:22},{wch:18}
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Korrekciós elemzés');

    const ts  = MNB_RATES.ts;
    const sfx = `${ts.slice(0,4)}${ts.slice(4,6)}${ts.slice(6,8)}`;
    XLSX.writeFile(wb, `mnb_korrekciok_${sfx}.xlsx`);
}

// ─── Rate lookup ──────────────────────────────────────────────────────────────
// Implements the § 80 dual-rate display: on a workday show both T and T-1.
// On weekends / holidays show only the last available rate with an explanation.
function renderRateSearchResult(dateStr) {
    const resultEl = document.getElementById('rateSearchResult');
    if (!resultEl) return;
    if (!dateStr) { resultEl.style.display = 'none'; return; }

    const currentResult  = getMnbRate(dateStr, RATE_TYPE.CURRENT_DAY);
    const previousResult = getMnbRate(dateStr, RATE_TYPE.PREVIOUS_DAY);

    if (!currentResult || currentResult.rate === null) {
        resultEl.style.display = '';
        resultEl.innerHTML = `
            <div class="rate-result-card">
                <div class="rate-result-date-bar">
                    <i class="bi bi-calendar3"></i><strong>${dateStr}</strong>
                    <span class="badge bg-secondary ms-2">Nincs adat</span>
                </div>
                <div class="rate-result-nodata">
                    <i class="bi bi-database-x fs-2 d-block mb-2"></i>
                    Erre a dátumra nem áll rendelkezésre MNB-árfolyam az adatbázisban.
                </div>
            </div>`;
        return;
    }

    const HU_DAYS = ['vasárnap','hétfő','kedd','szerda','csütörtök','péntek','szombat'];
    const dayName = HU_DAYS[new Date(dateStr + 'T12:00:00').getDay()];

    // A date is a "workday" if the data has a non-generated entry for it
    const isWorkday = !currentResult.generated && currentResult.appliedDate === dateStr;

    const fmtR = r => r ? fmtHU(r.rate) + ' HUF' : '–';

    if (isWorkday) {
        resultEl.style.display = '';
        resultEl.innerHTML = `
            <div class="rate-result-card">
                <div class="rate-result-date-bar">
                    <i class="bi bi-calendar3"></i>
                    <strong>${dateStr}</strong>
                    <span class="text-muted ms-1">(${dayName})</span>
                    <span class="badge bg-success ms-2">Munkanap</span>
                    <small class="ms-auto text-muted">ÁFA tv. §80 – mindkét árfolyam jogilag elfogadható</small>
                </div>
                <div class="rate-result-grid">
                    <div class="rate-result-item">
                        <div class="rate-result-label">Aktuális napi árfolyam (T)</div>
                        <div class="rate-result-value">${fmtHU(currentResult.rate)}
                            <span class="rate-result-currency">HUF</span></div>
                        <div class="rate-result-date-sub">Dátum: ${currentResult.appliedDate}</div>
                        <div class="rate-result-badge">
                            <i class="bi bi-check-circle-fill"></i>Jogilag elfogadható (T)
                        </div>
                    </div>
                    <div class="rate-result-item">
                        <div class="rate-result-label">Előző munkanap árfolyama (T−1)</div>
                        <div class="rate-result-value">${fmtHU(previousResult?.rate)}
                            <span class="rate-result-currency">HUF</span></div>
                        <div class="rate-result-date-sub">Dátum: ${previousResult?.appliedDate || '–'}</div>
                        <div class="rate-result-badge">
                            <i class="bi bi-check-circle-fill"></i>Jogilag elfogadható (T−1)
                        </div>
                    </div>
                </div>
            </div>`;
    } else {
        // Weekend or holiday: only the last available workday rate applies
        const validDate = currentResult.appliedDate;
        resultEl.style.display = '';
        resultEl.innerHTML = `
            <div class="rate-result-card">
                <div class="rate-result-date-bar">
                    <i class="bi bi-calendar3"></i>
                    <strong>${dateStr}</strong>
                    <span class="text-muted ms-1">(${dayName})</span>
                    <span class="badge bg-warning text-dark ms-2">Nem munkanap</span>
                </div>
                <div class="rate-result-weekend-panel">
                    <div class="rate-result-label">Érvényes árfolyam (utolsó munkanap)</div>
                    <div class="rate-result-value">${fmtHU(currentResult.rate)}
                        <span class="rate-result-currency">HUF</span></div>
                    <div class="rate-result-date-sub">Forrás dátum: ${validDate}</div>
                    <div class="rate-result-badge rate-result-badge--warning">
                        <i class="bi bi-info-circle-fill"></i>Csak ez az árfolyam érvényes
                    </div>
                </div>
                <div class="rate-result-note">
                    <i class="bi bi-info-circle flex-shrink-0"></i>
                    <span>
                        Hétvégi és ünnepnapi számlák esetén kizárólag az előző munkanapra érvényes
                        MNB-árfolyam alkalmazható
                        (<strong>${validDate}</strong> → <strong>${fmtHU(currentResult.rate)} HUF</strong>).
                    </span>
                </div>
            </div>`;
    }
}

// ─── Table rendering ──────────────────────────────────────────────────────────
const NUM_COLS_IDX  = [6, 7, 8, 9, 11, 12, 13];
const NUM_COLS_XLSX = ['G','H','I','J','L','M','N'];

function renderTable(data) {
    tableBody.innerHTML = '';
    filterProblemOnly = false;

    if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="15" class="text-center py-4 text-muted">Nincs megjeleníthető adat</td></tr>';
        return;
    }

    renderDashboard(data);
    renderCorrectionTable(data);

    const tableSection = document.getElementById('tableSection');
    if (tableSection) tableSection.style.display = '';

    let positiveDiff = 0, negativeDiff = 0;
    let cntHelyes = 0, cntKerdezes = 0, cntNincs = 0;

    const fmt    = (n, d = 0) => fmtHU(n, d);
    const fmtPct = n => n == null ? '–' : fmtHU(n, 2) + '%';

    data.forEach(row => {
        const tr = document.createElement('tr');
        const lf = row.legalFeedback;

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

        let srcDateHtml = '–';
        if (row.matchingDate) {
            const offsetHtml = (row.dayDifference !== null && row.dayDifference !== 0)
                ? ` <small class="text-muted">(${row.dayDifference > 0 ? '+' : ''}${row.dayDifference}n)</small>`
                : '';
            srcDateHtml = row.matchingDate + offsetHtml;
        }

        const matchRateHtml = row.matchingRate
            ? `<strong>${fmt(row.matchingRate, 2)}</strong>${row.matchingGenerated ? '<sup class="text-danger ms-1" title="Hétvégi generált árfolyam">*</sup>' : ''}`
            : '<span class="text-danger">—</span>';

        const rateDeviation    = (row.matchingRate && row.excelEurRate) ? Math.abs(row.excelEurRate - row.matchingRate) : null;
        const invoiceRateClass = (rateDeviation !== null && rateDeviation >= 0.01) ? 'text-danger fw-bold' : '';

        const legalHtml = `<i class="bi ${lf.iconClass} me-1"></i><span class="legal-feedback">${lf.text}</span>`;

        tr.innerHTML = `
            <td>${row.invoiceNum || '–'}</td>
            <td>${row.invoiceOperation || '–'}</td>
            <td>${row.txTypeValue || '–'}</td>
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

    // Summary bar above table
    const existingInfo = document.querySelector('.generated-info');
    if (existingInfo) existingInfo.remove();

    const info = document.createElement('div');
    info.className = 'generated-info';
    info.innerHTML = `
        <div class="summary-stat">
            <span class="text-muted">Összes:</span>
            <strong>${data.length}</strong>
        </div>
        <div class="summary-divider"></div>
        <div class="summary-stat">
            <i class="bi bi-check-circle-fill text-success"></i>
            <span class="text-muted">Jogilag helyes:</span>
            <strong class="text-success">${cntHelyes}</strong>
        </div>
        <div class="summary-stat">
            <i class="bi bi-exclamation-triangle-fill text-warning"></i>
            <span class="text-muted">Kérdéses:</span>
            <strong class="text-warning">${cntKerdezes}</strong>
        </div>
        <div class="summary-stat">
            <i class="bi bi-x-circle-fill text-danger"></i>
            <span class="text-muted">Nincs egyezés:</span>
            <strong class="text-danger">${cntNincs}</strong>
        </div>
        <div class="ms-auto summary-stat">
            <span class="text-danger fw-semibold">▲ ${positiveDiff}</span>
            <span class="text-success fw-semibold ms-1">▼ ${negativeDiff}</span>
            <span class="text-muted ms-1">HUF-eltérés</span>
        </div>`;

    const tc = document.querySelector('.table-container');
    if (tc) tc.insertBefore(info, tc.firstChild);

    if (dataTable) dataTable.destroy();
    dataTable = $('#dataTable').DataTable({
        language: { url: 'https://cdn.datatables.net/plug-ins/1.13.6/i18n/hu.json' },
        dom: 'Bfrtip',
        buttons: [
            {
                text: '<i class="bi bi-funnel-fill me-1"></i>Csak problémás sorok',
                className: 'btn btn-outline-danger btn-sm',
                action: function(e, dt, node) {
                    filterProblemOnly = !filterProblemOnly;
                    $(node).toggleClass('btn-outline-danger btn-danger');
                    dt.draw();
                }
            },
            {
                extend: 'csv',
                text: '<i class="bi bi-filetype-csv me-1"></i>CSV',
                className: 'btn btn-ghost-secondary btn-sm btn-export btn-csv',
                bom: true,
                exportOptions: {
                    columns: ':visible',
                    format: { body: exportBodyFormatter }
                }
            },
            {
                extend: 'excelHtml5',
                text: '<i class="bi bi-file-earmark-excel me-1"></i>Excel',
                className: 'btn btn-ghost-secondary btn-sm btn-export btn-excel',
                title: 'MNB árfolyam ellenőrzés',
                exportOptions: {
                    columns: ':visible',
                    format: { body: exportBodyFormatter }
                },
                customize: function(xlsx) {
                    const sheet = xlsx.xl.worksheets['sheet1.xml'];
                    $('row', sheet).each(function() {
                        const r = parseInt($(this).attr('r'));
                        if (r <= 1) return;
                        NUM_COLS_XLSX.forEach(col => {
                            const cell = $('c[r="' + col + r + '"]', this);
                            if (!cell.length) return;
                            const numVal = parseFloat(cell.find('v').text());
                            if (!isNaN(numVal)) {
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
        order: [[12, 'desc']],
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

// ─── Export formatter ─────────────────────────────────────────────────────────
function exportBodyFormatter(data, row, column, node) {
    if (NUM_COLS_IDX.includes(column)) {
        const raw = node ? node.getAttribute('data-n') : null;
        let n = (raw !== null && raw !== '') ? parseFloat(raw) : NaN;
        if (isNaN(n)) {
            const text = String(data).replace(/<[^>]+>/g, '').trim();
            if (!text || text === '–' || text === '—') return '';
            n = parseFloat(text.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace('%', ''));
        }
        return isNaN(n) ? '' : n;
    }
    return String(data).replace(/<[^>]+>/g, '').trim();
}

// ─── State reset ──────────────────────────────────────────────────────────────
function resetState() {
    processedData     = [];
    rawExcelData      = null;
    filterProblemOnly = false;

    if (tableBody) tableBody.innerHTML = '';

    if (dataTable) { dataTable.destroy(); dataTable = null; }

    const els = [
        document.getElementById('auditDashboard'),
        document.getElementById('tableSection'),
        document.getElementById('correctionSection')
    ];
    els.forEach(el => { if (el) el.style.display = 'none'; });

    const infoBar = document.querySelector('.generated-info');
    if (infoBar) infoBar.remove();

    // Reset rate search result
    const rsr = document.getElementById('rateSearchResult');
    if (rsr) rsr.style.display = 'none';
}

// ─── Upload area events ───────────────────────────────────────────────────────
uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('dragging');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragging');
});

uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragging');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        selectedFile = files[0];
        fileInput.value = '';
        resetState();
        uploadArea.style.display = 'none';
        if (fileReadyBar) fileReadyBar.style.display = 'flex';
        if (selectedFileNameEl) selectedFileNameEl.textContent = selectedFile.name;
        loadConfig();
        processExcel(selectedFile);
    }
});

const btnProcess = document.getElementById('btn-process');

fileInput.addEventListener('change', e => {
    if (e.target.files.length > 0) {
        selectedFile = e.target.files[0];
        if (btnProcess) btnProcess.disabled = false;
        resetState();
        uploadArea.style.display = 'none';
        if (fileReadyBar) fileReadyBar.style.display = 'flex';
        if (selectedFileNameEl) selectedFileNameEl.textContent = selectedFile.name;
    }
});

if (btnProcess) {
    btnProcess.addEventListener('click', () => {
        if (selectedFile) { loadConfig(); processExcel(selectedFile); }
        else alert('Kérlek, előbb válassz ki egy fájlt!');
    });
}

const clearFileBtn = document.getElementById('clearFileBtn');
if (clearFileBtn) {
    clearFileBtn.addEventListener('click', () => {
        selectedFile = null;
        fileInput.value = '';
        if (btnProcess) btnProcess.disabled = true;
        resetState();
        uploadArea.style.display = '';
        if (fileReadyBar) fileReadyBar.style.display = 'none';
    });
}

// ─── Config panel toggle ──────────────────────────────────────────────────────
const configToggleBtn = document.getElementById('configToggleBtn');
const configSection   = document.getElementById('configSection');

if (configToggleBtn && configSection) {
    configToggleBtn.addEventListener('click', () => {
        const isVisible = configSection.style.display !== 'none';
        configSection.style.display = isVisible ? 'none' : 'block';
        configToggleBtn.classList.toggle('active', !isVisible);
    });
}
const configCloseBtn = document.getElementById('configCloseBtn');
if (configCloseBtn && configSection) {
    configCloseBtn.addEventListener('click', () => {
        configSection.style.display = 'none';
        if (configToggleBtn) configToggleBtn.classList.remove('active');
    });
}

// ─── Info panel toggle ────────────────────────────────────────────────────────
const infoToggleBtn = document.getElementById('infoToggleBtn');
const infoSection   = document.getElementById('infoSection');

if (infoToggleBtn && infoSection) {
    infoToggleBtn.addEventListener('click', () => {
        const isVisible = infoSection.style.display !== 'none';
        infoSection.style.display = isVisible ? 'none' : 'block';
        infoToggleBtn.classList.toggle('active', !isVisible);
    });
}
const infoCloseBtn = document.getElementById('infoCloseBtn');
if (infoCloseBtn && infoSection) {
    infoCloseBtn.addEventListener('click', () => {
        infoSection.style.display = 'none';
        if (infoToggleBtn) infoToggleBtn.classList.remove('active');
    });
}

// ─── Rate search section toggle ───────────────────────────────────────────────
const searchToggleBtn = document.getElementById('searchToggleBtn');
const searchSection   = document.getElementById('searchSection');

if (searchToggleBtn && searchSection) {
    searchToggleBtn.addEventListener('click', () => {
        const isVisible = searchSection.style.display !== 'none';
        searchSection.style.display = isVisible ? 'none' : 'block';
        searchToggleBtn.classList.toggle('active', !isVisible);
    });
}
const searchCloseBtn = document.getElementById('searchCloseBtn');
if (searchCloseBtn && searchSection) {
    searchCloseBtn.addEventListener('click', () => {
        searchSection.style.display = 'none';
        if (searchToggleBtn) searchToggleBtn.classList.remove('active');
    });
}

// Rate search button
const rateSearchBtn  = document.getElementById('rateSearchBtn');
const rateSearchDate = document.getElementById('rateSearchDate');
if (rateSearchBtn && rateSearchDate) {
    rateSearchBtn.addEventListener('click', () => {
        renderRateSearchResult(rateSearchDate.value);
    });
    rateSearchDate.addEventListener('keydown', e => {
        if (e.key === 'Enter') renderRateSearchResult(rateSearchDate.value);
    });
}

// ─── Correction table export ──────────────────────────────────────────────────
const exportCorrectionBtn = document.getElementById('exportCorrectionBtn');
if (exportCorrectionBtn) {
    exportCorrectionBtn.addEventListener('click', exportCorrectionToExcel);
}

// ─── Theme toggle ─────────────────────────────────────────────────────────────
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon      = document.getElementById('themeIcon');
if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const html   = document.documentElement;
        const isDark = html.getAttribute('data-bs-theme') === 'dark';
        html.setAttribute('data-bs-theme', isDark ? 'light' : 'dark');
        if (themeIcon) {
            themeIcon.className = isDark ? 'bi bi-moon-stars-fill' : 'bi bi-sun-fill';
        }
        themeToggleBtn.classList.toggle('active', !isDark);
    });
}

// ─── Excel processing ─────────────────────────────────────────────────────────
function processExcel(file) {
    resetState();
    showLoading();
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb       = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const sheet    = wb.Sheets[wb.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            rawExcelData   = jsonData;
            processedData  = processExcelData(jsonData, CONFIG.headerRow);
            if (processedData.length > 0) renderTable(processedData);
            else alert('Nincs feldolgozható adat az Excel fájlban!');
        } catch (err) {
            console.error(err);
            alert('Hiba: ' + err.message);
        } finally {
            hideLoading();
        }
    };
    reader.readAsArrayBuffer(file);
}

// ─── MNB info elements ────────────────────────────────────────────────────────
const availEl  = document.getElementById('availableRatesCount');
const updateEl = document.getElementById('updateMNB');
if (availEl)  availEl.textContent = MNB_RATES.data.length;
if (updateEl) {
    const ts = MNB_RATES.ts;
    updateEl.textContent = `${ts.slice(0,4)}.${ts.slice(4,6)}.${ts.slice(6,8)}. ${ts.slice(8,10)}:${ts.slice(10,12)}`;
}

loadConfig();

// Custom DataTables search filter for "Csak problémás sorok"
$.fn.dataTable.ext.search.push(function(settings, data, dataIndex) {
    if (!filterProblemOnly || !dataTable) return true;
    const rowNode = dataTable.row(dataIndex).node();
    return rowNode ? rowNode.getAttribute('data-legal-category') !== 'helyes' : true;
});

console.log('App inicializálva');
